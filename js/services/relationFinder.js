/**
 * relationFinder.js — Unified relation discovery engine (v3.1)
 *
 * COMPLETE RE-WORK of relation finding logic:
 * - Single unified API for all relation operations
 * - Shared logic between add-anime, refresh, and background sync
 * - Efficient batch processing with concurrency control
 * - Clear separation between discovery, resolution, and application
 *
 * Used by:
 * - addAnimePage.js (when adding new titles)
 * - settingsPage.js (refresh library)
 * - relationChecker.js (background discovery)
 * - focusPage.js (re-search)
 */

import { getState, getSeasonsArray } from '../state.js';
import { graphqlFetch } from '../api.js';
import { getAnimeById } from './jikanClient.js';
import { fetchFromAniList } from './episodeSyncService.js';
import { mergeRelationSeason, updateSeasonField } from './animeManager.js';
import { normalizeAndCommitLibrary } from './libraryStateService.js';
import { showToast } from '../utils.js';
import { addNotification } from './notificationSystem.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  MAX_GRAPH_DEPTH: 4,
  CACHE_TTL_MS: 30 * 60 * 1000, // 30 minutes
  BATCH_SIZE: 5,
  CONCURRENCY: 3,
  REQUEST_DELAY_MS: 350, // Rate limiting between requests
  HIGH_CONFIDENCE_THRESHOLD: 0.8,
  MEDIUM_CONFIDENCE_THRESHOLD: 0.5,
  ROOT_NAME_MATCH_BOOST: 0.15, // Confidence boost for root-name match
  SUGGESTION_THRESHOLD: 0.4, // Minimum confidence to show as suggestion
  AUTO_ADD_MIN_CONFIDENCE: 0.85, // Minimum for automatic addition
};

const RELATION_TYPES = {
  CHAIN_FORMING: new Set(['SEQUEL', 'PREQUEL', 'PARENT', 'CHILD']),
  DISCOVERY: new Set(['SEQUEL', 'PREQUEL', 'PARENT', 'CHILD', 'SIDE_STORY']),
  HIGH_CONFIDENCE: new Set(['SEQUEL', 'PREQUEL', 'CHILD', 'PARENT']),
};

const RELATION_PRIORITY = {
  PREQUEL: 100,
  SEQUEL: 90,
  PARENT: 80,
  CHILD: 70,
  SIDE_STORY: 40,
  ALTERNATIVE_VERSION: 30,
  SPIN_OFF: 20,
};

// ─── State ─────────────────────────────────────────────────────────────────────

const _cache = new Map();
const _pendingRequests = new Map();

// User suggestion queue - stores relations waiting for user confirmation
const _suggestionQueue = new Map();

// Processed relations tracking (to avoid duplicates)
const _processedRelations = new Set();

// ─── Debug ───────────────────────────────────────────────────────────────────

const DEBUG = true;
function log(level, message, data) {
  if (!DEBUG) return;
  const prefix = `[RelationFinder:${level}]`;
  if (data) console.log(prefix, message, data);
  else console.log(prefix, message);
}

// ─── Caching ─────────────────────────────────────────────────────────────────

function getCached(key) {
  const cached = _cache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CONFIG.CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return cached.data;
}

function setCached(key, data) {
  _cache.set(key, { data, timestamp: Date.now() });
}

function clearCache() {
  _cache.clear();
  _pendingRequests.clear();
  _suggestionQueue.clear();
  _processedRelations.clear();
}

// ─── Root Name Matching ──────────────────────────────────────────────────────

/**
 * Extract root name from anime title
 * Removes season indicators and common suffixes to get the base franchise name
 * @param {string} title - Anime title
 * @returns {string} Root name (lowercase, normalized)
 */
function extractRootName(title) {
  if (!title) return '';
  
  // Normalize: lowercase, remove special chars
  let root = title.toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // Replace special chars with space
    .replace(/\s+/g, ' ')       // Collapse multiple spaces
    .trim();
  
  // Remove common season indicators
  const seasonPatterns = [
    /\s+season\s*\d+/i,
    /\s+part\s*\d+/i,
    /\s+\d+nd?\s+season/i,
    /\s+\d+rd?\s+season/i,
    /\s+\d+th\s+season/i,
    /\s+ii+/i,
    /\s+2nd/i,
    /\s+3rd/i,
    /\s+\d+$/,
  ];
  
  for (const pattern of seasonPatterns) {
    root = root.replace(pattern, '');
  }
  
  return root.trim();
}

/**
 * Check if candidate title contains the root name
 * @param {string} candidateTitle - Title to check
 * @param {string} rootName - Root franchise name
 * @returns {boolean} True if candidate contains root name
 */
function containsRootName(candidateTitle, rootName) {
  if (!candidateTitle || !rootName) return false;
  
  const normalizedCandidate = candidateTitle.toLowerCase();
  const normalizedRoot = rootName.toLowerCase();
  
  // Direct containment check
  if (normalizedCandidate.includes(normalizedRoot)) return true;
  
  // Word-boundary check for partial matches
  const words = normalizedRoot.split(/\s+/);
  if (words.length >= 2) {
    // For multi-word roots, require at least 2/3 of words to match
    const matchCount = words.filter(word => 
      normalizedCandidate.includes(word) && word.length > 2
    ).length;
    return matchCount >= Math.ceil(words.length * 0.66);
  }
  
  return false;
}

/**
 * Calculate root-name match confidence boost
 * @param {string} candidateTitle - Title to evaluate
 * @param {string} sourceTitle - Source anime title
 * @returns {number} Confidence boost (0 to ROOT_NAME_MATCH_BOOST)
 */
function calculateRootNameBoost(candidateTitle, sourceTitle) {
  const rootName = extractRootName(sourceTitle);
  if (!rootName || rootName.length < 3) return 0;
  
  if (containsRootName(candidateTitle, rootName)) {
    log('debug', `Root-name match: "${candidateTitle}" contains "${rootName}"`);
    return CONFIG.ROOT_NAME_MATCH_BOOST;
  }
  
  return 0;
}

// ─── Core API: Relation Graph ────────────────────────────────────────────────

/**
 * Fetch relation graph from AniList for a single anime
 * @param {number} malId - MyAnimeList ID
 * @returns {Promise<Object>} Relation graph with nodes and edges
 */
async function fetchRelationGraph(malId) {
  const cacheKey = `graph-${malId}`;
  
  // Check cache
  const cached = getCached(cacheKey);
  if (cached) {
    log('debug', `Cache hit for graph ${malId}`);
    return cached;
  }
  
  // Check pending request (deduplication)
  if (_pendingRequests.has(cacheKey)) {
    log('debug', `Awaiting pending request for graph ${malId}`);
    return _pendingRequests.get(cacheKey);
  }
  
  const query = `
    query($id: Int) {
      Media(idMal: $id, type: ANIME) {
        id
        idMal
        title { romaji english native }
        relations {
          edges {
            relationType(version: 2)
            node {
              id
              idMal
              title { romaji english native }
              format
              status
              season
              seasonYear
              episodes
              startDate { year month day }
            }
          }
        }
      }
    }
  `;
  
  const promise = (async () => {
    try {
      const result = await graphqlFetch(query, { id: malId });
      const media = result?.data?.Media;
      
      if (!media) {
        log('warn', `No AniList data for MAL ${malId}`);
        return { nodes: new Map(), edges: new Map(), rootId: malId };
      }
      
      const graph = parseAniListRelations(media);
      setCached(cacheKey, graph);
      return graph;
    } catch (err) {
      log('error', `Failed to fetch graph for ${malId}:`, err.message);
      return { nodes: new Map(), edges: new Map(), rootId: malId };
    } finally {
      _pendingRequests.delete(cacheKey);
    }
  })();
  
  _pendingRequests.set(cacheKey, promise);
  return promise;
}

/**
 * Parse AniList relations into normalized graph format
 */
function parseAniListRelations(media) {
  const nodes = new Map();
  const edges = new Map();
  const rootId = Number(media.idMal);
  
  // Add root node
  nodes.set(rootId, {
    mal_id: rootId,
    anilist_id: media.id,
    title: media.title?.english || media.title?.romaji,
    native_title: media.title?.native,
    format: media.format,
    status: media.status,
    season: media.season,
    season_year: media.seasonYear,
    episodes: media.episodes,
    start_date: media.startDate,
    is_root: true,
  });
  
  // Parse relations
  const relations = media.relations?.edges || [];
  
  for (const edge of relations) {
    const type = edge.relationType;
    const node = edge.node;
    const targetMalId = Number(node?.idMal);
    
    if (!targetMalId || !RELATION_TYPES.DISCOVERY.has(type)) continue;
    
    // Add target node
    if (!nodes.has(targetMalId)) {
      nodes.set(targetMalId, {
        mal_id: targetMalId,
        anilist_id: node.id,
        title: node.title?.english || node.title?.romaji,
        native_title: node.title?.native,
        format: node.format,
        status: node.status,
        season: node.season,
        season_year: node.seasonYear,
        episodes: node.episodes,
        start_date: node.startDate,
        is_movie: node.format === 'MOVIE',
        is_ova: node.format === 'OVA',
        is_special: node.format === 'SPECIAL',
      });
    }
    
    // Add edge
    if (!edges.has(rootId)) edges.set(rootId, []);
    edges.get(rootId).push({
      targetId: targetMalId,
      relationType: type,
      priority: RELATION_PRIORITY[type] || 0,
    });
  }
  
  return { nodes, edges, rootId };
}

// ─── Core API: Season Discovery ─────────────────────────────────────────────

/**
 * Calculate confidence score for a relation
 * Evaluation order per requirements:
 * 1. Official franchise relation graph (chain-forming types)
 * 2. Root-name match inside title
 * 3. Season and season-year validation
 * 4. Title-pattern fallback
 * 
 * @param {Object} relation - Edge with target node
 * @param {Object} sourceNode - Source anime data
 * @param {string} sourceTitle - Original source title for root-name matching
 * @returns {Object} { confidence: number, requiresConfirmation: boolean, detectionSource: string }
 */
function calculateConfidence(relation, sourceNode, sourceTitle) {
  const priority = relation.priority || 0;
  let confidence = priority / 100;
  let detectionSource = 'relation_graph'; // Default: official API relation
  let requiresConfirmation = false;
  
  // 1. Boost for chain-forming types (official franchise relation graph)
  if (RELATION_TYPES.CHAIN_FORMING.has(relation.relationType)) {
    confidence = Math.max(confidence, 0.95);
    log('debug', `Chain-forming type ${relation.relationType} detected from official graph`);
  }
  
  // 2. Root-name match inside title
  if (sourceTitle && relation.targetNode?.title) {
    const rootNameBoost = calculateRootNameBoost(relation.targetNode.title, sourceTitle);
    if (rootNameBoost > 0) {
      confidence += rootNameBoost;
      // If no official relation but root-name matches, mark as root-name detection
      if (!RELATION_TYPES.CHAIN_FORMING.has(relation.relationType)) {
        detectionSource = 'root_name_match';
        requiresConfirmation = true; // Root-name matches require user confirmation
        log('info', `Root-name match detected: "${relation.targetNode.title}" contains franchise root`);
      }
    }
  }
  
  // 3. Season and season-year validation
  const sourceYear = sourceNode?.season_year || sourceNode?.start_date?.year;
  const targetYear = relation.targetNode?.season_year || relation.targetNode?.start_date?.year;
  
  if (sourceYear && targetYear) {
    const yearDiff = targetYear - sourceYear;
    
    if (relation.relationType === 'SEQUEL' && yearDiff < 0) {
      confidence *= 0.7; // Penalty: sequel claims earlier year
      log('debug', 'SEQUEL year mismatch penalty');
    } else if (relation.relationType === 'PREQUEL' && yearDiff > 0) {
      confidence *= 0.7; // Penalty: prequel claims later year
      log('debug', 'PREQUEL year mismatch penalty');
    } else if (Math.abs(yearDiff) <= 5) {
      confidence = Math.min(confidence * 1.05, 1.0);
    }
  }
  
  // 4. Format penalty for supplemental types claiming main chain
  if (relation.targetNode?.is_movie || relation.targetNode?.is_ova) {
    if (relation.relationType === 'SEQUEL' || relation.relationType === 'PREQUEL') {
      confidence *= 0.85;
    }
  }
  
  // Determine if confirmation is required
  const finalConfidence = Math.min(Math.max(confidence, 0), 1);
  
  // Require confirmation if:
  // - Confidence is below auto-add threshold but above suggestion threshold
  // - Detection came from root-name matching without strong relation data
  // - Not a high-confidence official relation
  if (finalConfidence < CONFIG.AUTO_ADD_MIN_CONFIDENCE) {
    requiresConfirmation = true;
  }
  
  // Mark as suggestion-only if confidence is too low even for confirmation
  if (finalConfidence < CONFIG.SUGGESTION_THRESHOLD) {
    detectionSource = 'title_pattern_fallback';
  }
  
  return { 
    confidence: finalConfidence, 
    requiresConfirmation,
    detectionSource,
  };
}

/**
 * Discover related seasons for an anime
 * @param {Object} anime - Library anime entry
 * @param {Object} options
 * @returns {Promise<Object>} Discovery result
 */
export async function discoverRelatedSeasons(anime, options = {}) {
  const malId = Number(anime.selected_season_mal_id || anime.root_mal_id);
  const title = anime.title_english || anime.title_japanese || 'Unknown';
  
  log('info', `Discovering seasons for: ${title} (${malId})`);
  
  try {
    // Fetch relation graph
    const graph = await fetchRelationGraph(malId);
    
    if (graph.nodes.size <= 1) {
      log('info', 'No related seasons found');
      return {
        prequels: [],
        sequels: [],
        related: [],
        all: [],
        confidence: 1.0,
      };
    }
    
    // Get existing IDs to filter out
    const existingIds = new Set([
      ...Object.keys(anime.seasons || {}).map(Number),
      malId,
    ]);
    
    // Build relation list with confidence scores
    const relations = [];
    const sourceNode = graph.nodes.get(malId);
    
    for (const [sourceId, edges] of graph.edges.entries()) {
      if (sourceId !== malId) continue;
      
      for (const edge of edges) {
        const targetNode = graph.nodes.get(edge.targetId);
        if (!targetNode) continue;
        
        const confidence = calculateConfidence(
          { ...edge, targetNode },
          sourceNode
        );
        
        relations.push({
          mal_id: edge.targetId,
          relationType: edge.relationType,
          node: targetNode,
          confidence,
          isPrequel: edge.relationType === 'PREQUEL',
          isSequel: edge.relationType === 'SEQUEL',
          isNew: !existingIds.has(edge.targetId),
        });
      }
    }
    
    // Sort by priority and confidence
    relations.sort((a, b) => b.confidence - a.confidence);
    
    // Categorize
    const prequels = relations.filter(r => r.isPrequel && r.isNew);
    const sequels = relations.filter(r => r.isSequel && r.isNew);
    const related = relations.filter(r => !r.isPrequel && !r.isSequel && r.isNew);
    
    // Calculate overall confidence
    const avgConfidence = relations.length > 0
      ? relations.reduce((sum, r) => sum + r.confidence, 0) / relations.length
      : 1.0;
    
    log('info', `Found ${prequels.length} prequels, ${sequels.length} sequels, ${related.length} related`, {
      avgConfidence: avgConfidence.toFixed(2),
    });
    
    return {
      prequels,
      sequels,
      related,
      all: relations,
      confidence: avgConfidence,
      graph,
    };
    
  } catch (err) {
    log('error', `Discovery failed:`, err.message);
    return {
      prequels: [],
      sequels: [],
      related: [],
      all: [],
      confidence: 0,
      error: err.message,
    };
  }
}

// ─── Core API: Batch Operations ──────────────────────────────────────────────

/**
 * Batch discover seasons for multiple anime
 * @param {Array} animeList - Array of anime entries
 * @param {Object} options
 * @returns {Promise<Map>} Results by rootId
 */
export async function batchDiscoverSeasons(animeList, options = {}) {
  const results = new Map();
  const { onProgress } = options;
  
  log('info', `Batch discovering seasons for ${animeList.length} anime`);
  
  // Process with concurrency control
  const queue = [...animeList];
  const inProgress = new Set();
  let completed = 0;
  
  while (queue.length > 0 || inProgress.size > 0) {
    // Start new tasks up to concurrency limit
    while (inProgress.size < CONFIG.CONCURRENCY && queue.length > 0) {
      const anime = queue.shift();
      const promise = discoverRelatedSeasons(anime, options)
        .then(result => {
          results.set(anime.root_mal_id, { anime, result });
          completed++;
          if (onProgress) {
            onProgress({ completed, total: animeList.length, current: anime.title_english });
          }
        })
        .catch(err => {
          log('error', `Batch discovery failed for ${anime.root_mal_id}:`, err);
          completed++;
        })
        .finally(() => {
          inProgress.delete(promise);
        });
      
      inProgress.add(promise);
      
      // Rate limiting delay
      if (queue.length > 0) {
        await delay(CONFIG.REQUEST_DELAY_MS);
      }
    }
    
    // Wait for at least one to complete
    if (inProgress.size > 0) {
      await Promise.race(inProgress);
    }
  }
  
  log('info', `Batch discovery complete: ${results.size} results`);
  return results;
}

// ─── Core API: Auto-Add Seasons ──────────────────────────────────────────────

/**
 * Auto-add discovered seasons to library
 * @param {Object} anime - Parent anime
 * @param {Object} discovery - Result from discoverRelatedSeasons
 * @param {Object} options
 * @returns {Promise<Object>} Add result
 */
export async function autoAddDiscoveredSeasons(anime, discovery, options = {}) {
  const { includePrequels = true, includeRelated = false } = options;
  
  const toAdd = [
    ...discovery.sequels.filter(s => s.confidence >= CONFIG.HIGH_CONFIDENCE_THRESHOLD),
    ...(includePrequels ? discovery.prequels.filter(s => s.confidence >= CONFIG.HIGH_CONFIDENCE_THRESHOLD) : []),
    ...(includeRelated ? discovery.related.filter(s => s.confidence >= CONFIG.HIGH_CONFIDENCE_THRESHOLD) : []),
  ];
  
  log('info', `Auto-adding ${toAdd.length} high-confidence seasons`);
  
  const added = [];
  const failed = [];
  
  for (const item of toAdd) {
    try {
      // Fetch full data from Jikan
      const jikanData = await getAnimeById(item.mal_id);
      
      if (!jikanData) {
        failed.push({ item, reason: 'No Jikan data' });
        continue;
      }
      
      // Add as season to existing entry
      await mergeRelationSeason(anime.root_mal_id, jikanData);
      
      added.push({
        mal_id: item.mal_id,
        title: jikanData.title,
        relationType: item.relationType,
      });
      
      // Notify
      addNotification({
        type: 'new_season',
        title: 'New Season Added',
        message: `${jikanData.title} added to ${anime.title_english || anime.title_japanese}`,
        animeId: anime.root_mal_id,
      });
      
    } catch (err) {
      log('error', `Failed to add season ${item.mal_id}:`, err.message);
      failed.push({ item, reason: err.message });
    }
    
    // Rate limiting
    await delay(CONFIG.REQUEST_DELAY_MS);
  }
  
  return { added, failed, totalAttempted: toAdd.length };
}

// ─── Core API: Library Refresh ─────────────────────────────────────────────────

/**
 * Unified library refresh - same logic as adding new titles
 * @param {Array} library - Full library or subset to refresh
 * @param {Object} options
 * @returns {Promise<Object>} Refresh results
 */
export async function refreshLibraryRelations(library, options = {}) {
  const { 
    onProgress,
    autoAdd = true,
    includePrequels = true,
  } = options;
  
  const targetLibrary = Array.isArray(library) ? library : (getState('library') || []);
  
  log('info', `Starting unified library refresh for ${targetLibrary.length} titles`);
  
  const results = {
    processed: 0,
    seasonsFound: 0,
    autoAdded: 0,
    suggestions: [],
    errors: [],
  };
  
  // Batch discover all
  const discoveries = await batchDiscoverSeasons(targetLibrary, {
    onProgress: ({ completed, total, current }) => {
      if (onProgress) {
        onProgress({
          stage: 'discovering',
          completed,
          total,
          current,
          percent: Math.round((completed / total) * 100),
        });
      }
    },
  });
  
  // Process discoveries
  let processedCount = 0;
  for (const [rootId, { anime, result }] of discoveries.entries()) {
    processedCount++;
    
    if (result.error) {
      results.errors.push({ rootId, error: result.error });
      continue;
    }
    
    const newSeasons = [...result.prequels, ...result.sequels, ...result.related];
    results.seasonsFound += newSeasons.length;
    
    // Auto-add high-confidence seasons
    if (autoAdd && newSeasons.length > 0) {
      try {
        const addResult = await autoAddDiscoveredSeasons(anime, result, { includePrequels });
        results.autoAdded += addResult.added.length;
        
        // Collect suggestions (lower confidence)
        const lowConfidence = newSeasons.filter(s => 
          s.confidence >= CONFIG.MEDIUM_CONFIDENCE_THRESHOLD && 
          s.confidence < CONFIG.HIGH_CONFIDENCE_THRESHOLD
        );
        
        for (const suggestion of lowConfidence) {
          results.suggestions.push({
            rootId,
            mal_id: suggestion.mal_id,
            title: suggestion.node?.title,
            relationType: suggestion.relationType,
            confidence: suggestion.confidence,
          });
        }
        
        if (onProgress) {
          onProgress({
            stage: 'adding',
            completed: processedCount,
            total: discoveries.size,
            added: addResult.added.length,
            percent: Math.round((processedCount / discoveries.size) * 100),
          });
        }
      } catch (err) {
        log('error', `Auto-add failed for ${rootId}:`, err.message);
        results.errors.push({ rootId, error: err.message });
      }
    }
    
    // Rate limiting between anime
    await delay(CONFIG.REQUEST_DELAY_MS);
  }
  
  results.processed = discoveries.size;
  
  log('info', `Library refresh complete:`, {
    processed: results.processed,
    seasonsFound: results.seasonsFound,
    autoAdded: results.autoAdded,
    suggestions: results.suggestions.length,
    errors: results.errors.length,
  });
  
  return results;
}

// ─── Core API: Quick Check ───────────────────────────────────────────────────

/**
 * Quick check for new seasons on a single anime
 * Used by relationChecker for background scanning
 * @param {Object} anime - Anime entry
 * @returns {Promise<boolean>} True if new seasons were found/added
 */
export async function quickSeasonCheck(anime) {
  const discovery = await discoverRelatedSeasons(anime);
  
  if (discovery.all.length === 0) return false;
  
  const newSeasons = discovery.all.filter(s => s.isNew && s.confidence >= CONFIG.HIGH_CONFIDENCE_THRESHOLD);
  
  if (newSeasons.length === 0) return false;
  
  const result = await autoAddDiscoveredSeasons(anime, discovery, { includePrequels: false });
  
  return result.added.length > 0;
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Suggestion Queue API ────────────────────────────────────────────────────

/**
 * Add a relation to the user suggestion queue
 * @param {Object} anime - Source anime
 * @param {Object} relation - Detected relation
 * @param {Object} confidenceResult - From calculateConfidence
 */
export function queueRelationSuggestion(anime, relation, confidenceResult) {
  const key = `${anime.root_mal_id}-${relation.mal_id}`;
  
  if (_processedRelations.has(key)) {
    log('debug', `Relation ${key} already processed, skipping`);
    return false;
  }
  
  const suggestion = {
    id: key,
    rootId: anime.root_mal_id,
    rootTitle: anime.title_english || anime.title_japanese,
    candidateMalId: relation.mal_id,
    candidateTitle: relation.node?.title || relation.title,
    relationType: relation.relationType,
    confidence: confidenceResult.confidence,
    detectionSource: confidenceResult.detectionSource,
    requiresConfirmation: confidenceResult.requiresConfirmation,
    timestamp: Date.now(),
    status: 'pending', // pending, accepted, rejected
  };
  
  _suggestionQueue.set(key, suggestion);
  
  log('info', `Queued suggestion: ${suggestion.candidateTitle} → ${suggestion.rootTitle}`, {
    confidence: suggestion.confidence.toFixed(2),
    source: suggestion.detectionSource,
    requiresConfirmation: suggestion.requiresConfirmation,
  });
  
  return true;
}

/**
 * Get all pending suggestions for a root anime
 * @param {number} rootId - Anime root ID
 * @returns {Array} Pending suggestions
 */
export function getPendingSuggestions(rootId) {
  const suggestions = [];
  for (const suggestion of _suggestionQueue.values()) {
    if (suggestion.rootId === rootId && suggestion.status === 'pending') {
      suggestions.push(suggestion);
    }
  }
  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Get all pending suggestions in the queue
 * @returns {Array} All pending suggestions
 */
export function getAllPendingSuggestions() {
  const suggestions = [];
  for (const suggestion of _suggestionQueue.values()) {
    if (suggestion.status === 'pending') {
      suggestions.push(suggestion);
    }
  }
  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Accept a suggestion and add the relation
 * @param {string} suggestionId - Suggestion ID
 * @returns {Promise<boolean>} Success status
 */
export async function acceptSuggestion(suggestionId) {
  const suggestion = _suggestionQueue.get(suggestionId);
  if (!suggestion || suggestion.status !== 'pending') {
    log('warn', `Cannot accept suggestion ${suggestionId}: not found or not pending`);
    return false;
  }
  
  try {
    // Fetch full data from Jikan
    const jikanData = await getAnimeById(suggestion.candidateMalId);
    if (!jikanData) {
      throw new Error('No Jikan data available');
    }
    
    // Add as season to the franchise
    await mergeRelationSeason(suggestion.rootId, jikanData);
    
    // Mark as processed
    suggestion.status = 'accepted';
    _processedRelations.add(suggestionId);
    
    log('info', `Accepted suggestion: ${suggestion.candidateTitle} added to ${suggestion.rootTitle}`);
    
    addNotification({
      type: 'relation_accepted',
      title: 'Relation Added',
      message: `${suggestion.candidateTitle} added as ${suggestion.relationType.toLowerCase()}`,
      animeId: suggestion.rootId,
    });
    
    return true;
  } catch (err) {
    log('error', `Failed to accept suggestion ${suggestionId}:`, err.message);
    return false;
  }
}

/**
 * Reject a suggestion
 * @param {string} suggestionId - Suggestion ID
 */
export function rejectSuggestion(suggestionId) {
  const suggestion = _suggestionQueue.get(suggestionId);
  if (!suggestion) return false;
  
  suggestion.status = 'rejected';
  _processedRelations.add(suggestionId);
  
  log('info', `Rejected suggestion: ${suggestion.candidateTitle}`);
  return true;
}

/**
 * Clear all suggestions from the queue
 */
function clearSuggestionQueue() {
  _suggestionQueue.clear();
  log('info', 'Suggestion queue cleared');
}

// ─── 24-Hour Updater Integration ───────────────────────────────────────────────

/**
 * Shared 24-hour updater logic - uses same relation engine
 * Behavior:
 * - High confidence (≥ AUTO_ADD_MIN_CONFIDENCE): Auto-add
 * - Medium confidence (≥ SUGGESTION_THRESHOLD): Queue for user confirmation
 * - Low confidence (< SUGGESTION_THRESHOLD): Log but skip
 * 
 * @param {Array} library - Library to check
 * @param {Object} options
 * @returns {Promise<Object>} Update results
 */
export async function runDailyRelationCheck(library, options = {}) {
  const { 
    onProgress,
    dryRun = false, // If true, don't actually add anything
  } = options;
  
  log('info', `[24h Updater] Starting daily relation check for ${library.length} titles`);
  
  const results = {
    processed: 0,
    autoAdded: 0,
    queued: 0,
    skipped: 0,
    errors: [],
    summary: {
      confirmed: [],
      suggestions: [],
      skipped: [],
    },
  };
  
  // Batch discover all
  const discoveries = await batchDiscoverSeasons(library, {
    onProgress: ({ completed, total, current }) => {
      if (onProgress) {
        onProgress({
          stage: 'discovering',
          completed,
          total,
          current,
          percent: Math.round((completed / total) * 100),
        });
      }
    },
  });
  
  // Process discoveries
  for (const [rootId, { anime, result }] of discoveries.entries()) {
    results.processed++;
    
    if (result.error) {
      results.errors.push({ rootId, error: result.error });
      results.summary.skipped.push({
        rootId,
        title: anime.title_english,
        reason: 'discovery_error',
      });
      continue;
    }
    
    const newSeasons = result.all?.filter(s => s.isNew) || [];
    
    for (const season of newSeasons) {
      const confidenceResult = calculateConfidence(
        season,
        result.graph?.nodes?.get(rootId),
        anime.title_english || anime.title_japanese
      );
      
      // Decision logic based on confidence
      if (confidenceResult.confidence >= CONFIG.AUTO_ADD_MIN_CONFIDENCE) {
        // High confidence: Auto-add
        if (!dryRun) {
          try {
            await autoAddSingleSeason(anime, season, confidenceResult);
            results.autoAdded++;
            results.summary.confirmed.push({
              rootId,
              title: anime.title_english,
              candidate: season.node?.title,
              confidence: confidenceResult.confidence,
              source: confidenceResult.detectionSource,
            });
          } catch (err) {
            results.errors.push({ rootId, malId: season.mal_id, error: err.message });
          }
        } else {
          results.autoAdded++; // Count for dry-run
        }
      } else if (confidenceResult.confidence >= CONFIG.SUGGESTION_THRESHOLD) {
        // Medium confidence: Queue for user confirmation
        if (!dryRun) {
          const queued = queueRelationSuggestion(anime, season, confidenceResult);
          if (queued) {
            results.queued++;
            results.summary.suggestions.push({
              rootId,
              title: anime.title_english,
              candidate: season.node?.title,
              confidence: confidenceResult.confidence,
              source: confidenceResult.detectionSource,
              suggestionId: `${rootId}-${season.mal_id}`,
            });
          }
        } else {
          results.queued++; // Count for dry-run
        }
      } else {
        // Low confidence: Skip
        results.skipped++;
        results.summary.skipped.push({
          rootId,
          title: anime.title_english,
          candidate: season.node?.title,
          confidence: confidenceResult.confidence,
          reason: 'low_confidence',
        });
      }
    }
    
    if (onProgress) {
      onProgress({
        stage: 'processing',
        completed: results.processed,
        total: discoveries.size,
        autoAdded: results.autoAdded,
        queued: results.queued,
        skipped: results.skipped,
        percent: Math.round((results.processed / discoveries.size) * 100),
      });
    }
  }
  
  log('info', `[24h Updater] Complete:`, {
    processed: results.processed,
    autoAdded: results.autoAdded,
    queued: results.queued,
    skipped: results.skipped,
    errors: results.errors.length,
  });
  
  return results;
}

/**
 * Auto-add a single season (helper for 24h updater)
 * @param {Object} anime - Source anime
 * @param {Object} season - Season to add
 * @param {Object} confidenceResult - Confidence info
 */
async function autoAddSingleSeason(anime, season, confidenceResult) {
  // Fetch full data from Jikan
  const jikanData = await getAnimeById(season.mal_id);
  if (!jikanData) {
    throw new Error('No Jikan data available');
  }
  
  // Add as season
  await mergeRelationSeason(anime.root_mal_id, jikanData);
  
  // Notify
  addNotification({
    type: 'season_auto_added',
    title: 'New Season Found',
    message: `${jikanData.title} added as ${season.relationType.toLowerCase()} to ${anime.title_english}`,
    animeId: anime.root_mal_id,
  });
  
  log('info', `[24h Updater] Auto-added: ${jikanData.title}`, {
    confidence: confidenceResult.confidence,
    source: confidenceResult.detectionSource,
  });
}

// ─── Debug & Verification ────────────────────────────────────────────────────

/**
 * Get detailed status for debugging
 * @returns {Object} Current state
 */
export function getDebugStatus() {
  return {
    cacheSize: _cache.size,
    pendingRequests: _pendingRequests.size,
    suggestionQueueSize: _suggestionQueue.size,
    processedRelationsCount: _processedRelations.size,
    config: CONFIG,
  };
}

/**
 * Log detailed relation check for debugging
 * @param {string} operation - Operation name
 * @param {Object} data - Debug data
 */
export function logRelationCheck(operation, data) {
  log('debug', `[${operation}]`, {
    ...data,
    timestamp: new Date().toISOString(),
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export { clearCache, clearSuggestionQueue, CONFIG, RELATION_TYPES };
