/**
 * state.js — Reactive global state (observer pattern) — v2 schema
 */

const _state = {
  library: [],          // AnimeEntry[] — new schema
  libraryIndex: {},     // root_mal_id -> anime
  settings: {},
  activeTab: 'library',
  filters: {
    search: '',
    genres: [],
    watchStatus: [],    // renamed from status
    airing: null,
    weeklyAiring: false,
    sort: 'updated_date_desc',
    seriesScope: [],    // New: Series Scope filter
  },
  viewMode: 'grid',
  focusRootId: null,    // root_mal_id for focus page
  miniTrackerVisible: false,
  pendingRelations: [],
  routeParams: {},
  readyState: 'loading', // 'loading' | 'ready' | 'error' — hydration gate
  hydratedAt: 0,        // Timestamp when hydration completed
  notifications: [],    // Active notification objects
};

const _listeners = {};

export function getState(key) {
  return key ? _state[key] : { ..._state };
}

export function setState(key, value) {
  _state[key] = value;
  if (key === 'library') {
    _state.libraryIndex = {};
    (value || []).forEach(a => { _state.libraryIndex[a.root_mal_id] = a; });
  }
  _emit(key, value);
}

export function patchState(key, patch) {
  _state[key] = { ..._state[key], ...patch };
  if (key === 'library') {
    _state.libraryIndex = {};
    (_state[key] || []).forEach(a => { _state.libraryIndex[a.root_mal_id] = a; });
  }
  _emit(key, _state[key]);
}

export function subscribe(key, fn) {
  if (!_listeners[key]) _listeners[key] = [];
  _listeners[key].push(fn);
  return () => { _listeners[key] = _listeners[key].filter(f => f !== fn); };
}

export function subscribeMany(keys, fn) {
  const unsubs = keys.map(k => subscribe(k, fn));
  return () => unsubs.forEach(u => u());
}

function _emit(key, value) {
  (_listeners[key] || []).forEach(fn => fn(value));
}

// ---------- v2 Schema Helpers ----------

/** Get the currently selected season object for an anime entry */
export function getSelectedSeason(anime) {
  if (!anime) return null;
  const sid = String(anime.selected_season_mal_id);
  return anime.seasons[sid] || Object.values(anime.seasons)[0] || null;
}

/** Get all seasons as an ordered array (by mal_id ascending) */
export function getSeasonsArray(anime) {
  if (!anime?.seasons) return [];
  return Object.values(anime.seasons).sort((a, b) => a.mal_id - b.mal_id);
}

/** Compute aggregate progress for a root anime entry */
export function getRootProgress(anime) {
  const seasons = getSeasonsArray(anime);
  const total = seasons.reduce((s, se) => s + (se.total_episodes || 0), 0);
  const watched = seasons.reduce((s, se) => s + (se.progress || 0), 0);
  return { total, watched, pct: total > 0 ? Math.round((watched / total) * 100) : 0 };
}

/** Normalize string status to generic enums */
export function normalizeStatus(val) {
  if (!val) return 'plan_to_watch';
  const str = String(val).toLowerCase().trim();
  if (str === 'watched' || str === 'completed') return 'completed';
  if (str === 'watching') return 'watching';
  if (str === 'dropped') return 'dropped';
  if (str === 'paused' || str === 'on hold' || str === 'on_hold') return 'paused';
  return 'plan_to_watch';
}

/** Derive the root-level watch status from all seasons */
export function getRootWatchStatus(anime) {
  const seasons = getSeasonsArray(anime);
  if (!seasons.length) return 'plan_to_watch';
  const statuses = seasons.map(s => normalizeStatus(s.watch_status));
  if (statuses.every(s => s === 'completed')) return 'completed';
  if (statuses.some(s => s === 'watching')) return 'watching';
  if (statuses.some(s => s === 'dropped')) return 'dropped';
  if (statuses.some(s => s === 'paused')) return 'paused';
  return 'plan_to_watch';
}

/** Get effective poster: user_poster > poster_url at season level, fallback to root */
export function getEffectivePoster(anime, season) {
  let url = '';
  if (season?.user_poster) url = season.user_poster;
  else if (season?.poster_url) url = season.poster_url;
  else if (anime?.user_poster) url = anime.user_poster;
  else url = anime?.poster_url || '';
  return url ? url.replace(/\\\\/g, '/') : '';
}

/** Get display title for a season: English preferred */
export function getSeasonDisplayTitle(season) {
  return season?.title_english || season?.title_japanese || 'Unknown';
}

/** Get root display title */
export function getRootDisplayTitle(anime) {
  if (!anime) return 'Unknown';
  return anime?.normalized_root_title || anime?.title_english || anime?.title_japanese || anime?.title || 'Unknown';
}

/** Auto-determine watch_status from progress vs episodes with support for rewatching */
export function computeWatchStatus(progress, totalEpisodes, currentStatus = null) {
  // Handle edge cases
  if (totalEpisodes === 0) return progress > 0 ? 'watching' : 'plan_to_watch';
  if (progress === 0) return 'plan_to_watch';
  if (progress >= totalEpisodes) return 'completed';
  
  // If currently rewatching and still progressing, stay rewatching
  if (currentStatus === 'rewatching' && progress > 0 && progress < totalEpisodes) {
    return 'rewatching';
  }
  
  return 'watching';
}

export function getLibrary() { return _state.library; }
export function getSettings() { return _state.settings; }
export function getFilters() { return { ..._state.filters }; }
export function getViewMode() { return _state.viewMode; }
export function getLibraryItem(id) { return _state.libraryIndex[id]; }
