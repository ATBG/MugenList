/**
 * relationEngine.js — Unified franchise relation engine (v2)
 *
 * COMPREHENSIVE OVERHAUL: Prequel and Sequel Detection Logic
 *
 * Core principles:
 * 1. Official relation graph from API metadata is PRIMARY source of truth
 * 2. ONE canonical root per franchise - never duplicate
 * 3. Proper season chain ordering: prequels → root → sequels
 * 4. Confidence-based matching with clear priority rules
 * 5. Shared logic across all features (add, re-search, sync, recommendations)
 *
 * Powers:
 * - Auto sequel/prequel detection when adding anime
 * - Manual re-search for new seasons in Focus view
 * - Daily new episode detection
 * - Franchise resolution with proper root selection
 * - Recommendation ranking with franchise awareness
 *
 * No separate logic paths. No duplicated rules. Maximum precision.
 */

import { getState, getSeasonsArray } from '../state.js';
import {
  buildRelationCluster,
  resolveFranchise,
  applyResolvedFranchisePatch,
} from './franchiseService.js';
import { getAnimeById as fetchJikanAnime, normalizeSeasonStatus } from './jikanClient.js';
import { fetchFromAniList } from './episodeSyncService.js';
import { mergeRelationSeason, updateSeasonField } from './animeManager.js';
import { normalizeAndCommitLibrary } from './libraryStateService.js';
import { addNotification } from './notificationSystem.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const RELATION_TYPES = new Set([
  'SEQUEL',
  'PREQUEL',
  'SIDE_STORY',
  'PARENT',
  'CHILD',
  'ALTERNATIVE_VERSION',
  'ALTERNATIVE_SETTING',
  'SPIN_OFF',
  'ADAPTATION',
  'SUMMARY',
  'CHARACTER',
]);

/** 
 * Relation priority for franchise chain building.
 * Higher number = higher priority for main chain inclusion.
 */
const RELATION_PRIORITY = {
  'PREQUEL': 100,           // Highest - connects to earlier content
  'SEQUEL': 90,             // High - connects to later content
  'PARENT': 80,             // High - parent franchise
  'CHILD': 70,              // Medium-high - child franchise
  'SIDE_STORY': 40,         // Medium - related but parallel
  'ALTERNATIVE_VERSION': 30, // Low - alternate telling
  'ALTERNATIVE_SETTING': 25, // Low - same universe, different setting
  'SPIN_OFF': 20,           // Low - derived work
  'ADAPTATION': 10,         // Lowest - different medium
  'SUMMARY': 5,             // Very low - recap
  'CHARACTER': 0,           // Ignore for chain
};

/** 
 * Relation types that form the MAIN franchise chain.
 * These determine root selection and season ordering.
 */
const CHAIN_FORMING_TYPES = new Set([
  'SEQUEL',
  'PREQUEL',
  'PARENT',
  'CHILD',
]);

/** 
 * Relation types for season discovery (auto-add candidates).
 * More permissive than chain-forming types.
 */
const SEASON_DISCOVERY_TYPES = new Set([
  'SEQUEL',
  'PREQUEL',
  'PARENT',
  'CHILD',
  'SIDE_STORY',
]);

/** 
 * High-confidence types that can be auto-added without user confirmation.
 * Must have official API relation data.
 */
const HIGH_CONFIDENCE_TYPES = new Set([
  'SEQUEL',
  'PREQUEL',
  'CHILD',
  'PARENT',
]);

/** Confidence thresholds */
const CONFIDENCE = {
  CERTAIN: 1.0,      // Official API relation confirmed
  HIGH: 0.8,         // Strong relation + metadata match
  MEDIUM: 0.5,       // Relation exists but ambiguous
  LOW: 0.3,          // Weak indicators only
  GUESS: 0.1,        // Title pattern match only
};

/** Timing constants */
const DEFAULT_MAX_DEPTH = 4;
const DAILY_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EPISODE_STALE_MS = 24 * 60 * 60 * 1000;
const DAILY_SYNC_BATCH_SIZE = 5;
const NOTIFICATION_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHAIN_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Debug Logging ───────────────────────────────────────────────────────────

const DEBUG = true;

function log(level, component, message, data = null) {
  if (!DEBUG) return;
  const prefix = `[RELATION:${level}:${component}]`;
  if (data) {
    console.log(prefix, message, data);
  } else {
    console.log(prefix, message);
  }
}

// ─── Caching ─────────────────────────────────────────────────────────────────

/** 
 * Franchise chain cache - prevents recomputation
 * Key: franchise_id or root_mal_id
 * Value: { chain, timestamp, version }
 */
const _chainCache = new Map();

function getCachedChain(key) {
  const cached = _chainCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CHAIN_CACHE_TTL_MS) {
    _chainCache.delete(key);
    return null;
  }
  return cached.chain;
}

function setCachedChain(key, chain) {
  _chainCache.set(key, {
    chain,
    timestamp: Date.now(),
    version: 2,
  });
}

function invalidateChainCache(key) {
  if (key) {
    _chainCache.delete(key);
  } else {
    _chainCache.clear();
  }
}

// ─── Background timers ───────────────────────────────────────────────────────

let _dailySyncTimer = null;
let _dailySyncStartupTimer = null;
let _isDailySyncRunning = false;

// Notification dedup: key → timestamp
const _episodeNotifiedAt = new Map();

// ─── Shared Core Functions ───────────────────────────────────────────────────

/**
 * Re-export resolveFranchise so all consumers import from the engine.
 */
export { resolveFranchise };

/**
 * Fetch the full relation graph for an anime via AniList.
 * Returns a flat list of related entries plus the raw cluster for advanced use.
 *
 * @param {Object} anime - Library anime entry
 * @param {Object} [options]
 * @param {number} [options.maxDepth] - Graph traversal depth (default 4)
 * @returns {Promise<{relations: Array, cluster: Object}>}
 */
export async function getAllRelations(anime, options = {}) {
  const seedId = Number(anime.selected_season_mal_id || anime.root_mal_id);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const cluster = await buildRelationCluster(seedId, { maxDepth });

  const relations = [];
  for (const [sourceId, edges] of cluster.edges.entries()) {
    for (const edge of edges) {
      const targetNode = cluster.nodes.get(Number(edge.targetId));
      if (!targetNode) continue;
      relations.push({
        source_mal_id: Number(sourceId),
        mal_id: Number(edge.targetId),
        relationType: edge.relationType,
        node: targetNode,
      });
    }
  }

  return { relations, cluster };
}

/**
 * Filter relations to only valid types.
 *
 * @param {Array} relations - Output from getAllRelations
 * @param {Object} [options]
 * @param {Set|Array} [options.types] - Allowed relation types (default SEASON_DISCOVERY_TYPES)
 * @returns {Array}
 */
export function filterValidRelations(relations, options = {}) {
  const allowed = options.types || SEASON_DISCOVERY_TYPES;
  const typeSet = allowed instanceof Set ? allowed : new Set(allowed);
  return relations.filter((rel) => typeSet.has(rel.relationType));
}

/**
 * Detect which related entries are missing from the existing seasons.
 *
 * @param {Array} relations - Filtered relations
 * @param {Object} existingSeasons - anime.seasons object
 * @param {Array} [library] - Full library to avoid duplicate roots
 * @returns {Array} - Relations not yet present
 */
export function detectNewSeasons(relations, existingSeasons, library = []) {
  const existingIds = new Set(Object.keys(existingSeasons || {}).map(Number));
  const libraryRootIds = new Set((library || []).map((a) => Number(a.root_mal_id)));

  return relations.filter((rel) => {
    const malId = Number(rel.mal_id);
    return !existingIds.has(malId) && !libraryRootIds.has(malId);
  });
}

/**
 * Normalize a relation node into season-entry-compatible data.
 *
 * @param {Object} relationNode - A single relation from getAllRelations
 * @returns {Object} Normalized season data
 */
export function normalizeSeasonData(relationNode) {
  const node = relationNode.node || relationNode;
  return {
    mal_id: Number(node.mal_id),
    title_english: node.title || 'Unknown',
    title_japanese: node.native_title || '',
    total_episodes: Number(node.episodes || 0),
    format: node.format || 'TV',
    status: node.status || 'Unknown',
    airing: node.is_airing || false,
    is_airing: node.is_airing || false,
    is_movie: node.is_movie || false,
    is_ova: node.is_ova || false,
    is_special: node.is_special || false,
    anilist_id: node.anilist_id || null,
    aired_at: node.aired_at || null,
    next_episode_airing_at: node.next_episode_airtime || null,
    next_episode_number: node.next_episode_number || null,
    relationType: relationNode.relationType || node.relationType || null,
  };
}

// ─── Franchise Chain Resolution (CORE OVERHAUL) ──────────────────────────────

/**
 * Calculate confidence score for a relation.
 * Higher score = more certain this relation is valid for franchise chain.
 *
 * Priority:
 * 1. Official API relation type (SEQUEL/PREQUEL = highest)
 * 2. Season/year metadata consistency
 * 3. Title pattern matching (fallback only)
 *
 * @param {Object} relation - Relation object with relationType and node
 * @param {Object} sourceAnime - The anime this relation originates from
 * @returns {number} Confidence score 0-1
 */
export function calculateRelationConfidence(relation, sourceAnime) {
  const type = relation.relationType;
  const node = relation.node || {};

  log('debug', 'CONFIDENCE', `Calculating confidence for ${type} relation to ${node.title || node.mal_id}`);

  // Base confidence from relation type priority
  const priority = RELATION_PRIORITY[type] || 0;
  let confidence = priority / 100; // Normalize to 0-1

  // Boost for chain-forming types with official API confirmation
  if (CHAIN_FORMING_TYPES.has(type) && relation.fromApi !== false) {
    confidence = Math.max(confidence, CONFIDENCE.CERTAIN);
    log('debug', 'CONFIDENCE', `Chain-forming type ${type} -> CERTAIN`);
  }

  // Adjust based on metadata consistency
  const sourceYear = sourceAnime.year || sourceAnime.season_year;
  const targetYear = node.year || node.season_year;

  if (sourceYear && targetYear) {
    const yearDiff = targetYear - sourceYear;

    // For SEQUEL: target should be later or same year
    if (type === 'SEQUEL' && yearDiff < 0) {
      confidence *= 0.7; // Penalty: sequel claims to be earlier
      log('debug', 'CONFIDENCE', 'SEQUEL year mismatch penalty');
    }

    // For PREQUEL: target should be earlier or same year
    if (type === 'PREQUEL' && yearDiff > 0) {
      confidence *= 0.7; // Penalty: prequel claims to be later
      log('debug', 'CONFIDENCE', 'PREQUEL year mismatch penalty');
    }

    // Boost for reasonable year gaps (not too far apart = more likely same franchise)
    if (Math.abs(yearDiff) <= 5) {
      confidence = Math.min(confidence * 1.1, 1.0);
    }
  }

  // Penalty for supplemental types (movies, OVAs) in main chain
  if (node.is_movie || node.is_ova || node.is_special) {
    if (type === 'SEQUEL' || type === 'PREQUEL') {
      // Movies/OVAs claiming to be direct sequels are suspicious
      confidence *= 0.8;
      log('debug', 'CONFIDENCE', 'Supplemental format penalty');
    }
  }

  const finalConfidence = Math.min(Math.max(confidence, 0), 1);
  log('debug', 'CONFIDENCE', `Final confidence: ${finalConfidence.toFixed(2)}`);
  return finalConfidence;
}

/**
 * Build a complete franchise chain with proper prequel/sequel ordering.
 *
 * Algorithm:
 * 1. Find the canonical root (earliest confirmed anchor)
 * 2. Traverse PREQUEL edges backwards to build prequel chain
 * 3. Traverse SEQUEL edges forward to build sequel chain
 * 4. Order: [...prequels, root, ...sequels]
 *
 * @param {Object} cluster - Relation cluster from buildRelationCluster
 * @param {Object} sourceAnime - Starting anime entry
 * @returns {Object} Chain with root, prequels, sequels, and metadata
 */
export function buildFranchiseChain(cluster, sourceAnime) {
  const nodes = cluster.nodes || new Map();
  const edges = cluster.edges || new Map();
  const sourceId = Number(sourceAnime.selected_season_mal_id || sourceAnime.root_mal_id);

  log('info', 'CHAIN', `Building franchise chain from MAL ${sourceId}`, {
    nodeCount: nodes.size,
    sourceTitle: sourceAnime.title_english || sourceAnime.title_japanese,
  });

  if (nodes.size === 0) {
    log('warn', 'CHAIN', 'No nodes in cluster, returning single-item chain');
    return {
      root: sourceAnime,
      rootMalId: sourceId,
      prequels: [],
      sequels: [],
      allSeasons: [sourceAnime],
      chainConfidence: CONFIDENCE.GUESS,
    };
  }

  // Step 1: Find canonical root
  // Root = node with no PREQUEL edges pointing to it (or earliest if ambiguous)
  const rootNode = computeCanonicalRoot(nodes, edges, sourceId);
  const rootId = Number(rootNode.mal_id);

  log('info', 'CHAIN', `Canonical root identified: MAL ${rootId}`, {
    rootTitle: rootNode.title || rootNode.native_title,
  });

  // Step 2: Build prequel chain (traverse backwards via PREQUEL edges)
  const prequels = [];
  const visitedPrequels = new Set([rootId]);
  let currentId = rootId;
  let prequelDepth = 0;
  const MAX_PREQUEL_DEPTH = 5;

  while (prequelDepth < MAX_PREQUEL_DEPTH) {
    const nodeEdges = edges.get(currentId) || [];
    const prequelEdge = nodeEdges.find((e) =>
      e.relationType === 'PREQUEL' && !visitedPrequels.has(Number(e.targetId))
    );

    if (!prequelEdge) break;

    const prequelId = Number(prequelEdge.targetId);
    const prequelNode = nodes.get(prequelId);

    if (!prequelNode) break;

    const confidence = calculateRelationConfidence(
      { relationType: 'PREQUEL', node: prequelNode },
      nodes.get(currentId) || {}
    );

    prequels.unshift({
      ...prequelNode,
      _relationConfidence: confidence,
      _isPrequel: true,
      _chainIndex: -(prequels.length + 1),
    });

    visitedPrequels.add(prequelId);
    currentId = prequelId;
    prequelDepth++;

    log('debug', 'CHAIN', `Added prequel: ${prequelNode.title || prequelId} (confidence: ${confidence.toFixed(2)})`);
  }

  // Step 3: Build sequel chain (traverse forward via SEQUEL edges)
  const sequels = [];
  const visitedSequels = new Set([rootId]);
  currentId = rootId;
  let sequelDepth = 0;
  const MAX_SEQUEL_DEPTH = 10;

  while (sequelDepth < MAX_SEQUEL_DEPTH) {
    const allEdges = [];
    for (const [source, sourceEdges] of edges.entries()) {
      for (const edge of sourceEdges) {
        // Case 1: Someone has a PREQUEL pointing to currentId = they are currentId's SEQUEL
        if (Number(edge.targetId) === currentId && edge.relationType === 'PREQUEL') {
          // source is the sequel node (it has PREQUEL -> currentId)
          allEdges.push({ sourceId: Number(currentId), relationType: 'SEQUEL', targetId: Number(source) });
        }
        // Case 2: currentId has a direct SEQUEL edge pointing to someone
        if (Number(source) === currentId && edge.relationType === 'SEQUEL') {
          allEdges.push({ sourceId: Number(source), relationType: 'SEQUEL', targetId: Number(edge.targetId) });
        }
      }
    }

    // Find next sequel that's not visited
    const sequelEdge = allEdges.find((e) =>
      e.relationType === 'SEQUEL' && !visitedSequels.has(Number(e.targetId))
    );

    if (!sequelEdge) break;

    const sequelId = Number(sequelEdge.targetId);
    const sequelNode = nodes.get(sequelId);

    if (!sequelNode) break;

    const confidence = calculateRelationConfidence(
      { relationType: 'SEQUEL', node: sequelNode },
      nodes.get(currentId) || {}
    );

    sequels.push({
      ...sequelNode,
      _relationConfidence: confidence,
      _isSequel: true,
      _chainIndex: sequels.length + 1,
    });

    visitedSequels.add(sequelId);
    currentId = sequelId;
    sequelDepth++;

    log('debug', 'CHAIN', `Added sequel: ${sequelNode.title || sequelId} (confidence: ${confidence.toFixed(2)})`);
  }

  // Step 4: Build complete ordered chain
  const rootWithMeta = {
    ...rootNode,
    _isRoot: true,
    _chainIndex: 0,
    _relationConfidence: CONFIDENCE.CERTAIN,
  };

  const allSeasons = [...prequels, rootWithMeta, ...sequels];

  // Calculate overall chain confidence
  const chainConfidences = allSeasons.map((s) => s._relationConfidence || CONFIDENCE.GUESS);
  const overallConfidence = chainConfidences.reduce((a, b) => a * b, 1);

  log('info', 'CHAIN', `Chain complete: ${prequels.length} prequels, root, ${sequels.length} sequels`, {
    overallConfidence: overallConfidence.toFixed(2),
    totalSeasons: allSeasons.length,
  });

  return {
    root: rootWithMeta,
    rootMalId: rootId,
    prequels,
    sequels,
    allSeasons,
    chainConfidence: overallConfidence,
    sourceRelation: edges.get(sourceId) || [],
  };
}

/**
 * Compute the canonical root for a franchise.
 * Rules:
 * 1. Prefer node with no PREQUEL edges (earliest in timeline)
 * 2. If multiple, prefer TV format over supplemental
 * 3. If still ambiguous, prefer earliest aired date
 * 4. Never select a movie/OVA as root if TV option exists
 *
 * @param {Map} nodes - All nodes in cluster
 * @param {Map} edges - All edges in cluster
 * @param {number} fallbackId - Fallback if no clear root found
 * @returns {Object} Root node
 */
function computeCanonicalRoot(nodes, edges, fallbackId) {
  const nodeArray = Array.from(nodes.values());

  if (nodeArray.length === 0) {
    return { mal_id: fallbackId, title: 'Unknown' };
  }

  // Find candidates with no PREQUEL edges pointing to them
  const rootCandidates = nodeArray.filter((node) => {
    const nodeId = Number(node.mal_id);
    const incomingEdges = [];

    // Check all edges to see if any point to this node as PREQUEL
    for (const [sourceId, sourceEdges] of edges.entries()) {
      for (const edge of sourceEdges) {
        if (Number(edge.targetId) === nodeId && edge.relationType === 'PREQUEL') {
          incomingEdges.push(edge);
        }
      }
    }

    return incomingEdges.length === 0;
  });

  log('debug', 'ROOT', `Found ${rootCandidates.length} root candidates with no prequels`);

  // If no clear candidates, use all nodes
  const candidates = rootCandidates.length > 0 ? rootCandidates : nodeArray;

  // Score and sort candidates
  const scored = candidates.map((node) => {
    let score = 0;

    // Prefer TV format (highest priority)
    const format = node.format || 'TV';
    if (format === 'TV' || format === 'TV_SHORT') {
      score += 100;
    } else if (format === 'ONA') {
      score += 50;
    } else if (node.is_movie) {
      score -= 50; // Penalize movies as roots
    } else if (node.is_ova || node.is_special) {
      score -= 30; // Penalize OVAs/specials as roots
    }

    // Prefer earlier aired date
    const airedAt = new Date(node.aired_at || 0).getTime();
    if (airedAt > 0) {
      // Earlier dates get higher scores (inverse timestamp, normalized)
      score += Math.max(0, (2000000000000 - airedAt) / 10000000000);
    }

    // Prefer nodes with SEQUEL edges (indicates they start a chain)
    const hasSequels = Array.from(edges.get(Number(node.mal_id)) || []).some((e) =>
      e.relationType === 'SEQUEL'
    );
    if (hasSequels) {
      score += 20;
    }

    // Prefer the fallback ID if it's a candidate (stability)
    if (Number(node.mal_id) === fallbackId) {
      score += 10;
    }

    return { node, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const selectedRoot = scored[0]?.node || candidates[0];

  log('info', 'ROOT', `Selected root: MAL ${selectedRoot.mal_id}`, {
    title: selectedRoot.title || selectedRoot.native_title,
    score: scored[0]?.score,
    format: selectedRoot.format,
  });

  return selectedRoot;
}

/**
 * Detect new seasons with enhanced franchise chain awareness.
 * This is the primary function used by auto-add and re-search.
 *
 * @param {Object} anime - Library anime entry
 * @param {Array} [library] - Current library state
 * @param {Object} [options]
 * @returns {Promise<Object>} Detection result with prequels, sequels, suggestions
 */
export async function detectFranchiseSeasons(anime, library = [], options = {}) {
  const title = anime.title_english || anime.title_japanese || 'Unknown';
  const libraryArray = Array.isArray(library) ? library : (getState('library') || []);

  log('info', 'DETECT', `Starting franchise season detection for: ${title}`, {
    rootMalId: anime.root_mal_id,
    existingSeasons: Object.keys(anime.seasons || {}).length,
  });

  try {
    // Step 1: Get relation graph
    const { relations, cluster } = await getAllRelations(anime, options);

    log('debug', 'DETECT', `Retrieved ${relations.length} raw relations`, {
      nodeCount: cluster.nodes?.size || 0,
    });

    // Step 2: Build franchise chain
    const chain = buildFranchiseChain(cluster, anime);

    // Step 3: Check cache
    const cacheKey = `franchise-${chain.rootMalId}`;
    const cached = getCachedChain(cacheKey);
    if (cached && !options.skipCache) {
      log('debug', 'DETECT', 'Using cached franchise chain');
    } else {
      setCachedChain(cacheKey, chain);
    }

    // Step 4: Identify what's missing from library
    const existingIds = new Set([
      ...Object.keys(anime.seasons || {}).map(Number),
      ...libraryArray.map((a) => Number(a.root_mal_id)),
    ]);

    const prequelsToAdd = chain.prequels.filter((p) => !existingIds.has(Number(p.mal_id)));
    const sequelsToAdd = chain.sequels.filter((s) => !existingIds.has(Number(s.mal_id)));

    log('info', 'DETECT', `Missing: ${prequelsToAdd.length} prequels, ${sequelsToAdd.length} sequels`);

    // Step 5: Separate high-confidence from suggestions
    const highConfidencePrequels = prequelsToAdd.filter(
      (p) => p._relationConfidence >= CONFIDENCE.HIGH
    );
    const highConfidenceSequels = sequelsToAdd.filter(
      (s) => s._relationConfidence >= CONFIDENCE.HIGH
    );

    const suggestionPrequels = prequelsToAdd.filter(
      (p) => p._relationConfidence < CONFIDENCE.HIGH && p._relationConfidence >= CONFIDENCE.LOW
    );
    const suggestionSequels = sequelsToAdd.filter(
      (s) => s._relationConfidence < CONFIDENCE.HIGH && s._relationConfidence >= CONFIDENCE.LOW
    );

    const result = {
      chain,
      autoAdd: {
        prequels: highConfidencePrequels,
        sequels: highConfidenceSequels,
        total: highConfidencePrequels.length + highConfidenceSequels.length,
      },
      suggestions: {
        prequels: suggestionPrequels,
        sequels: suggestionSequels,
        total: suggestionPrequels.length + suggestionSequels.length,
      },
      existingIds: Array.from(existingIds),
      confidence: chain.chainConfidence,
    };

    log('info', 'DETECT', `Detection complete: ${result.autoAdd.total} auto-add, ${result.suggestions.total} suggestions`);

    return result;
  } catch (err) {
    log('error', 'DETECT', `Detection failed: ${err.message}`, err);
    return {
      chain: null,
      autoAdd: { prequels: [], sequels: [], total: 0 },
      suggestions: { prequels: [], sequels: [], total: 0 },
      error: err.message,
    };
  }
}

/**
 * Detect new episodes for a single season using AniList (preferred for airing)
 * and Jikan (metadata verification).
 *
 * Rules:
 * - Never trust a zero episode value if another source has valid data
 * - Prefer AniList for airing timing and episode progression
 * - Use Jikan for metadata verification
 * - Update only when a newer valid episode count is found
 *
 * @param {Object} season - A season object from the library
 * @param {Object} anime - Parent anime entry
 * @param {Object} [aniListBatch] - Pre-fetched AniList data map { mal_id: data }
 * @returns {Promise<Object>} { episodeUpdateFound, updateApplied, patch }
 */
export async function detectNewEpisodes(season, anime, aniListBatch = null) {
  const malId = Number(season.mal_id);
  const result = {
    episodeUpdateFound: false,
    updateApplied: false,
    patch: {},
  };

  // 1. AniList data (preferred for airing)
  let aniListData = null;
  if (aniListBatch && aniListBatch[malId]) {
    aniListData = aniListBatch[malId];
  } else {
    try {
      const aniMap = await fetchFromAniList([
        { ...anime, selected_season_mal_id: malId, root_mal_id: anime.root_mal_id },
      ]);
      aniListData = aniMap ? aniMap[malId] : null;
    } catch (e) {
      /* skip */
    }
  }

  // 2. Jikan data (metadata verification)
  let jikanData = null;
  try {
    jikanData = await fetchJikanAnime(malId);
  } catch (e) {
    /* skip */
  }

  // 3. Episode count resolution — never trust zero if another source has valid data
  const oldTotal = Number(season.total_episodes || 0);
  const aniListTotal = Number(aniListData?.totalEpisodes || 0);
  const jikanTotal = Number(jikanData?.episodes || 0);

  let newTotal = oldTotal;

  // Prefer AniList if it has a valid higher count
  if (aniListTotal > 0 && aniListTotal > oldTotal) {
    newTotal = aniListTotal;
  }
  // Fall back to Jikan if AniList has nothing valid and Jikan is higher
  else if (jikanTotal > 0 && jikanTotal > oldTotal && aniListTotal <= 0) {
    newTotal = jikanTotal;
  }
  // If old is zero but we have valid data from any source, use it
  else if (oldTotal === 0 && aniListTotal > 0) {
    newTotal = aniListTotal;
  } else if (oldTotal === 0 && jikanTotal > 0) {
    newTotal = jikanTotal;
  }

  // 4. Airing status and countdown from AniList
  const isAiring =
    aniListData?.status === 'RELEASING' ||
    jikanData?.airing ||
    season.is_airing;
  const normalizedStatus = normalizeSeasonStatus(
    aniListData?.status || jikanData?.season_status || jikanData?.status,
    {
      airing: !!aniListData?.nextAiringAtMs || !!jikanData?.airing,
      fallback: season.status || 'Unknown',
    }
  );

  const newAiringAt = normalizedStatus === 'Currently Airing' ? aniListData?.nextAiringAtMs || null : null;
  const newNextEpNum = normalizedStatus === 'Currently Airing' ? aniListData?.nextEpNum || null : null;

  // 5. Build patch if anything changed
  const patch = {};

  if (newTotal > oldTotal) {
    patch.total_episodes = newTotal;
  }

  if (normalizedStatus !== season.status && normalizedStatus) {
    patch.status = normalizedStatus;
    patch.airing = normalizedStatus === 'Currently Airing';
    patch.is_airing = normalizedStatus === 'Currently Airing';
  }

  if (newAiringAt !== season.next_episode_airing_at) {
    patch.next_episode_airing_at = newAiringAt;
    patch.next_episode_airtime = newAiringAt;
  }

  if (newNextEpNum !== season.next_episode_number) {
    patch.next_episode_number = newNextEpNum;
  }

  // If airing ended, clear countdown fields
  if (normalizedStatus === 'Finished Airing' && season.next_episode_airing_at) {
    patch.next_episode_airing_at = null;
    patch.next_episode_airtime = null;
    patch.next_episode_number = null;
  }

  if (Object.keys(patch).length > 0) {
    result.episodeUpdateFound = true;
    result.patch = patch;
  }

  return result;
}

/**
 * Apply a season update patch via animeManager.
 *
 * @param {number} rootMalId
 * @param {number} seasonMalId
 * @param {Object} patch
 * @returns {Promise<boolean>}
 */
export async function applySeasonUpdate(rootMalId, seasonMalId, patch) {
  if (!patch || Object.keys(patch).length === 0) return false;
  await updateSeasonField(rootMalId, seasonMalId, {
    ...patch,
    updated_date: new Date().toISOString(),
  });
  return true;
}

// ─── High-Level Operations ───────────────────────────────────────────────────

/**
 * Scan an anime for new seasons using the unified relation engine.
 * Used by: auto-add, manual re-search, daily sync.
 *
 * This is the PRIMARY entry point for season detection - uses franchise chain logic
 * to properly identify prequels, sequels, and maintain one unified root.
 *
 * @param {Object} anime - Library anime entry
 * @param {Array} [library] - Current library state
 * @param {Object} [options]
 * @param {number} [options.maxDepth] - Graph depth (default 4)
 * @param {boolean} [options.includePrequels] - Whether to include prequels (default true)
 * @returns {Promise<{autoAdded: number, suggestions: Array, relationsFound: number, prequels: number, sequels: number}>}
 */
export async function scanForNewSeasons(anime, library = [], options = {}) {
  const title = anime.title_english || anime.title_japanese || 'Unknown';

  log('info', 'SCAN', `Starting scan for: ${title}`, {
    rootMalId: anime.root_mal_id,
    includePrequels: options.includePrequels !== false,
  });

  try {
    // Use the new franchise chain detection (PRIMARY method)
    const detection = await detectFranchiseSeasons(anime, library, options);

    if (detection.error) {
      throw new Error(detection.error);
    }

    let autoAdded = 0;
    let prequelsAdded = 0;
    let sequelsAdded = 0;
    const suggestions = [];

    // Process high-confidence auto-add items (sequels first, then prequels if enabled)
    const autoAddItems = [
      ...detection.autoAdd.sequels.map((s) => ({ ...s, _isSequel: true })),
      ...(options.includePrequels !== false
        ? detection.autoAdd.prequels.map((p) => ({ ...p, _isPrequel: true }))
        : []),
    ];

    for (const item of autoAddItems) {
      // Fetch full Jikan data for merge
      let jikanData = null;
      try {
        jikanData = await fetchJikanAnime(item.mal_id);
      } catch (e) {
        log('warn', 'SCAN', `Failed to fetch Jikan data for ${item.mal_id}`, e);
        continue;
      }

      if (!jikanData) {
        log('warn', 'SCAN', `No Jikan data returned for ${item.mal_id}`);
        continue;
      }

      try {
        // Use franchise root from chain detection, not the original anime's root
        // This ensures sequels/prequels attach to the correct canonical root
        const targetRootId = detection.chain?.rootMalId || anime.root_mal_id;

        log('info', 'SCAN', `Merging ${item._isPrequel ? 'prequel' : 'sequel'}: ${jikanData.title}`, {
          malId: item.mal_id,
          targetRoot: targetRootId,
          confidence: item._relationConfidence?.toFixed(2),
        });

        await mergeRelationSeason(targetRootId, jikanData);
        autoAdded++;

        if (item._isPrequel) prequelsAdded++;
        else sequelsAdded++;

        // Notify about new season with type indication
        const seasonLabel = item._isPrequel ? 'prequel' : 'sequel';
        notifyNewSeason(anime, `${jikanData.title} (${seasonLabel})`);
      } catch (e) {
        log('error', 'SCAN', `mergeRelationSeason failed for ${item.mal_id}`, e);
      }
    }

    // Process suggestions (lower confidence items)
    const suggestionItems = [
      ...detection.suggestions.sequels.map((s) => ({ ...s, _isSequel: true })),
      ...(options.includePrequels !== false
        ? detection.suggestions.prequels.map((p) => ({ ...p, _isPrequel: true }))
        : []),
    ];

    for (const item of suggestionItems) {
      let jikanData = null;
      try {
        jikanData = await fetchJikanAnime(item.mal_id);
      } catch (e) {
        continue;
      }
      if (!jikanData) continue;

      suggestions.push({
        mal_id: item.mal_id,
        relationType: item._isPrequel ? 'PREQUEL' : 'SEQUEL',
        jikanData,
        prechecked: false,
        alreadyInLibrary: false,
        _isPrequel: item._isPrequel,
        _isSequel: item._isSequel,
        _confidence: item._relationConfidence,
      });
    }

    const totalRelations = detection.autoAdd.total + detection.suggestions.total;

    log('info', 'SCAN', `Scan complete: ${autoAdded} auto-added (${prequelsAdded} prequels, ${sequelsAdded} sequels), ${suggestions.length} suggestions`, {
      totalRelations,
      chainConfidence: detection.confidence?.toFixed(2),
    });

    // Log in unified format
    logRelationEngine(title, totalRelations, autoAdded, false, autoAdded > 0, {
      prequels: prequelsAdded,
      sequels: sequelsAdded,
      suggestions: suggestions.length,
    });

    return {
      autoAdded,
      prequels: prequelsAdded,
      sequels: sequelsAdded,
      suggestions,
      relationsFound: totalRelations,
      chain: detection.chain,
    };
  } catch (err) {
    log('error', 'SCAN', `scanForNewSeasons failed: ${err.message}`, err);
    logRelationEngine(title, 0, 0, false, false);
    return { autoAdded: 0, prequels: 0, sequels: 0, suggestions: [], relationsFound: 0 };
  }
}

/**
 * Scan all seasons of an anime for new episode data.
 * Used by: manual re-search, daily sync.
 *
 * @param {Object} anime - Library anime entry
 * @param {Array} [library] - Current library state
 * @returns {Promise<{episodeUpdateFound: boolean, updateApplied: boolean, updatedSeasons: number}>}
 */
export async function scanForNewEpisodes(anime, library = []) {
  const title = anime.title_english || anime.title_japanese || 'Unknown';
  const seasons = getSeasonsArray(anime);

  if (seasons.length === 0) {
    logRelationEngine(title, 0, 0, false, false);
    return { episodeUpdateFound: false, updateApplied: false, updatedSeasons: 0 };
  }

  // Batch AniList fetch for all seasons at once (more efficient)
  let aniListBatch = null;
  try {
    const aniListPayloads = seasons.map((s) => ({
      ...anime,
      selected_season_mal_id: Number(s.mal_id),
      root_mal_id: anime.root_mal_id,
    }));
    aniListBatch = await fetchFromAniList(aniListPayloads);
  } catch (e) {
    /* will fall back to per-season fetch */
  }

  let episodeUpdateFound = false;
  let updateApplied = false;
  let updatedSeasons = 0;

  for (const season of seasons) {
    try {
      const result = await detectNewEpisodes(season, anime, aniListBatch);
      if (result.episodeUpdateFound) {
        episodeUpdateFound = true;

        // Never modify watched progress
        const patch = { ...result.patch };

        const applied = await applySeasonUpdate(anime.root_mal_id, season.mal_id, patch);
        if (applied) {
          updateApplied = true;
          updatedSeasons++;

          // Single non-duplicated notification
          notifyEpisodeUpdate(anime, season, patch);
        }
      }
    } catch (e) {
      console.warn('[RELATION ENGINE] Episode scan failed for season', season.mal_id, e);
    }
  }

  logRelationEngine(title, 0, 0, episodeUpdateFound, updateApplied);

  return { episodeUpdateFound, updateApplied, updatedSeasons };
}

/**
 * Full franchise sync: new seasons + episode updates.
 * Used by: daily sync cycle.
 *
 * @param {Object} anime - Library anime entry
 * @param {Array} [library] - Current library state
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function fullFranchiseSync(anime, library = [], options = {}) {
  const seasonResult = await scanForNewSeasons(anime, library, options);
  const episodeResult = await scanForNewEpisodes(anime, library);

  // Refresh franchise metadata after any changes
  if (seasonResult.autoAdded > 0 || episodeResult.updateApplied) {
    try {
      const freshLibrary = getState('library') || [];
      const freshAnime = freshLibrary.find(
        (a) => Number(a.root_mal_id) === Number(anime.root_mal_id)
      );
      if (freshAnime) {
        const resolved = await resolveFranchise(freshAnime, freshLibrary);
        if (resolved) {
          const updated = freshLibrary.map((a) =>
            Number(a.root_mal_id) === Number(anime.root_mal_id)
              ? applyResolvedFranchisePatch(freshAnime, resolved, freshLibrary)
              : a
          );
          await normalizeAndCommitLibrary(freshLibrary, updated, [anime.root_mal_id], {
            persistMode: 'immediate',
          });
        }
      }
    } catch (e) {
      console.warn('[RELATION ENGINE] Franchise re-resolution failed:', e);
    }
  }

  return {
    ...seasonResult,
    ...episodeResult,
  };
}

// ─── Daily Sync Service ─────────────────────────────────────────────────────

/**
 * Start the 24-hour background sync cycle.
 * Checks for new seasons and new episodes for all library anime.
 */
export function startDailySync() {
  if (_dailySyncTimer) return;

  if (!_dailySyncStartupTimer) {
    _dailySyncStartupTimer = setTimeout(() => {
      _dailySyncStartupTimer = null;
      runDailySyncCycle();
    }, 30000);
  }

  _dailySyncTimer = setInterval(runDailySyncCycle, DAILY_SYNC_INTERVAL_MS);
}

/**
 * Stop the daily sync cycle.
 */
export function stopDailySync() {
  if (_dailySyncStartupTimer) {
    clearTimeout(_dailySyncStartupTimer);
    _dailySyncStartupTimer = null;
  }
  if (_dailySyncTimer) {
    clearInterval(_dailySyncTimer);
    _dailySyncTimer = null;
  }
}

/**
 * Run one daily sync cycle.
 * Processes stale anime in controlled batches.
 */
async function runDailySyncCycle() {
  if (_isDailySyncRunning) return;
  _isDailySyncRunning = true;

  try {
    const library = getState('library') || [];
    if (library.length === 0) return;

    const now = Date.now();

    // Only check anime that haven't been synced recently
    const candidates = library
      .filter((anime) => {
        const lastSync = anime.franchise_cache_updated_at
          ? new Date(anime.franchise_cache_updated_at).getTime()
          : 0;
        return now - lastSync > EPISODE_STALE_MS;
      })
      .sort((a, b) => {
        const aTime = a.franchise_cache_updated_at
          ? new Date(a.franchise_cache_updated_at).getTime()
          : 0;
        const bTime = b.franchise_cache_updated_at
          ? new Date(b.franchise_cache_updated_at).getTime()
          : 0;
        return aTime - bTime;
      })
      .slice(0, DAILY_SYNC_BATCH_SIZE);

    for (const anime of candidates) {
      try {
        await fullFranchiseSync(anime, library);
      } catch (e) {
        console.warn(
          '[RELATION ENGINE] Daily sync failed for',
          anime.title_english,
          e
        );
      }
    }

    if (candidates.length > 0) {
      console.log(
        `[RELATION ENGINE] Daily sync cycle processed ${candidates.length} anime`
      );
    }
  } catch (err) {
    console.warn('[RELATION ENGINE] Daily sync cycle error:', err);
  } finally {
    _isDailySyncRunning = false;
  }
}

// ─── Notification Helpers ────────────────────────────────────────────────────

/**
 * Emit a single non-duplicated notification for episode updates.
 */
function notifyEpisodeUpdate(anime, season, patch) {
  if (!patch.total_episodes) return;

  const dedupKey = `ep_update_${anime.root_mal_id}_${season.mal_id}_${patch.total_episodes}`;
  const lastNotified = _episodeNotifiedAt.get(dedupKey) || 0;
  const now = Date.now();

  if (now - lastNotified < NOTIFICATION_DEDUP_WINDOW_MS) return;

  _episodeNotifiedAt.set(dedupKey, now);

  addNotification(
    'new_episode',
    `Episode count updated: ${anime.title_english || anime.title_japanese}`,
    anime,
    `S${season.season_number || '?'} now has ${patch.total_episodes} episodes`
  );
}

/**
 * Emit a notification for newly discovered seasons.
 */
export function notifyNewSeason(anime, seasonTitle) {
  const dedupKey = `new_season_${anime.root_mal_id}_${seasonTitle}`;
  const lastNotified = _episodeNotifiedAt.get(dedupKey) || 0;
  const now = Date.now();

  if (now - lastNotified < NOTIFICATION_DEDUP_WINDOW_MS) return;

  _episodeNotifiedAt.set(dedupKey, now);

  addNotification(
    'status_changed',
    `New season discovered: ${anime.title_english || anime.title_japanese}`,
    anime,
    seasonTitle
  );
}

// ─── Unified Logging ────────────────────────────────────────────────────────

/**
 * Unified log format for season discovery and episode detection.
 * Used for: auto-add, manual re-search, daily sync.
 */
function logRelationEngine(animeTitle, relationsFound, newSeasonsDetected, episodeUpdateFound, updateApplied, extra = {}) {
  const prequelStr = extra.prequels ? ` (prequels:${extra.prequels})` : '';
  const sequelStr = extra.sequels ? ` (sequels:${extra.sequels})` : '';
  const suggestionStr = extra.suggestions ? ` (suggestions:${extra.suggestions})` : '';

  console.log(
    `[RELATION ENGINE v2]\n` +
      `anime: ${animeTitle}\n` +
      `relations_found: ${relationsFound}\n` +
      `new_seasons_detected: ${newSeasonsDetected}${prequelStr}${sequelStr}\n` +
      `suggestions_pending: ${extra.suggestions || 0}${suggestionStr}\n` +
      `episode_update_found: ${episodeUpdateFound}\n` +
      `update_applied: ${updateApplied}\n` +
      `chain_confidence: ${extra.chainConfidence || 'N/A'}`
  );
}

// ─── Exports for type-checking / testing ─────────────────────────────────────

export {
  RELATION_TYPES,
  RELATION_PRIORITY,
  CHAIN_FORMING_TYPES,
  SEASON_DISCOVERY_TYPES,
  HIGH_CONFIDENCE_TYPES,
  CONFIDENCE,
  // Cache management only - other functions already exported as declarations
  invalidateChainCache,
};
