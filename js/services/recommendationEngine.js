/**
 * recommendationEngine.js — Intelligent recommendation scoring with explainable reasons (v2 schema)
 */

import { getState, getSelectedSeason, getRootWatchStatus, getSeasonsArray } from '../state.js';
import { calculateFranchiseBoost, getRankedFranchiseCandidates } from './franchiseService.js';

const CACHE_KEY = 'mugellist_rec_cache';
const CACHE_TTL = 3600000; // 1 hour

export async function getRecommendations() {
  const library = getState('library') || [];
  if (library.length === 0) return { continueWatching: [], newSeasons: [], similar: [], gems: [], rewatch: [] };

  const fingerprint = buildRecommendationFingerprint(library);

  // Check cache first
  const cached = getCachedRecommendations(fingerprint);
  if (cached) return cached;

  // Continue Watching - Active titles sorted by recency
  const continueWatching = library
    .filter(a => getRootWatchStatus(a) === 'watching')
    .sort((a, b) => {
      const boostDiff = calculateFranchiseBoost(b, library) - calculateFranchiseBoost(a, library);
      if (boostDiff !== 0) return boostDiff;
      return new Date(b.updated_date) - new Date(a.updated_date);
    })
    .slice(0, 6)
    .map(a => ({
      ...a,
      _recommendation: {
        reason: 'Continue your journey',
        tags: ['actively watching', 'recent activity']
      }
    }));

  // Rewatch - Completed but untouched for long time
  const rewatch = library
    .filter(a => getRootWatchStatus(a) === 'completed')
    .map(a => ({
      anime: a,
      daysOld: a.updated_date ? daysSince(a.updated_date) : Infinity
    }))
    .sort((x, y) => y.daysOld - x.daysOld)
    .slice(0, 4)
    .map(({ anime, daysOld }) => ({
      ...anime,
      _recommendation: {
        reason: `It's been a while (${Math.floor(daysOld)} days)`,
        tags: ['completed', 'long time ago']
      }
    }));

  // Backlog - Plan to watch that haven't been started
  const gems = library
    .filter(a => {
      const s = getSelectedSeason(a);
      return getRootWatchStatus(a) === 'plan_to_watch' && (s?.progress || 0) < 2;
    })
    .slice(0, 6)
    .map(a => ({
      ...a,
      _recommendation: {
        reason: 'From your watchlist',
        tags: ['planned', 'not started']
      }
    }));

  // New Seasons - Airing sequels of known franchises
  const newSeasons = getRankedFranchiseCandidates(library, {
    entries: library.filter(a => {
      const season = getSelectedSeason(a);
      if (!season) return false;
      if (season.is_movie || season.is_ova || season.is_special) return false;
      return Boolean(a.has_user_watched_previous || a.is_sequel_confirmed || season.is_airing);
    })
  })
    .filter(a => {
      const season = getSelectedSeason(a);
      return season && getRootWatchStatus(a) !== 'completed' && calculateFranchiseBoost(a, library) >= 40;
    })
    .slice(0, 6)
    .map(a => ({
      ...a,
      _recommendation: {
        reason: 'Best franchise continuation for you',
        tags: [getSelectedSeason(a)?.is_airing ? 'airing now' : 'next season', 'franchise-ranked']
      }
    }));

  // Smart similar recommendations based on multiple factors
  const topGenres = computeTopGenres(library, 3);
  const avgCompletionRate = computeCompletionRate(library);
  
  const similarCandidates = library
    .filter(a => ['plan_to_watch', 'paused', 'dropped'].includes(getRootWatchStatus(a)))
    // Exclude those already in newSeasons to avoid duplicates
    .filter(a => !newSeasons.some(n => n.root_mal_id === a.root_mal_id))
    .map(a => {
      const score = computeRecommendationScore(a, library, topGenres, avgCompletionRate);
      return { anime: a, score };
    })
    .filter(x => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, 6)
    .map(({ anime, score }) => {
      const reasons = getRecommendationReasons(anime, library, topGenres);
      return {
        ...anime,
        _recommendation: {
          reason: reasons.primary,
          tags: reasons.tags,
          confidence: Math.min(100, Math.round(score))
        }
      };
    });

  const result = {
    continueWatching,
    newSeasons,
    similar: similarCandidates,
    gems,
    rewatch
  };

  // Cache the result
  cacheRecommendations(result, fingerprint);
  return result;
}

function computeTopGenres(library, count) {
  const genreCounts = {};
  library.forEach(a => {
    const s = getSelectedSeason(a);
    if (!s) return;
    (s.genres || []).forEach(g => {
      genreCounts[g] = (genreCounts[g] || 0) + 1;
    });
  });

  return Object.keys(genreCounts)
    .sort((x, y) => genreCounts[y] - genreCounts[x])
    .slice(0, count);
}

function computeCompletionRate(library) {
  if (library.length === 0) return 0;
  const completed = library.filter(a => getRootWatchStatus(a) === 'completed').length;
  return completed / library.length;
}

function computeRecommendationScore(anime, library, topGenres, avgCompletionRate) {
  let score = 0;

  // 1. Franchise Boost (weight: up to 100)
  const fBoost = calculateFranchiseBoost(anime, library);
  score += fBoost;

  // 2. Genre overlap (weight: 6)
  const s = getSelectedSeason(anime);
  const genres = new Set([...(anime.genres || []), ...(s?.genres || [])]);
  const genreOverlap = topGenres.reduce((acc, g) => acc + (genres.has(g) ? 1 : 0), 0);
  score += genreOverlap * 6;

  // 3. Recency boost (weight: up to 9)
  const daysOld = anime.updated_date ? daysSince(anime.updated_date) : Infinity;
  const recencyBoost = Math.max(0, 45 - daysOld) / 5;
  score += recencyBoost;

  // 4. Status modifier (weight: ±15)
  const status = getRootWatchStatus(anime);
  if (status === 'dropped') score -= 15;
  else if (status === 'paused') score += 3;
  else if (status === 'plan_to_watch' && daysOld > 365) score -= 2;

  // 5. Progress bonus for partially watched (weight: up to 5)
  const progressBonus = s && s.progress && s.total_episodes
    ? (s.progress / s.total_episodes) * 5
    : 0;
  score += progressBonus;

  // 6. Completion tendency (weight: ±3)
  if (avgCompletionRate > 0.7 && status === 'plan_to_watch') score += 3;
  else if (avgCompletionRate < 0.3 && status === 'plan_to_watch') score -= 2;

  return score;
}

function getRecommendationReasons(anime, library, topGenres) {
  const reasons = [];
  const s = getSelectedSeason(anime);
  const genres = new Set([...(anime.genres || []), ...(s?.genres || [])]);
  const status = getRootWatchStatus(anime);

  // Primary reason
  let primary = 'Good match for you';

  if (genres.size > 0 && topGenres.some(g => genres.has(g))) {
    primary = 'Matches your favorite genres';
    reasons.push('matches your favorite genres');
  }

  if (status === 'paused') {
    primary = 'Resume where you left off';
    reasons.push('you were watching it');
  } else if (status === 'plan_to_watch') {
    primary = 'Next in your backlog';
    reasons.push('in your watchlist');
  }

  if (s && s.progress && s.progress > 0) {
    reasons.push('you\'ve started it');
  }

  // Avoid duplicates and fill if needed
  if (reasons.length === 0) {
    if (genres.size > 0) reasons.push('similar genres');
    reasons.push('curated for you');
  }

  return {
    primary,
    tags: reasons.slice(0, 2)
  };
}

function daysSince(dateStr) {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  return diff / (1000 * 60 * 60 * 24);
}

function getCachedRecommendations(expectedFingerprint) {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return null;

    const { data, timestamp, fingerprint } = JSON.parse(cached);
    if (Date.now() - timestamp > CACHE_TTL) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    if (fingerprint !== expectedFingerprint) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }

    return data;
  } catch (e) {
    console.warn('recommendationEngine: failed to read/parse cache, ignoring it', e);
    return null;
  }
}

function cacheRecommendations(data, fingerprint) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      data,
      timestamp: Date.now(),
      fingerprint
    }));
  } catch (e) {
    console.warn('recommendationEngine: failed to persist cache', e);
  }
}

function buildRecommendationFingerprint(library) {
  return library
    .map((anime) => {
      const season = getSelectedSeason(anime);
      return [
        anime.root_mal_id,
        anime.selected_season_mal_id,
        anime.updated_date || '',
        anime.franchise_rank_score || 0,
        anime.franchise_id || '',
        season?.progress || 0,
        season?.watch_status || '',
      ].join(':');
    })
    .join('|');
}
