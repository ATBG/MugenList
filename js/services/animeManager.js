/**
 * animeManager.js — CRUD service for v2 schema
 * Seasons stored as object keyed by mal_id (string)
 */

import { storageQueue } from './storageQueue.js';
import { setState, getState, computeWatchStatus, getSeasonsArray, getRootDisplayTitle } from '../state.js';
import { showToast } from '../utils.js';
import {
  applyResolvedFranchisePatch,
  normalizeAnimeEntry,
  resolveFranchise,
} from './franchiseService.js';
import { normalizeSeasonStatus } from './jikanClient.js';
import { normalizeAndCommitLibrary } from './libraryStateService.js';

const NOW = () => new Date().toISOString();

// ---------- Read ----------

export function getAnime(rootMalId) {
  const library = getState('library');
  return library.find(a => a.root_mal_id === Number(rootMalId)) || null;
}

export function getSelectedSeason(anime) {
  if (!anime) return null;
  return anime.seasons[String(anime.selected_season_mal_id)] ||
    Object.values(anime.seasons)[0] ||
    null;
}

// ---------- Season Selection ----------

export async function setSelectedSeason(rootMalId, seasonMalId) {
  const library = getState('library');
  const idx = library.findIndex(a => a.root_mal_id === Number(rootMalId));
  if (idx < 0) return;
  const updated = [...library];
  updated[idx] = {
    ...updated[idx],
    selected_season_mal_id: Number(seasonMalId),
    updated_date: NOW(),
  };
  const { library: normalized } = await normalizeAndCommitLibrary(library, updated, [rootMalId]);
  return normalized.find((entry) => entry.root_mal_id === Number(rootMalId)) || updated[idx];
}

// ---------- Progress Update ----------

export async function updateProgress(rootMalId, seasonMalId, value) {
  const library = getState('library');
  const idx = library.findIndex(a => a.root_mal_id === Number(rootMalId));
  if (idx < 0) return;

  const anime = library[idx];
  const sid = String(seasonMalId);
  const season = anime.seasons[sid];
  if (!season) return;

  const settings = getState('settings');
  const total = season.total_episodes || 0;
  const clamped = Math.max(0, Math.min(value, total || 9999));
  
  let watch_status = season.watch_status;
  let has_new_episode = season.has_new_episode;
  
  // Clear "new episode" highlight if the user catches up
  if (has_new_episode && clamped >= season.total_episodes) {
    has_new_episode = false;
  }
  
  // Smart status automation
  if (settings?.auto_update_status !== false && !season._status_overridden) {
    const computed = computeWatchStatus(clamped, total, season.watch_status);
    if (computed !== season.watch_status) {
      watch_status = computed;
      const statusLabel = computed.replace(/_/g, ' ');
      const verb = computed === 'completed' ? 'Auto-completed' : 'Auto-updated to';
      showToast(`✨ ${verb} ${statusLabel}`, 'success');
    }
  }

  const updatedSeason = {
    ...season,
    progress: clamped,
    watch_status,
    has_new_episode,
    updated_date: NOW(),
    last_progress_update: NOW(),
    last_watched_at: clamped > 0 ? NOW() : (season.last_watched_at || null),
    started_watching_date: season.started_watching_date || (clamped > 0 ? NOW() : null),
  };

  const updated = [...library];
  updated[idx] = {
    ...anime,
    seasons: { ...anime.seasons, [sid]: updatedSeason },
    updated_date: NOW(),
  };

  const { library: normalized } = await normalizeAndCommitLibrary(library, updated, [rootMalId]);
  return normalized.find((entry) => entry.root_mal_id === Number(rootMalId)) || updated[idx];
}

export async function incrementProgress(rootMalId, seasonMalId) {
  const anime = getAnime(rootMalId);
  if (!anime) return;
  const season = anime.seasons[String(seasonMalId)];
  if (!season) return;
  return updateProgress(rootMalId, seasonMalId, (season.progress || 0) + 1);
}

export async function decrementProgress(rootMalId, seasonMalId) {
  const anime = getAnime(rootMalId);
  if (!anime) return;
  const season = anime.seasons[String(seasonMalId)];
  if (!season) return;
  return updateProgress(rootMalId, seasonMalId, (season.progress || 0) - 1);
}

// ---------- Add ----------

export async function addAnimeEntry(jikanData) {
  const library = getState('library');
  const rootId = Number(jikanData.mal_id);

  // Don't duplicate
  if (library.some(a => a.root_mal_id === rootId)) {
    showToast('Already in library', 'info');
    return null;
  }

  const season = buildSeasonEntry(jikanData);
  let entry = {
    root_mal_id: rootId,
    selected_season_mal_id: rootId,
    title_japanese: jikanData.title_jp || jikanData.title || '',
    title_english: jikanData.title || jikanData.title_jp || '',
    genres: jikanData.genres || [],
    poster_url: jikanData.poster || '',
    user_poster: null,
    added_date: NOW(),
    updated_date: NOW(),
    last_jikan_update: NOW(),
    franchise_id: null,
    is_sequel_confirmed: false,
    seasons: { [String(rootId)]: season },
  };

  // Immediate franchise resolution
  const fRes = await resolveFranchise(entry, library);
  if (fRes) {
    entry = applyResolvedFranchisePatch(entry, fRes, [...library, entry]);
  } else {
    entry = normalizeAnimeEntry(entry);
  }

  const { library: normalized } = await normalizeAndCommitLibrary(library, [...library, entry], [rootId]);
  showToast(`Added "${getRootDisplayTitle(entry)}"`, 'success');
  return normalized.find((item) => item.root_mal_id === rootId) || entry;
}

export async function addSeasonToEntry(rootMalId, jikanData) {
  const library = getState('library');
  const idx = library.findIndex(a => a.root_mal_id === Number(rootMalId));
  if (idx < 0) throw new Error('Root entry not found');

  const anime = library[idx];
  const sid = String(jikanData.mal_id);
  if (anime.seasons[sid]) {
    showToast('Season already exists', 'info');
    return anime;
  }

  const season = buildSeasonEntry(jikanData);
  const updated = [...library];
  updated[idx] = {
    ...anime,
    seasons: { ...anime.seasons, [sid]: season },
    updated_date: NOW(),
  };

  const resolved = await resolveFranchise(updated[idx], updated);
  if (resolved) {
    updated[idx] = applyResolvedFranchisePatch(updated[idx], resolved, updated);
  } else {
    updated[idx] = normalizeAnimeEntry(updated[idx]);
  }

  const { library: normalized } = await normalizeAndCommitLibrary(library, updated, [rootMalId]);
  showToast('Season added', 'success');
  return normalized.find((entry) => entry.root_mal_id === Number(rootMalId)) || updated[idx];
}

// ---------- Update ----------

export async function updateAnimeField(rootMalId, patch) {
  const library = getState('library');
  const idx = library.findIndex(a => a.root_mal_id === Number(rootMalId));
  if (idx < 0) return;
  const updated = [...library];
  updated[idx] = { ...updated[idx], ...patch, updated_date: NOW() };
  const { library: normalized } = await normalizeAndCommitLibrary(library, updated, [rootMalId]);
  return normalized.find((entry) => entry.root_mal_id === Number(rootMalId)) || updated[idx];
}

export async function updateSeasonField(rootMalId, seasonMalId, patch) {
  const library = getState('library');
  const idx = library.findIndex(a => a.root_mal_id === Number(rootMalId));
  if (idx < 0) return;
  const anime = library[idx];
  const sid = String(seasonMalId);
  if (!anime.seasons[sid]) return;
  if (patch && 'watch_status' in patch) {
    patch._status_overridden = true;
  }
  const updatedSeason = { ...anime.seasons[sid], ...patch, updated_date: NOW() };
  const updated = [...library];
  updated[idx] = {
    ...anime,
    seasons: { ...anime.seasons, [sid]: updatedSeason },
    updated_date: NOW(),
  };
  const { library: normalized } = await normalizeAndCommitLibrary(library, updated, [rootMalId]);
  return normalized.find((entry) => entry.root_mal_id === Number(rootMalId)) || updated[idx];
}

// ---------- Delete ----------

export async function deleteAnimeEntry(rootMalId) {
  const anime = getAnime(rootMalId);
  storageQueue.queueDelete(rootMalId);
  setState('library', getState('library').filter(a => a.root_mal_id !== Number(rootMalId)));
  showToast(`Removed "${anime?.title_english || 'anime'}"`, 'info');
}

// ---------- Reorder (custom sort via updated_date touch) ----------

export async function reorderLibrary(newOrder) {
  const now = new Date();
  const updated = newOrder.map((a, i) => ({
    ...a,
    _sort_order: i,          // transient field for UI sort
  }));
  storageQueue.queueBatchWrite(updated);
  setState('library', updated);
}

// ---------- Relation Merge ----------

/** Add a new season discovered via relation check — never overwrite */
export async function mergeRelationSeason(rootMalId, jikanData) {
  const library = getState('library');
  const idx = library.findIndex(a => a.root_mal_id === Number(rootMalId));
  if (idx < 0) return;

  const anime = library[idx];
  const sid = String(jikanData.mal_id);
  if (anime.seasons[sid]) return; // already present

  const season = buildSeasonEntry(jikanData);
  const updated = [...library];
  updated[idx] = {
    ...anime,
    seasons: { ...anime.seasons, [sid]: season },
    updated_date: NOW(),
  };

  const resolved = await resolveFranchise(updated[idx], updated);
  if (resolved) {
    updated[idx] = applyResolvedFranchisePatch(updated[idx], resolved, updated);
  } else {
    updated[idx] = normalizeAnimeEntry(updated[idx]);
  }

  await normalizeAndCommitLibrary(library, updated, [rootMalId]);
}

// ---------- Migration ----------

/** Convert v1 schema (seasons as array) to v2 (seasons as object) */
export function migrateOldSchema(old) {
  try {
    const seasons = {};
    let rootMalId = null;
    let selectedId = null;

    (old.seasons || []).forEach((s, i) => {
      // Use mal_id if present, otherwise generate a fake one
      const sid = s.mal_id ? Number(s.mal_id) : (1000000 + i);
      if (i === 0) rootMalId = sid;

      // Detect active season
      if (s.status === 'watching' && !selectedId) selectedId = sid;
      else if (i === (old.seasons.length - 1) && !selectedId) selectedId = sid;

      seasons[String(sid)] = {
        mal_id: sid,
        title_japanese: s.title || '',
        title_english: s.title || '',
        total_episodes: s.episodes || 0,
        aired_episodes: s.episodes || 0,
        filler_episodes: 0,
      non_filler_episodes: s.episodes || 0,
      genres: s.genres || [],
      status: normalizeSeasonStatus(s.status, {
        airing: !!s.airing,
        fallback: s.airing ? 'Currently Airing' : 'Finished Airing'
      }),
      airing: !!s.airing,
      weekly_schedule: '',
        progress: s.watched_episodes || 0,
        watch_status: s.status || 'plan_to_watch',
        poster_url: s.image || '',
        user_poster: null,
        relations: s.relations || [],
        added_date: old.added_date || NOW(),
        updated_date: s.dates?.start || NOW(),
        last_relation_check: NOW(),
        started_watching_date: s.status !== 'plan_to_watch' ? (s.dates?.start || null) : null,
        last_progress_update: s.watched_episodes > 0 ? NOW() : null,
      };
    });

    if (!rootMalId) return null;

    return {
      root_mal_id: rootMalId,
      selected_season_mal_id: selectedId || rootMalId,
      title_japanese: old.title || '',
      title_english: old.title || '',
      genres: old.seasons?.[0]?.genres || [],
      poster_url: old.poster || old.seasons?.[0]?.image || '',
      user_poster: null,
      added_date: old.added_date || NOW(),
      updated_date: NOW(),
      seasons,
    };
  } catch (e) {
    console.error('Migration failed:', e, old);
    return null;
  }
}

// ---------- Private helpers ----------

function buildSeasonEntry(data) {
  return {
    mal_id: Number(data.mal_id),
    title_japanese: data.title_jp || data.title || '',
    title_english: data.title || data.title_jp || '',
    native_title: data.title_jp || data.title || '',
    total_episodes: data.episodes || 0,
    aired_episodes: data.episodes || 0,
    filler_episodes: 0,
    non_filler_episodes: data.episodes || 0,
    episodes: data.episodes || 0,
    genres: data.genres || [],
    aired_at: data.aired?.from || null,
    updated_at: NOW(),
    season_number: data.season_number || null,
    part_number: data.part_number || null,
    anilist_id: data.anilist_id || null,
    format: data.format || data.type || 'TV',
    status: normalizeSeasonStatus(data.season_status || data.status, {
      airing: !!data.airing,
      fallback: data.airing ? 'Currently Airing' : 'Finished Airing'
    }),
    airing: !!data.airing,
    is_airing: !!data.airing,
    is_movie: String(data.format || data.type || '').toUpperCase() === 'MOVIE',
    is_ova: String(data.format || data.type || '').toUpperCase() === 'OVA',
    is_special: String(data.format || data.type || '').toUpperCase().includes('SPECIAL'),
    is_one_long_running_series: false,
    weekly_schedule: '',
    progress: 0,
    watch_status: 'plan_to_watch',
    watch_state: 'plan_to_watch',
    poster_url: data.poster || '',
    user_poster: null,
    relations: Array.isArray(data.relations) ? data.relations : [],
    added_date: NOW(),
    updated_date: NOW(),
    last_relation_check: NOW(),
    started_watching_date: null,
    last_progress_update: null,
    last_watched_at: null,
    franchise_id: null,
    franchise_root_id: null,
    franchise_order_index: null,
    franchise_rank_score: 0,
    next_episode_airing_at: null,
    next_episode_airtime: null,
    next_release_countdown: null,
    next_episode_number: null,
    has_new_episode: false,
    has_user_watched_previous: false,
    last_notified_episode: null,
    season_label: data.season || '',
    season_year: data.year || null,
    sync_status: 'pending',
  };
}
