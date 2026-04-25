/**
 * jikanClient.js — Jikan v4 API client
 */

import { apiFetch } from '../api.js';

const BASE = 'https://api.jikan.moe/v4';

export function normalizeSeasonStatus(status, { airing = false, fallback = 'Unknown' } = {}) {
  const raw = String(status || '').trim().toLowerCase();

  if (
    airing ||
    raw === 'currently airing' ||
    raw === 'watching' ||
    raw === 'releasing'
  ) {
    return 'Currently Airing';
  }

  if (
    raw === 'finished airing' ||
    raw === 'completed' ||
    raw === 'finished' ||
    raw === 'finished_airing'
  ) {
    return 'Finished Airing';
  }

  if (
    raw === 'not yet aired' ||
    raw === 'not_yet_aired' ||
    raw === 'plan_to_watch'
  ) {
    return 'Not Yet Aired';
  }

  return fallback;
}

export async function searchAnime(query, page = 1, limit = 20) {
  const url = `${BASE}/anime?q=${encodeURIComponent(query)}&page=${page}&limit=${limit}&sfw=false`;
  const data = await apiFetch(url);
  return {
    results: (data.data || []).map(mapAnime),
    pagination: data.pagination,
  };
}

export async function getAnimeById(malId) {
  const data = await apiFetch(`${BASE}/anime/${malId}/full`);
  return mapAnime(data.data);
}

export async function getAnimeRelations(malId) {
  const data = await apiFetch(`${BASE}/anime/${malId}/relations`);
  return (data.data || []).flatMap(rel => {
    return (rel.entry || []).map(e => ({
      mal_id: e.mal_id,
      name: e.name,
      type: e.type,
      relation: rel.relation,
    }));
  });
}

export async function getAiringThisWeek() {
  const url = `${BASE}/schedules`;
  const data = await apiFetch(url);
  return (data.data || []).map(mapAnime);
}

function mapAnime(raw) {
  if (!raw) return null;
  return {
    mal_id: raw.mal_id,
    title: raw.title_english || raw.title || 'Unknown',
    title_jp: raw.title,
    poster: raw.images?.jpg?.large_image_url || raw.images?.jpg?.image_url || '',
    episodes: raw.episodes || 0,
    status: mapStatus(raw.status),
    season_status: normalizeSeasonStatus(raw.status, {
      airing: raw.airing,
      fallback: raw.status || 'Unknown'
    }),
    genres: (raw.genres || []).map(g => g.name),
    themes: (raw.themes || []).map(t => t.name),
    synopsis: raw.synopsis || '',
    score: raw.score || 0,
    airing: raw.airing || false,
    aired: raw.aired,
    relations: raw.relations || [],
    season: raw.season,
    year: raw.year,
    studios: (raw.studios || []).map(s => s.name),
    source: raw.source,
    duration: raw.duration,
    rating: raw.rating,
    favorites: raw.favorites || 0,
    members: raw.members || 0,
    trailer_url: raw.trailer?.url || null,
  };
}

function mapStatus(jikanStatus) {
  const map = {
    'Finished Airing': 'completed',
    'Currently Airing': 'watching',
    'Not yet aired': 'plan_to_watch',
  };
  return map[jikanStatus] || jikanStatus || 'plan_to_watch';
}
