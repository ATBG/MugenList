/**
 * animeCardLiveUpdate.js — Smart diff-based reconciliation pipeline for Anime Cards
 * 
 * Features:
 * - Fine-grained field-level diffing per anime/season
 * - Source prioritization (AniList > MAL > Jikan)
 * - Visual stability with targeted DOM patching
 * - Comprehensive debugging logs
 * - Data integrity guards (never downgrade valid data)
 */

import { getState } from '../state.js';
import { updateCardFromAnime } from '../ui/animeCard.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const DEBUG = true;

/** Source confidence levels (higher = more authoritative) */
const SOURCE_CONFIDENCE = {
  anilist: 3,    // Highest - real-time airing data
  mal: 2,        // Medium - official MAL data
  jikan: 1,      // Lower - cached Jikan data
  internal: 0,   // Lowest - local state
};

/** Fields that can be updated with their validation rules */
const UPDATEABLE_FIELDS = {
  title: { validate: (v) => typeof v === 'string' && v.length > 0 },
  title_english: { validate: (v) => typeof v === 'string' && v.length > 0 },
  title_japanese: { validate: (v) => typeof v === 'string' && v.length > 0 },
  normalizedRootTitle: { validate: (v) => typeof v === 'string' && v.length > 0 },
  seasonName: { validate: (v) => typeof v === 'string' },
  seasonYear: { validate: (v) => typeof v === 'number' && v > 2000 },
  total_episodes: { 
    validate: (v, oldVal) => typeof v === 'number' && v > 0 && v >= (oldVal || 0),
    neverDowngrade: true 
  },
  airingStatus: { validate: (v) => ['Currently Airing', 'Finished Airing', 'Not Yet Aired', 'Unknown'].includes(v) },
  nextEpisodeNumber: { 
    validate: (v, oldVal, season) => {
      if (typeof v !== 'number' || v < 1) return false;
      // Must be higher than current progress or previous next episode
      const currentProgress = season?.progress || 0;
      const oldNext = oldVal || 0;
      return v > currentProgress || v >= oldNext;
    },
    neverDowngrade: true
  },
  next_episode_airing_at: { 
    validate: (v, oldVal) => {
      if (!v || typeof v !== 'number') return false;
      const now = Date.now();
      const minValid = now - 24 * 60 * 60 * 1000; // Allow 1 day in past
      const maxValid = now + 365 * 24 * 60 * 60 * 1000; // Max 1 year in future
      return v >= minValid && v <= maxValid;
    }
  },
  franchise_id: { validate: (v) => typeof v === 'string' || typeof v === 'number' },
  root_mal_id: { validate: (v) => typeof v === 'number' && v > 0 },
  poster: { validate: (v) => typeof v === 'string' && v.length > 0 },
  genres: { validate: (v) => Array.isArray(v) },
  status: { validate: (v) => typeof v === 'string' && v.length > 0 },
};

/** User progress fields - strictly protected from auto-updates */
const PROTECTED_FIELDS = new Set([
  'progress',
  'watched_episodes',
  'user_status',
  'manual_override',
  'user_rating',
  'notes',
]);

// ─── Debug Logging ───────────────────────────────────────────────────────────

function logUpdate(source, animeId, changes, result) {
  if (!DEBUG) return;
  console.log(
    `[AnimeCard Update] ${new Date().toISOString()}`,
    `\n  Source: ${source}`,
    `\n  Anime: ${animeId}`,
    `\n  Changes:`, changes,
    `\n  Result: ${result.action} (${result.reason || 'ok'})`
  );
}

function logCountdown(animeId, oldTime, newTime, isVisible) {
  if (!DEBUG) return;
  console.log(
    `[AnimeCard Update] Countdown ${animeId}`,
    `\n  Old: ${oldTime ? new Date(oldTime).toISOString() : 'none'}`,
    `\n  New: ${newTime ? new Date(newTime).toISOString() : 'none'}`,
    `\n  Visible: ${isVisible}`
  );
}

function logReconciliation(animeId, conflicts, resolution) {
  if (!DEBUG) return;
  console.log(
    `[AnimeCard Update] Reconciliation ${animeId}`,
    `\n  Conflicts:`, conflicts,
    `\n  Resolution: ${resolution}`
  );
}

// ─── Diff Engine ─────────────────────────────────────────────────────────────

/**
 * Calculate fine-grained diff between old and new season data
 * @param {Object} oldSeason - Current season data
 * @param {Object} newSeason - Incoming season data
 * @param {string} source - Data source ('anilist', 'mal', 'jikan')
 * @returns {Object} Diff result with { changes, conflicts, confidence }
 */
export function calculateSeasonDiff(oldSeason, newSeason, source) {
  const changes = {};
  const conflicts = [];
  const sourcePriority = SOURCE_CONFIDENCE[source] || 0;

  for (const [field, config] of Object.entries(UPDATEABLE_FIELDS)) {
    const oldVal = oldSeason?.[field];
    const newVal = newSeason?.[field];

    // Skip if values are identical
    if (oldVal === newVal) continue;
    
    // Skip if new value is null/undefined and we have valid old value
    if ((newVal === null || newVal === undefined) && oldVal !== null && oldVal !== undefined) {
      continue;
    }

    // Validate new value
    if (!config.validate(newVal, oldVal, oldSeason)) {
      conflicts.push({
        field,
        reason: 'validation_failed',
        oldValue: oldVal,
        newValue: newVal,
      });
      continue;
    }

    // Check for downgrade protection
    if (config.neverDowngrade && oldVal !== undefined && oldVal !== null) {
      if (typeof newVal === 'number' && typeof oldVal === 'number' && newVal < oldVal) {
        conflicts.push({
          field,
          reason: 'would_downgrade',
          oldValue: oldVal,
          newValue: newVal,
        });
        continue;
      }
    }

    // Field is valid and different
    changes[field] = {
      old: oldVal,
      new: newVal,
      source,
      sourcePriority,
    };
  }

  return { changes, conflicts, confidence: sourcePriority };
}

/**
 * Calculate diff for entire anime entry (all seasons + root fields)
 * @param {Object} oldAnime - Current anime data
 * @param {Object} newAnime - Incoming anime data
 * @param {string} source - Data source
 * @returns {Object} Complete diff result
 */
export function calculateAnimeDiff(oldAnime, newAnime, source) {
  const rootChanges = {};
  const seasonChanges = {};
  const allConflicts = [];

  // Diff root-level fields
  for (const [field, config] of Object.entries(UPDATEABLE_FIELDS)) {
    const oldVal = oldAnime?.[field];
    const newVal = newAnime?.[field];

    if (oldVal === newVal) continue;
    if ((newVal === null || newVal === undefined) && oldVal !== null && oldVal !== undefined) continue;
    if (!config.validate(newVal, oldVal)) continue;

    rootChanges[field] = {
      old: oldVal,
      new: newVal,
      source,
      sourcePriority: SOURCE_CONFIDENCE[source] || 0,
    };
  }

  // Diff each season
  const oldSeasons = oldAnime?.seasons || {};
  const newSeasons = newAnime?.seasons || {};
  const allSeasonIds = new Set([...Object.keys(oldSeasons), ...Object.keys(newSeasons)]);

  for (const seasonId of allSeasonIds) {
    const oldSeason = oldSeasons[seasonId];
    const newSeason = newSeasons[seasonId];

    if (!newSeason) continue; // Don't remove seasons via auto-update

    const { changes, conflicts } = calculateSeasonDiff(oldSeason, newSeason, source);
    
    if (Object.keys(changes).length > 0) {
      seasonChanges[seasonId] = changes;
    }
    if (conflicts.length > 0) {
      allConflicts.push(...conflicts.map(c => ({ ...c, seasonId })));
    }
  }

  return {
    rootChanges,
    seasonChanges,
    conflicts: allConflicts,
    hasChanges: Object.keys(rootChanges).length > 0 || Object.keys(seasonChanges).length > 0,
    source,
    sourcePriority: SOURCE_CONFIDENCE[source] || 0,
  };
}

// ─── Reconciliation Engine ───────────────────────────────────────────────────

/**
 * Reconcile a pending update with existing anime data
 * @param {Object} currentAnime - Current anime in library
 * @param {Object} incomingData - New data from source
 * @param {string} source - Data source
 * @returns {Object} Reconciliation result with { shouldUpdate, patch, reasons }
 */
export function reconcileUpdate(currentAnime, incomingData, source) {
  const diff = calculateAnimeDiff(currentAnime, incomingData, source);
  
  if (!diff.hasChanges) {
    return { shouldUpdate: false, patch: null, reasons: ['no_changes'] };
  }

  // Build patch with only valid changes
  const patch = {
    root: {},
    seasons: {},
  };

  // Apply root-level changes
  for (const [field, change] of Object.entries(diff.rootChanges)) {
    patch.root[field] = change.new;
  }

  // Apply season-level changes
  for (const [seasonId, changes] of Object.entries(diff.seasonChanges)) {
    patch.seasons[seasonId] = {};
    for (const [field, change] of Object.entries(changes)) {
      patch.seasons[seasonId][field] = change.new;
    }
  }

  logReconciliation(currentAnime.root_mal_id, diff.conflicts, 
    diff.conflicts.length > 0 ? 'partial' : 'full');

  return {
    shouldUpdate: Object.keys(patch.root).length > 0 || Object.keys(patch.seasons).length > 0,
    patch,
    diff,
    reasons: diff.conflicts.map(c => `${c.field}:${c.reason}`),
  };
}

// ─── Update Application ──────────────────────────────────────────────────────

/**
 * Apply a reconciled patch to the library state
 * @param {Object} patch - Patch from reconcileUpdate
 * @param {number} rootMalId - Anime root ID
 * @returns {Promise<boolean>} Success status
 */
export async function applyCardPatch(patch, rootMalId) {
  if (!patch || (!Object.keys(patch.root).length && !Object.keys(patch.seasons).length)) {
    return false;
  }

  const library = getState('library') || [];
  const animeIndex = library.findIndex(a => a.root_mal_id === Number(rootMalId));
  
  if (animeIndex === -1) {
    console.warn(`[AnimeCard Update] Cannot apply patch: anime ${rootMalId} not found`);
    return false;
  }

  const currentAnime = library[animeIndex];
  const updatedSeasons = { ...currentAnime.seasons };

  // Apply season patches
  for (const [seasonId, seasonPatch] of Object.entries(patch.seasons)) {
    const seasonKey = String(seasonId);
    const currentSeason = updatedSeasons[seasonKey] || {};
    
    updatedSeasons[seasonKey] = {
      ...currentSeason,
      ...seasonPatch,
      _lastLiveUpdate: new Date().toISOString(),
      _lastUpdateSource: patch.source || 'unknown',
    };
  }

  // Build updated anime
  const updatedAnime = {
    ...currentAnime,
    ...patch.root,
    seasons: updatedSeasons,
    _lastLiveUpdate: new Date().toISOString(),
  };

  // Update library state (without full re-render)
  const newLibrary = [...library];
  newLibrary[animeIndex] = updatedAnime;
  
  // Update state silently (no notification)
  const { patchState } = await import('../state.js');
  patchState({ library: newLibrary });

  // Update card DOM directly
  updateCardFromAnime(updatedAnime);

  return true;
}

// ─── Episode Release Detection ───────────────────────────────────────────────

/**
 * Detect and handle episode release from incoming data
 * @param {Object} currentSeason - Current season data
 * @param {Object} newData - Incoming data
 * @param {string} source - Data source
 * @returns {Object} Release detection result
 */
export function detectEpisodeRelease(currentSeason, newData, source) {
  const now = Date.now();
  const nextAiringAt = newData.next_episode_airing_at || newData.nextAiringAtMs;
  const currentNextAiring = currentSeason?.next_episode_airing_at;
  
  // Episode has aired if:
  // 1. We had a next airing time that has now passed
  // 2. Episode count increased
  // 3. Next episode number changed
  
  const hadAiringTime = currentNextAiring && currentNextAiring > now;
  const newAiringTime = nextAiringAt && nextAiringAt > now;
  const episodeCountIncreased = (newData.totalEpisodes || newData.total_episodes) > (currentSeason?.total_episodes || 0);
  const nextEpisodeChanged = (newData.nextEpNum || newData.next_episode_number) !== currentSeason?.next_episode_number;
  
  const hasReleased = hadAiringTime && !newAiringTime && (episodeCountIncreased || nextEpisodeChanged);
  
  return {
    hasReleased,
    shouldNotify: hasReleased && source === 'anilist', // Only notify on AniList updates
    oldEpisodeCount: currentSeason?.total_episodes || 0,
    newEpisodeCount: newData.totalEpisodes || newData.total_episodes || currentSeason?.total_episodes,
    oldNextEp: currentSeason?.next_episode_number,
    newNextEp: newData.nextEpNum || newData.next_episode_number,
  };
}

// ─── Batch Update Handler ─────────────────────────────────────────────────────

/**
 * Process multiple anime updates efficiently
 * @param {Array} updates - Array of { anime, data, source }
 * @returns {Promise<Object>} Batch result
 */
export async function processBatchUpdates(updates) {
  const results = {
    applied: [],
    rejected: [],
    errors: [],
  };

  // Group by anime for efficient processing
  const byAnime = new Map();
  for (const update of updates) {
    const key = update.anime.root_mal_id;
    if (!byAnime.has(key)) {
      byAnime.set(key, []);
    }
    byAnime.get(key).push(update);
  }

  // Process each anime (prioritize by source confidence)
  for (const [rootMalId, animeUpdates] of byAnime) {
    try {
      // Sort by source confidence (highest first)
      animeUpdates.sort((a, b) => 
        (SOURCE_CONFIDENCE[b.source] || 0) - (SOURCE_CONFIDENCE[a.source] || 0)
      );

      // Apply highest confidence update
      const bestUpdate = animeUpdates[0];
      const reconciliation = reconcileUpdate(bestUpdate.anime, bestUpdate.data, bestUpdate.source);

      if (reconciliation.shouldUpdate) {
        await applyCardPatch(reconciliation.patch, rootMalId);
        results.applied.push({
          rootMalId,
          source: bestUpdate.source,
          fields: Object.keys(reconciliation.patch.root).concat(
            Object.values(reconciliation.patch.seasons).flatMap(s => Object.keys(s))
          ),
        });
      } else {
        results.rejected.push({
          rootMalId,
          reasons: reconciliation.reasons,
        });
      }
    } catch (err) {
      results.errors.push({ rootMalId, error: err.message });
    }
  }

  return results;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Main entry point: Process live update for a single anime
 * @param {Object} anime - Current anime data
 * @param {Object} newData - Incoming data
 * @param {string} source - Source ('anilist', 'mal', 'jikan')
 * @returns {Promise<Object>} Update result
 */
export async function processLiveUpdate(anime, newData, source) {
  const startTime = performance.now();
  
  const reconciliation = reconcileUpdate(anime, newData, source);
  
  if (!reconciliation.shouldUpdate) {
    logUpdate(source, anime.root_mal_id, reconciliation.patch, {
      action: 'skipped',
      reason: reconciliation.reasons.join(', '),
    });
    return { updated: false, reasons: reconciliation.reasons };
  }

  const success = await applyCardPatch(reconciliation.patch, anime.root_mal_id);
  
  const duration = performance.now() - startTime;
  logUpdate(source, anime.root_mal_id, reconciliation.patch, {
    action: success ? 'applied' : 'failed',
    duration: `${duration.toFixed(2)}ms`,
    fieldsChanged: Object.keys(reconciliation.patch.root).length + 
      Object.values(reconciliation.patch.seasons).reduce((acc, s) => acc + Object.keys(s).length, 0),
  });

  // Check for episode release
  const selectedSeason = anime.seasons?.[anime.selected_season_mal_id];
  const newSeasonData = newData.seasons?.[anime.selected_season_mal_id] || newData;
  const releaseInfo = detectEpisodeRelease(selectedSeason, newSeasonData, source);
  
  return {
    updated: success,
    patch: reconciliation.patch,
    episodeReleased: releaseInfo.hasReleased,
    shouldNotify: releaseInfo.shouldNotify,
    releaseInfo,
    duration,
  };
}

/**
 * Check if a field update should be allowed
 * @param {string} field - Field name
 * @param {*} newValue - New value
 * @param {*} oldValue - Old value
 * @returns {boolean}
 */
export function isValidUpdate(field, newValue, oldValue) {
  // Protected fields can never be auto-updated
  if (PROTECTED_FIELDS.has(field)) return false;
  
  const config = UPDATEABLE_FIELDS[field];
  if (!config) return false; // Unknown field
  
  return config.validate(newValue, oldValue);
}

/**
 * Get current update statistics for debugging
 * @returns {Object} Stats
 */
export function getUpdateStats() {
  // This could be enhanced to track metrics over time
  return {
    sourceConfidence: SOURCE_CONFIDENCE,
    updateableFields: Object.keys(UPDATEABLE_FIELDS),
    protectedFields: Array.from(PROTECTED_FIELDS),
    debugEnabled: DEBUG,
  };
}

// Export for testing - constants only (functions already exported as declarations)
export { SOURCE_CONFIDENCE };
