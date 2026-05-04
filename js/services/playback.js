/**
 * playback.js — Build playback URLs for supported providers
 * Provides a small provider map and helpers to resolve episode targets.
 */

function slugify(input = '') {
  return String(input || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

import anikaiLookup from './anikaiLookup.js';

const PROVIDERS = {
  anikai: {
    id: 'anikai',
    label: 'Anikai',
    build: ({ anime, season, episode, slug }) => {
      const s = slug || slugify(anime.title_english || anime.title || anime.title_romaji || anime.title_japanese || anime.title);
      return `https://anikai.to/watch/${s}#ep=${episode}`;
    }
  },
  gogoanime: {
    id: 'gogoanime',
    label: 'GogoAnime',
    build: ({ anime, season, episode, slug }) => {
      const s = slug || slugify(anime.title_english || anime.title || anime.title_romaji || anime.title_japanese || anime.title);
      return `https://gogoanime.pe/category/${s}-episode-${episode}`;
    }
  },
  crunchyroll: {
    id: 'crunchyroll',
    label: 'Crunchyroll',
    build: ({ anime, season, episode, slug }) => {
      const s = slug || slugify(anime.title_english || anime.title || anime.title_romaji || anime.title_japanese || anime.title);
      return `https://www.crunchyroll.com/${s}/episode-${episode}`;
    }
  }
};

export function getProviders() {
  return Object.values(PROVIDERS);
}

export function defaultEpisodeForPlayback(season) {
  if (!season) return 1;
  const prog = parseInt(season.progress || 0, 10) || 0;
  const total = parseInt(season.total_episodes || 0, 10) || 0;
  if (prog <= 0) return 1;
  if (total > 0 && prog < total) return prog + 1;
  return prog;
}

export function buildPlaybackUrl(providerKey, anime, season, episode) {
  const provider = PROVIDERS[providerKey];
  if (!provider) return null;
  const slug = (anime && (anime.external_slug || anime.slug || anime.title_english || anime.title || anime.title_romaji)) || '';
  try {
    return provider.build({ anime, season, episode, slug: slug && slugify(slug) });
  } catch (err) {
    console.warn('buildPlaybackUrl error', err);
    return null;
  }
}

export async function launchExternalPlayback(providerKey, anime, season, episode) {
  try {
    if (providerKey === 'anikai') {
      const title = (anime && (anime.title_english || anime.title || anime.title_romaji || anime.title_japanese)) || '';
      const res = await anikaiLookup.resolveAniKaiWatch(title || String(anime?.root_mal_id || ''), { episode, malId: anime?.root_mal_id });
      if (!res || !res.url) return null;
      // If resolver returned a low-confidence result, it will be a search page fallback
      window.open(res.url, '_blank');
      return res.url;
    }

    const url = buildPlaybackUrl(providerKey, anime, season, episode);
    if (!url) return null;
    window.open(url, '_blank');
    return url;
  } catch (err) {
    console.warn('launchExternalPlayback failed', err);
    return null;
  }
}

export default {
  getProviders,
  defaultEpisodeForPlayback,
  buildPlaybackUrl,
  launchExternalPlayback
};
