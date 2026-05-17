/**
 * jikanSync.js — Background freshness sync for Jikan data with One Piece fallback.
 */

import { getState, setState } from '../state.js';
import { getAnimeById as fetchJikanAnime, normalizeSeasonStatus } from './jikanClient.js';
import { saveAnime } from '../storage.js';

let _syncTimer = null;
let _syncStartupTimer = null;
const ONE_PIECE_MAL_ID = 21;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const STALE_MS = 24 * 60 * 60 * 1000;     // 24h

export function startJikanSync() {
  if (_syncTimer) return;
  // start shortly after boot to avoid competing with initial render
  if (!_syncStartupTimer) {
    _syncStartupTimer = setTimeout(() => {
      _syncStartupTimer = null;
      runSyncTick();
    }, 7000);
  }
  _syncTimer = setInterval(runSyncTick, CHECK_INTERVAL_MS);
}

export function stopJikanSync() {
  if (_syncStartupTimer) clearTimeout(_syncStartupTimer);
  if (_syncTimer) clearInterval(_syncTimer);
  _syncStartupTimer = null;
  _syncTimer = null;
}

async function runSyncTick() {
  const library = getState('library') || [];
  if (library.length === 0) return;

  // pick the stalest entry
  const now = Date.now();
  const staleEntry = library.find(a => {
    const last = a.last_jikan_update ? new Date(a.last_jikan_update).getTime() : 0;
    return (now - last) > STALE_MS;
  });
  if (!staleEntry) return;
  await refreshEntry(staleEntry);
}

async function refreshEntry(anime) {
  try {
    const seasonId = anime.selected_season_mal_id || anime.root_mal_id;
    const seasonKey = String(seasonId);
    const season = anime.seasons?.[seasonKey] || Object.values(anime.seasons || {})[0];

    let fresh = null;
    try { fresh = await fetchJikanAnime(seasonId); } catch { /* noop */ }

    // One Piece special-case
    const isOnePiece = seasonId === ONE_PIECE_MAL_ID ||
      anime.root_mal_id === ONE_PIECE_MAL_ID ||
      (anime.title_english || '').toLowerCase() === 'one piece';

    let totalEpisodes = season?.total_episodes || 0;
    let airing = season?.status === 'Currently Airing';

    if (fresh) {
      totalEpisodes = fresh.episodes || totalEpisodes;
      airing = !!fresh.airing || airing;
    }

    if (isOnePiece) {
      const fallback = await fetchOnePieceEpisodeCount();
      if (fallback > 0) {
        totalEpisodes = fallback;
        airing = true;
      } else {
        // dynamic growth: allow user progress to extend without cap
        totalEpisodes = Math.max(totalEpisodes, (season?.progress || 0) + 1000);
        airing = true;
      }
    }

    const updatedSeason = {
      ...season,
      total_episodes: totalEpisodes,
      status: normalizeSeasonStatus(fresh?.season_status || fresh?.status, {
        airing,
        fallback: season?.status || 'Unknown'
      }),
      airing,
      title_english: fresh?.title || season?.title_english,
      title_japanese: fresh?.title_jp || season?.title_japanese,
    };

    const updated = {
      ...anime,
      title_english: fresh?.title || anime.title_english,
      title_japanese: fresh?.title_jp || anime.title_japanese,
      last_jikan_update: new Date().toISOString(),
      seasons: { ...anime.seasons, [seasonKey]: updatedSeason },
    };

    await saveAnime(updated);
    const lib = (getState('library') || []).map(a => a.root_mal_id === anime.root_mal_id ? updated : a);
    setState('library', lib);
  } catch (err) {
    console.warn('Jikan sync failed:', err);
  }
}

async function fetchOnePieceEpisodeCount() {
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
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { idMal: ONE_PIECE_MAL_ID } }),
    });
    if (!res.ok) throw new Error('AniList request failed');
    const data = await res.json();
    const media = data?.data?.Media;
    if (!media) return 0;
    const episodes = media.episodes || 0;
    const nextEp = media.nextAiringEpisode?.episode;
    if (nextEp && nextEp > episodes) return nextEp - 1;
    return episodes;
  } catch {
    return 0;
  }
}
