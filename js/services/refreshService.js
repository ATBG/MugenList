/**
 * refreshService.js — Smart 24-hour background refresh with change detection
 * 
 * v2: Backend-driven refresh is now the primary path.
 * The frontend sends the library snapshot to the backend, which performs
 * the 3-API gold-standard reconciliation and returns season patches.
 * Legacy client-side refresh is preserved as a fallback.
 */

import { getState, setState, getSeasonsArray } from '../state.js';
import { getAnimeByRootId, saveAnime } from '../storage.js';
import { getAnimeById as fetchJikanAnime, normalizeSeasonStatus } from './jikanClient.js';
import { addNotification } from './notificationSystem.js';
import { fetchFromAniList } from './episodeSyncService.js';
import {
  applyResolvedFranchisePatch,
  getLightSyncCandidates,
  normalizeAnimeEntry,
  resolveFranchise,
} from './franchiseService.js';
import { normalizeAndCommitLibrary } from './libraryStateService.js';
import { graphqlFetch } from '../api.js';
import { backendRefreshSingle, backendRefreshBatch, backendAutoRefresh } from './backendSearchService.js';
import { applyRefreshPatch } from './animeManager.js';

const ONE_PIECE_MAL_ID = 21;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // check every hour if anything needs refreshing
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

let _refreshTimer = null;
let _refreshStartupTimer = null;
let _isRefreshing = false;

// Track what we've already notified about to prevent duplicate notifications
const _notificationCache = new Map(); // key: `${rootMalId}_${field}` -> lastNotifyTime

/**
 * Start the background refresh service
 */
export function startRefreshService() {
  if (_refreshTimer) return;
  console.log('🔄 Refresh service starting...');
  
  // Initial check after app startup
  if (!_refreshStartupTimer) {
    _refreshStartupTimer = setTimeout(() => {
      _refreshStartupTimer = null;
      runRefreshCycle();
    }, 10000);
  }
  
  // Periodic checks
  _refreshTimer = setInterval(runRefreshCycle, REFRESH_INTERVAL_MS);
}

/**
 * Stop the refresh service
 */
export function stopRefreshService() {
  if (_refreshStartupTimer) {
    clearTimeout(_refreshStartupTimer);
    _refreshStartupTimer = null;
  }
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
    console.log('🛑 Refresh service stopped');
  }
}

/**
 * Main refresh cycle: find stale entries and refresh them
 */
async function runRefreshCycle() {
  if (_isRefreshing) return;
  _isRefreshing = true;
  
  try {
    const library = getState('library') || [];
    if (library.length === 0) return;

    // --- Try backend-driven auto-refresh first ---
    try {
      const snapshot = library.map(a => {
        const season = a.seasons?.[String(a.selected_season_mal_id)] || Object.values(a.seasons || {})[0];
        return {
          mal_id: a.selected_season_mal_id || a.root_mal_id,
          last_jikan_update: a.last_jikan_update || null,
          old_season: season || null,
        };
      });

      const result = await backendAutoRefresh(snapshot, 24, 5);

      if (result && result.completed > 0) {
        // Apply patches from backend
        for (const [malIdStr, refreshResult] of Object.entries(result.results || {})) {
          const malId = Number(malIdStr);
          if (!refreshResult?.season_patch) continue;
          const anime = library.find(a => (
            a.selected_season_mal_id === malId || a.root_mal_id === malId
          ));
          if (!anime) continue;
          await applyRefreshPatch(anime.root_mal_id, malId, refreshResult.season_patch);

          // Emit notifications for changes
          for (const change of (refreshResult.changes || [])) {
            emitChangeNotification(anime, change);
          }
        }
        console.log(`✨ Backend auto-refresh: ${result.completed} updated, ${result.stale_count} stale`);
        return;  // Backend handled it
      }
    } catch (backendErr) {
      console.warn('⚠️ Backend auto-refresh unavailable, falling back to legacy:', backendErr.message);
    }

    // --- Legacy fallback (client-side refresh) ---
    const now = Date.now();
    let refreshedCount = 0;
    const candidates = getLightSyncCandidates(library)
      .filter((anime) => {
        const lastUpdate = anime.last_jikan_update ? new Date(anime.last_jikan_update).getTime() : 0;
        return (now - lastUpdate) > STALE_THRESHOLD_MS;
      })
      .sort((left, right) => {
        const leftTime = left.last_jikan_update ? new Date(left.last_jikan_update).getTime() : 0;
        const rightTime = right.last_jikan_update ? new Date(right.last_jikan_update).getTime() : 0;
        return leftTime - rightTime;
      })
      .slice(0, 3);

    for (const anime of candidates) {
      await refreshAnimeEntry(anime);
      refreshedCount++;
    }

    if (refreshedCount > 0) {
      console.log(`✨ Legacy refreshed ${refreshedCount} anime from Jikan`);
    }
  } catch (err) {
    console.warn('Refresh cycle error:', err);
  } finally {
    _isRefreshing = false;
  }
}

/**
 * Manual Library Sync with controlled parallel processing
 */
/**
 * Manual sync for library. Accepts either a callback `onProgress` or
 * an explicit `items` array followed by `onProgress`.
 * Usage:
 *  manualLibrarySync(onProgress)
 *  manualLibrarySync(itemsArray, onProgress)
 */
export async function manualLibrarySync(itemsOrCallback, maybeCallback) {
  let library = null;
  let onProgress = null;

  if (Array.isArray(itemsOrCallback)) {
    library = itemsOrCallback;
    onProgress = maybeCallback || null;
  } else {
    onProgress = itemsOrCallback || null;
    library = getState('library') || [];
  }
  if (library.length === 0) {
    if (onProgress) onProgress({ completed: 0, total: 0, current: 'Library empty' });
    return { updated: 0, errors: 0 };
  }

  const total = library.length;
  let completed = 0;
  let updatedCount = 0;
  let errorCount = 0;
  const CONCURRENCY = 3; // Respecting rate limits (keep conservative)

  const queue = [...library];

  const worker = async () => {
    while (queue.length > 0) {
      const anime = queue.shift();
      const currentLabel = anime.title_english || anime.title_japanese || 'Unknown';

      if (onProgress) onProgress({ completed, total, current: currentLabel, changed: false });

      try {
        const result = await refreshAnimeEntry(anime, true); // true = retry enabled
        const changed = !!result?.changed;
        if (changed) updatedCount++;
        completed++;

        if (onProgress) onProgress({ completed, total, current: currentLabel, changed });
      } catch (err) {
        console.error(`Manual sync failed for ${currentLabel}:`, err);
        errorCount++;
        completed++;
        if (onProgress) onProgress({ completed, total, current: currentLabel, changed: false, error: err.message || String(err) });
      }

      if (onProgress) onProgress({ completed, total, current: queue[0]?.title_english || 'Finishing...' });
    }
  };

  const pool = Array(Math.min(CONCURRENCY, total)).fill(null).map(() => worker());
  await Promise.all(pool);

  return { updated: updatedCount, errors: errorCount };
}

/**
 * Refresh a single anime entry with change detection
 */
/**
 * Refresh a single anime entry with change detection
 * @param {Object} anime - The anime object
 * @param {Boolean} allowRetry - Whether to retry once on failure
 */
async function refreshAnimeEntry(anime, allowRetry = false) {
  try {
    const seasonId = anime.selected_season_mal_id || anime.root_mal_id;
    const seasonKey = String(seasonId);
    const oldSeason = anime.seasons?.[seasonKey] || Object.values(anime.seasons || {})[0];

    if (!oldSeason) return { changed: false };

    // 1. Fetch fresh data from Jikan (metadata)
    let freshData = null;
    const fetchJikan = async () => {
      try {
        return await fetchJikanAnime(seasonId);
      } catch (err) {
        if (allowRetry) {
          console.log(`Retrying Jikan fetch for ${anime.title_english}...`);
          return await fetchJikanAnime(seasonId);
        }
        throw err;
      }
    };

    try {
      freshData = await fetchJikan();
    } catch (err) {
      console.warn(`⚠️ Jikan fetch failed for ${anime.title_english} (${seasonId}):`, err);
      // If Jikan fails, we still might want to check AniList if it's airing, 
      // but usually Jikan is the source of truth for "root" metadata.
    }

    // 2. Fetch from AniList if it's currently airing (for precise countdown)
    let aniListData = null;
    const isAiring = !!freshData?.airing || oldSeason.status === 'Currently Airing';
    
    if (isAiring) {
      try {
        const aniMap = await fetchFromAniList([anime]);
        aniListData = aniMap ? aniMap[seasonId] : null;
      } catch (err) {
        if (allowRetry) {
          try {
            const aniMap = await fetchFromAniList([anime]);
            aniListData = aniMap ? aniMap[seasonId] : null;
          } catch (e) { console.warn('AniList retry failed for', anime.root_mal_id, e); }
        }
      }
    }

    // For One Piece special case
    const isOnePiece = seasonId === ONE_PIECE_MAL_ID || 
                       anime.root_mal_id === ONE_PIECE_MAL_ID ||
                       (anime.title_english || '').toLowerCase().includes('one piece');

    let fallbackEpisodes = null;
    if (isOnePiece && (!freshData?.episodes || freshData.episodes === 0)) {
       // reuse aniListData if we have it, else fallback
       fallbackEpisodes = aniListData?.totalEpisodes || await fetchOnePieceFromAniList();
    }

    // 3. Compute new season metadata
    const normalizedStatus = normalizeSeasonStatus(
      aniListData?.status || freshData?.season_status || freshData?.status,
      {
        airing: !!aniListData?.nextAiringAtMs || !!freshData?.airing,
        fallback: oldSeason.status || 'Unknown'
      }
    );

    const newSeason = {
      ...oldSeason,
      total_episodes: aniListData?.totalEpisodes || fallbackEpisodes || freshData?.episodes || oldSeason.total_episodes,
      aired_episodes: freshData?.episodes || oldSeason.aired_episodes,
      status: normalizedStatus,
      title_english: freshData?.title || oldSeason.title_english,
      title_japanese: freshData?.title_jp || oldSeason.title_japanese,
      airing: normalizedStatus === 'Currently Airing',
      
      // Countdown integration
      next_episode_airing_at: aniListData?.nextAiringAtMs || null,
      next_episode_number: aniListData?.nextEpNum || null
    };

    // If it's NOT airing, ensure countdown is removed
    if (!newSeason.airing || newSeason.status === 'Finished Airing') {
      newSeason.next_episode_airing_at = null;
      newSeason.next_episode_number = null;
    }

    // One Piece: ensure total_episodes never goes below user's progress
    if (isOnePiece && newSeason.total_episodes < (oldSeason.progress || 0)) {
      newSeason.total_episodes = (oldSeason.progress || 0) + 1;
      newSeason.airing = true;
    }

    // Detect changes
    const changes = detectChanges(oldSeason, newSeason, anime);

    // Only update if changes found
    if (changes.length === 0) {
      await updateRefreshTimestamp(anime.root_mal_id);
      return { changed: false };
    }

    // Create updated entry
    let updatedEntry = {
      ...anime,
      seasons: { ...anime.seasons, [seasonKey]: newSeason },
      title_english: freshData?.title || anime.title_english,
      title_japanese: freshData?.title_jp || anime.title_japanese,
      last_jikan_update: new Date().toISOString(),
    };

    const library = getState('library') || [];
    const resolved = await resolveFranchise(updatedEntry, library);
    updatedEntry = resolved ? applyResolvedFranchisePatch(updatedEntry, resolved, library) : normalizeAnimeEntry(updatedEntry);

    // Update state
    const updated = library.map(a => a.root_mal_id === anime.root_mal_id ? updatedEntry : a);
    await normalizeAndCommitLibrary(library, updated, [anime.root_mal_id], { persistMode: 'immediate' });

    // Emit notifications
    for (const change of changes) {
      emitChangeNotification(anime, change);
    }

    console.log(`📝 Updated ${anime.title_english}: ${changes.map(c => c.type).join(', ')}`);
    return { changed: true };
  } catch (err) {
    console.warn('Anime refresh error:', err);
    throw err;
  }
}

/**
 * Detect changes between old and new season data
 * Returns array of change objects: { type, oldValue, newValue }
 */
function detectChanges(oldSeason, newSeason, anime) {
  const changes = [];

  // Episode count changed
  const oldEps = oldSeason.total_episodes || 0;
  const newEps = newSeason.total_episodes || 0;
  if (newEps > oldEps) {
    changes.push({
      type: 'episode_increase',
      field: 'total_episodes',
      oldValue: oldEps,
      newValue: newEps,
    });
  }

  // Status changed
  const oldStatus = oldSeason.status || '';
  const newStatus = newSeason.status || '';
  if (oldStatus !== newStatus && newStatus) {
    changes.push({
      type: 'status_changed',
      field: 'status',
      oldValue: oldStatus,
      newValue: newStatus,
    });
  }

  // Airing status changed
  const wasAiring = oldSeason.airing;
  const isNowAiring = newSeason.airing;
  if (wasAiring !== isNowAiring && isNowAiring) {
    changes.push({
      type: 'started_airing',
      field: 'airing',
      oldValue: wasAiring,
      newValue: isNowAiring,
    });
  }

  return changes;
}

/**
 * Emit a notification for a detected change
 * Deduplicates based on type, anime, and time
 */
function emitChangeNotification(anime, change) {
  const cacheKey = `${anime.root_mal_id}_${change.type}`;
  const lastNotify = _notificationCache.get(cacheKey) || 0;
  const now = Date.now();

  // Don't notify about same change more than once per hour
  if ((now - lastNotify) < 60 * 60 * 1000) return;

  _notificationCache.set(cacheKey, now);

  let notifType, title, details = '';

  switch (change.type) {
    case 'episode_increase':
      notifType = 'new_episode';
      title = `New episodes: ${anime.title_english}`;
      details = `${change.oldValue} → ${change.newValue} episodes`;
      break;

    case 'status_changed':
      notifType = 'status_changed';
      title = `Status updated: ${anime.title_english}`;
      details = `${change.oldValue} → ${change.newValue}`;
      break;

    case 'started_airing':
      notifType = 'started_airing';
      title = `Now airing: ${anime.title_english}`;
      details = 'The series has started broadcasting';
      break;

    default:
      return;
  }

  addNotification(notifType, title, anime, details);
}

/**
 * Update the last refresh timestamp for an anime (silent refresh)
 */
async function updateRefreshTimestamp(rootMalId) {
  const anime = await getAnimeByRootId(rootMalId);
  if (!anime) return;

  const updated = {
    ...anime,
    last_jikan_update: new Date().toISOString(),
  };

  await saveAnime(updated);
  
  const library = getState('library') || [];
  const updatedLib = library.map(a => a.root_mal_id === rootMalId ? updated : a);
  setState('library', updatedLib);
}

/**
 * Fetch One Piece episode count from AniList GraphQL
 * Used as fallback when Jikan returns 0 or missing
 */
async function fetchOnePieceFromAniList() {
  const query = `
    query ($idMal: Int) {
      Media(idMal: $idMal, type: ANIME) {
        episodes
        status
        nextAiringEpisode { episode }
      }
    }
  `;

  try {
    const data = await graphqlFetch(query, { idMal: ONE_PIECE_MAL_ID }, true);
    const media = data?.data?.Media;
    
    if (!media) return null;

    const episodes = media.episodes || 0;
    const nextEp = media.nextAiringEpisode?.episode;

    // If there's a next airing episode, use that as the real count
    if (nextEp && nextEp > episodes) {
      return nextEp - 1;
    }

    return episodes > 0 ? episodes : null;
  } catch (err) {
    console.warn('AniList fetch failed:', err);
    return null;
  }
}

/**
 * Manually trigger a refresh for a specific anime (used by UI)
 */
export async function refreshAnimeNow(rootMalId) {
  const library = getState('library') || [];
  const anime = library.find(a => a.root_mal_id === Number(rootMalId));
  
  if (!anime) return;

  try {
    return await refreshAnimeEntry(anime, true);
  } catch (err) {
    console.error('Manual refresh failed:', err);
    throw err;
  }
}

/**
 * Get the time until next refresh for an anime
 */
export function getTimeUntilNextRefresh(anime) {
  if (!anime) return null;

  const lastUpdate = anime.last_jikan_update 
    ? new Date(anime.last_jikan_update).getTime() 
    : 0;
  
  const nextRefresh = lastUpdate + STALE_THRESHOLD_MS;
  const now = Date.now();

  if (now >= nextRefresh) return 0;
  return nextRefresh - now;
}

/**
 * Get refresh status for UI display
 */
export function getRefreshStatus(anime) {
  const timeUntil = getTimeUntilNextRefresh(anime);
  
  if (timeUntil === null) return 'never';
  if (timeUntil === 0) return 'ready';
  
  const hours = Math.ceil(timeUntil / (60 * 60 * 1000));
  return `${hours}h`;
}

// ────────────────────────────────────────────────────────────────────
//  Backend-driven refresh API (new primary path)
// ────────────────────────────────────────────────────────────────────

/**
 * Refresh a single anime via the backend gold-record pipeline.
 * Falls back to the legacy client-side refresh if backend is down.
 */
export async function refreshAnimeViaBackend(rootMalId) {
  const library = getState('library') || [];
  const anime = library.find(a => a.root_mal_id === Number(rootMalId));
  if (!anime) return;

  const seasonId = anime.selected_season_mal_id || anime.root_mal_id;
  const seasonKey = String(seasonId);
  const oldSeason = anime.seasons?.[seasonKey] || Object.values(anime.seasons || {})[0];

  try {
    const result = await backendRefreshSingle(seasonId, oldSeason);
    if (result?.season_patch) {
      await applyRefreshPatch(anime.root_mal_id, seasonId, result.season_patch);
      for (const change of (result.changes || [])) {
        emitChangeNotification(anime, change);
      }
      return { changed: (result.changes || []).length > 0 };
    }
    return { changed: false };
  } catch (err) {
    console.warn('Backend refresh failed, trying legacy:', err.message);
    return refreshAnimeNow(rootMalId);
  }
}

/**
 * Manual library sync via the backend batch refresh.
 * Falls back to legacy manualLibrarySync on failure.
 */
export async function manualLibrarySyncViaBackend(onProgress) {
  const library = getState('library') || [];
  if (library.length === 0) {
    if (onProgress) onProgress({ completed: 0, total: 0, current: 'Library empty' });
    return { updated: 0, errors: 0 };
  }

  const total = library.length;
  if (onProgress) onProgress({ completed: 0, total, current: 'Sending to backend...' });

  try {
    const entries = library.map(a => {
      const seasonId = a.selected_season_mal_id || a.root_mal_id;
      const season = a.seasons?.[String(seasonId)] || Object.values(a.seasons || {})[0];
      return { mal_id: seasonId, old_season: season || null };
    });

    const result = await backendRefreshBatch(entries);

    let updatedCount = 0;
    let completed = 0;

    for (const [malIdStr, refreshResult] of Object.entries(result.results || {})) {
      const malId = Number(malIdStr);
      if (!refreshResult?.season_patch) { completed++; continue; }

      const anime = library.find(a => (
        a.selected_season_mal_id === malId || a.root_mal_id === malId
      ));
      if (!anime) { completed++; continue; }

      await applyRefreshPatch(anime.root_mal_id, malId, refreshResult.season_patch);
      
      const hasChanges = (refreshResult.changes || []).length > 0;
      if (hasChanges) updatedCount++;
      for (const change of (refreshResult.changes || [])) {
        emitChangeNotification(anime, change);
      }

      completed++;
      if (onProgress) onProgress({
        completed, total, current: anime.title_english || 'Unknown', changed: hasChanges
      });
    }

    if (onProgress) onProgress({ completed: total, total, current: 'Done!' });
    return { updated: updatedCount, errors: Object.keys(result.errors || {}).length };
  } catch (err) {
    console.warn('Backend batch sync failed, falling back to legacy:', err.message);
    return manualLibrarySync(onProgress);
  }
}
