/**
 * episodeSyncService.js — Replaces jikanSync.js
 * Handles dual-source background freshness sync:
 * 1. 24h metadata sync via Jikan
 * 2. 5m interval Next-Episode checks via AniList (Airing Anime Only)
 */

import { getState } from '../state.js';
import { getAnimeById as fetchJikanAnime, normalizeSeasonStatus } from './jikanClient.js';
import { graphqlFetch } from '../api.js';
import {
  applyResolvedFranchisePatch,
  getLightSyncCandidates,
  normalizeAnimeEntry,
  resolveFranchise,
} from './franchiseService.js';
import { normalizeAndCommitLibrary } from './libraryStateService.js';
import { processLiveUpdate } from './animeCardLiveUpdate.js';

let _jikanSyncTimer = null;
let _lightSyncTimer = null;
let _jikanStartupTimer = null;
let _lightStartupTimer = null;

const JIKAN_CHECK_INTERVAL_MS = 10 * 60 * 1000; // Check every 10 mins
const STALE_MS = 24 * 60 * 60 * 1000;     // 24h for general metadata

// Light Sync: 2.5 hours interval for active titles and franchise sequels
const LIGHT_SYNC_INTERVAL_MS = 2.5 * 60 * 60 * 1000; 

export function startEpisodeSync() {
  if (!_jikanSyncTimer) {
    if (!_jikanStartupTimer) {
      _jikanStartupTimer = setTimeout(() => {
        _jikanStartupTimer = null;
        runJikanSyncTick();
      }, 15000);
    }
    _jikanSyncTimer = setInterval(runJikanSyncTick, JIKAN_CHECK_INTERVAL_MS);
  }
  
  if (!_lightSyncTimer) {
    if (!_lightStartupTimer) {
      _lightStartupTimer = setTimeout(() => {
        _lightStartupTimer = null;
        runLightSyncTick();
      }, 5000);
    }
    _lightSyncTimer = setInterval(runLightSyncTick, LIGHT_SYNC_INTERVAL_MS);
  }
}

export function stopEpisodeSync() {
  if (_jikanStartupTimer) clearTimeout(_jikanStartupTimer);
  if (_lightStartupTimer) clearTimeout(_lightStartupTimer);
  if (_jikanSyncTimer) clearInterval(_jikanSyncTimer);
  if (_lightSyncTimer) clearInterval(_lightSyncTimer);
  _jikanStartupTimer = null;
  _lightStartupTimer = null;
  _jikanSyncTimer = null;
  _lightSyncTimer = null;
}

/** 1. JIKAN SYNC: Full metadata update for stale anime (1 per tick) */
async function runJikanSyncTick() {
  const library = getState('library') || [];
  if (library.length === 0) return;

  const now = Date.now();
  const staleEntry = getLightSyncCandidates(library)
    .sort((left, right) => {
      const leftTime = left.last_jikan_update ? new Date(left.last_jikan_update).getTime() : 0;
      const rightTime = right.last_jikan_update ? new Date(right.last_jikan_update).getTime() : 0;
      return leftTime - rightTime;
    })
    .find((a) => {
    const last = a.last_jikan_update ? new Date(a.last_jikan_update).getTime() : 0;
    return (now - last) > STALE_MS;
  });
  if (!staleEntry) return;

  try {
    const seasonId = staleEntry.selected_season_mal_id || staleEntry.root_mal_id;
    const fresh = await fetchJikanAnime(seasonId); // Uses apiFetch queue (priority: false)
    if (!fresh) return;

    const seasonKey = String(seasonId);
    const season = staleEntry.seasons?.[seasonKey] || Object.values(staleEntry.seasons || {})[0];

    const updatedSeason = {
      ...season,
      total_episodes: fresh.episodes || season?.total_episodes || 0,
      status: normalizeSeasonStatus(fresh.season_status || fresh.status, {
        airing: !!fresh.airing,
        fallback: season?.status || 'Unknown'
      }),
      airing: !!fresh.airing,
      title_english: fresh.title || season?.title_english,
      title_japanese: fresh.title_jp || season?.title_japanese,
    };

    let updated = {
      ...staleEntry,
      title_english: fresh.title || staleEntry.title_english,
      title_japanese: fresh.title_jp || staleEntry.title_japanese,
      last_jikan_update: new Date().toISOString(),
      seasons: { ...staleEntry.seasons, [seasonKey]: updatedSeason },
    };

    const fRes = await resolveFranchise(updated, library);
    updated = fRes ? applyResolvedFranchisePatch(updated, fRes, library) : normalizeAnimeEntry(updated);

    const nextLibrary = library.map((a) => a.root_mal_id === staleEntry.root_mal_id ? updated : a);
    await normalizeAndCommitLibrary(library, nextLibrary, [updated.root_mal_id], { persistMode: 'immediate' });
    console.log(`[Sync] Full 24h metadata update for "${updated.title_english}" (Jikan).`);
  } catch (err) {
    console.warn('Jikan metadata sync failed:', err);
  }
}

/** 2. LIGHT SYNC: 2-4h check specifically for active titles and franchise candidates */
export async function runLightSyncTick() {
  const library = getState('library') || [];

  // Filter set for light sync:
  // 1. User has watched part of the franchise
  // 2. Franchise has sequel metadata / relations
  // 3. Recently active titles
  const targetTitles = getLightSyncCandidates(library);

  if (targetTitles.length === 0) return;

  try {
    const aniListMap = await fetchFromAniList(targetTitles);
    if (!aniListMap) return;

    let changed = false;
    let updatedLibrary = [...library];

    for (let i = 0; i < updatedLibrary.length; i++) {
      const anime = updatedLibrary[i];
      const seasonId = Number(anime.selected_season_mal_id || anime.root_mal_id);
      const seasonKey = String(seasonId);
      const aniListData = aniListMap[seasonId];
      if (!aniListData) continue;

      const season = anime.seasons?.[seasonKey] || Object.values(anime.seasons || {})[0];
      if (!season) continue;

      const status = normalizeSeasonStatus(aniListData.status, {
        airing: !!aniListData.nextAiringAtMs,
        fallback: season.status || 'Unknown'
      });

      const nextAiringAt = status === 'Currently Airing' ? (aniListData.nextAiringAtMs || null) : null;
      const nextEpisodeNumber = status === 'Currently Airing' ? (aniListData.nextEpNum || null) : null;
      let totalEpisodes = Math.max(season.total_episodes || 0, aniListData.totalEpisodes || 0);
      let airedEpisodes = season.aired_episodes || 0;

      if (status === 'Currently Airing' && nextEpisodeNumber) {
         airedEpisodes = nextEpisodeNumber - 1;
         // Ensure total_episodes is at least aired + 1
         if (totalEpisodes <= airedEpisodes) {
             totalEpisodes = airedEpisodes + 1;
         }
      }

      const updatedSeason = {
        ...season,
        total_episodes: totalEpisodes,
        aired_episodes: airedEpisodes,
        status,
        airing: status === 'Currently Airing',
        next_episode_airing_at: nextAiringAt,
        next_episode_number: nextEpisodeNumber,
        season_label: season.season_label || aniListData.seasonLabel || '',
        season_year: season.season_year || aniListData.seasonYear || null,
      };

      const seasonChanged =
        updatedSeason.total_episodes !== season.total_episodes ||
        updatedSeason.aired_episodes !== season.aired_episodes ||
        updatedSeason.status !== season.status ||
        updatedSeason.airing !== season.airing ||
        updatedSeason.next_episode_airing_at !== season.next_episode_airing_at ||
        updatedSeason.next_episode_number !== season.next_episode_number ||
        updatedSeason.season_label !== season.season_label ||
        updatedSeason.season_year !== season.season_year;

      if (!seasonChanged) continue;

      let updatedAnime = {
        ...anime,
        seasons: { ...anime.seasons, [seasonKey]: updatedSeason },
        updated_date: new Date().toISOString(),
      };

      if (shouldRefreshFranchiseMetadata(updatedAnime)) {
        const resolved = await resolveFranchise(updatedAnime, updatedLibrary);
        updatedAnime = resolved ? applyResolvedFranchisePatch(updatedAnime, resolved, updatedLibrary) : normalizeAnimeEntry(updatedAnime);
      } else {
        updatedAnime = normalizeAnimeEntry(updatedAnime);
      }

      updatedLibrary[i] = updatedAnime;
      changed = true;
    }

    if (changed) {
      await normalizeAndCommitLibrary(library, updatedLibrary, targetTitles.map((entry) => entry.root_mal_id), { persistMode: 'immediate' });
      
      // Trigger live card updates for changed anime
      for (const updatedAnime of updatedLibrary) {
        const originalAnime = library.find(a => a.root_mal_id === updatedAnime.root_mal_id);
        if (originalAnime) {
          // Process live update for card refresh
          await processLiveUpdate(originalAnime, updatedAnime, 'anilist');
        }
      }
      
      console.log(`[Sync] Light AniList sync updated ${targetTitles.length} active/franchise titles.`);
    }
  } catch (err) {
    console.warn('[Sync] Light sync failed:', err);
  }
}

/** 
 * Modular Fetcher: AniList (AniChart Backend) 
 * Returns { [mal_id]: { nextAiringAtMs, nextEpNum, totalEpisodes, status, seasonLabel, seasonYear } }
 */
export async function fetchFromAniList(airingTitles) {
  const idMals = [...new Set(airingTitles.map(a => a.selected_season_mal_id || a.root_mal_id).map(Number).filter(Boolean))];
  const query = `
    query ($idMals: [Int]) {
      Page {
        media(idMal_in: $idMals, type: ANIME) {
          idMal
          episodes
          status
          season
          seasonYear
          nextAiringEpisode {
            episode
            timeUntilAiring
            airingAt
          }
        }
      }
    }
  `;

  const res = await graphqlFetch(query, { idMals }, true);
  if (!res?.data?.Page?.media) return null;

  const result = {};
  for (const anilistData of res.data.Page.media) {
    result[anilistData.idMal] = {
      totalEpisodes: anilistData.episodes,
      status: anilistData.status,
      seasonLabel: anilistData.season,
      seasonYear: anilistData.seasonYear,
      nextAiringAtMs: anilistData.nextAiringEpisode ? anilistData.nextAiringEpisode.airingAt * 1000 : null,
      nextEpNum: anilistData.nextAiringEpisode ? anilistData.nextAiringEpisode.episode : null
    };
  }
  return result;
}

function shouldRefreshFranchiseMetadata(anime) {
  if (!anime?.franchise_id) return true;
  if (!anime?.franchise_cache_updated_at) return true;
  const age = Date.now() - new Date(anime.franchise_cache_updated_at).getTime();
  return !Number.isFinite(age) || age > (7 * 24 * 60 * 60 * 1000);
}
