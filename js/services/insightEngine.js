/**
 * insightEngine.js — Compute statistics across library (v2 schema)
 */

import { getState, getRootWatchStatus, getSeasonsArray } from '../state.js';

let _cache = null;
let _cacheSig = '';

export function getInsights() {
  const library = getState('library') || [];

  // fast cache check
  const sig = library.map(a => `${a.root_mal_id}:${a.updated_date}`).join('|');
  if (_cache && _cacheSig === sig) return _cache;

  const res = {
    totalFranchises: new Set(library.map(a => a.franchise_id || a.root_mal_id)).size,
    totalEntries: library.length,
    totalSeasons: 0,
    episodesWatched: 0,
    timeSpentDays: 0,
    timeSpentHours: 0,
    completionRate: 0,
    genreDistribution: {},
    statusBreakdown: { watching: 0, completed: 0, plan_to_watch: 0, paused: 0, dropped: 0 },
    monthlyActivity: {},
  };

  let completedFranchises = 0;

  library.forEach(anime => {
    // Root level status aggregation (deterministic root)
    const rootStatus = getRootWatchStatus(anime);
    if (res.statusBreakdown[rootStatus] !== undefined) {
      res.statusBreakdown[rootStatus]++;
    }
    if (rootStatus === 'completed') completedFranchises++;

    // Season level aggregation
    const seasons = getSeasonsArray(anime);
    res.totalSeasons += seasons.length;

    seasons.forEach(season => {
      res.episodesWatched += (season.progress || 0);

      // Genres
      (season.genres || []).forEach(g => {
        res.genreDistribution[g] = (res.genreDistribution[g] || 0) + 1;
      });

      // Activity
      if (season.last_progress_update) {
        const d = new Date(season.last_progress_update);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        res.monthlyActivity[key] = (res.monthlyActivity[key] || 0) + 1;
      }
    });

  });

  res.completionRate = library.length > 0 ? Math.round((completedFranchises / library.length) * 100) : 0;
  const minutes = res.episodesWatched * 24; // 24 min avg
  res.timeSpentHours = Number((minutes / 60).toFixed(1));
  res.timeSpentDays = Number((minutes / 60 / 24).toFixed(1));

  _cache = res;
  _cacheSig = sig;
  return res;
}
