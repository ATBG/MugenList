/**
 * backendSearchService.js — Thin frontend wrapper for the backend-driven
 * Add Anime and Refresh flows.
 *
 * All heavy logic lives in Python.  This module only does:
 *   - HTTP calls to the backend
 *   - Translating responses into shapes the UI expects
 */

import { localFetch } from '../api.js';

// ────────────────────────────────────────────────────────────────────
//  1.  Add Anime — Search flow
// ────────────────────────────────────────────────────────────────────

/**
 * Search anime by title via the backend.
 * @param {string} query - The user's raw search input
 * @param {number} [limit=25] - Max results
 * @returns {Promise<{query: string, count: number, results: Array}>}
 */
export async function backendSearch(query, limit = 25) {
  return localFetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query.trim(), limit }),
  });
}

/**
 * Get franchise relations for a selected MAL ID.
 * @param {number} malId
 * @returns {Promise<{main: Object, relations: Array}>}
 */
export async function backendGetRelations(malId) {
  return localFetch(`/api/franchise/relations/${malId}`);
}

/**
 * Save the user's franchise selection. Backend fetches full metadata for
 * every entry and returns a ready-to-store entry.
 * @param {number} mainMalId
 * @param {number[]} selectedMalIds - IDs the user checked (including mainMalId)
 * @returns {Promise<Object>} - The assembled franchise entry for IndexedDB
 */
export async function backendSaveFranchise(mainMalId, selectedMalIds) {
  return localFetch('/api/franchise/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      main_mal_id: mainMalId,
      selected_mal_ids: selectedMalIds,
    }),
  });
}


// ────────────────────────────────────────────────────────────────────
//  2.  Refresh flows
// ────────────────────────────────────────────────────────────────────

/**
 * Refresh a single anime entry via the backend gold-record pipeline.
 * @param {number} malId
 * @param {Object} [oldSeason] - Current season data for change detection
 * @returns {Promise<{mal_id, gold, season_patch, changes, refreshed_at}>}
 */
export async function backendRefreshSingle(malId, oldSeason = null) {
  return localFetch(`/api/refresh/single/${malId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_season: oldSeason }),
  });
}

/**
 * Batch refresh multiple entries.
 * @param {Array<{mal_id: number, old_season?: Object}>} entries
 * @returns {Promise<{requested, completed, results, errors}>}
 */
export async function backendRefreshBatch(entries) {
  return localFetch('/api/refresh/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
}

/**
 * Auto-refresh stale library entries (24h threshold).
 * @param {Array<{mal_id: number, last_jikan_update?: string, old_season?: Object}>} library
 * @param {number} [thresholdHours=24]
 * @param {number} [maxItems=5]
 * @returns {Promise<Object>}
 */
export async function backendAutoRefresh(library, thresholdHours = 24, maxItems = 5) {
  return localFetch('/api/refresh/auto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      library,
      threshold_hours: thresholdHours,
      max_items: maxItems,
    }),
  });
}
