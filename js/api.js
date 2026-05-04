/**
 * api.js — Unified API interface.
 * Routes requests through the local Python backend to handle rate-limiting,
 * caching, and CORS. Falls back to direct fetch if necessary (optional).
 */

// Use relative path by default to avoid CORS and origin mismatch issues
export const BACKEND_URL = ''; 

/**
 * Standard fetch wrapper that prioritizes the local backend.
 */
export async function localFetch(endpoint, opts = {}) {
  try {
    const res = await fetch(`${BACKEND_URL}${endpoint}`, opts);
    if (res.status === 429) {
      // Backend should handle 429, but if it leaks through, wait and retry
      await new Promise(r => setTimeout(r, 2000));
      return localFetch(endpoint, opts);
    }
    if (!res.ok) throw new Error(`Backend HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`Local fetch failed for ${endpoint}:`, err);
    throw err;
  }
}

/**
 * apiFetch: Main entry point for metadata/general tasks.
 * Originally for Jikan, now routes through backend.
 */
export async function apiFetch(url, opts = {}, priority = false) {
  // If the URL is a Jikan URL, we can map it to our backend
  if (url.includes('api.jikan.moe/v4/anime/')) {
    const match = url.match(/\/anime\/(\d+)\/full/);
    if (match) {
      return { data: await localFetch(`/api/metadata/anime/${match[1]}`) };
    }
    
    const searchMatch = url.match(/\/anime\?q=([^&]+)/);
    if (searchMatch) {
      const q = searchMatch[1];
      return { data: await localFetch(`/api/metadata/search?q=${q}`) };
    }
  }

  // Fallback to direct fetch for anything else (or legacy)
  // Note: This might hit CORS if not handled by backend
  const res = await fetch(url, opts);
  return await res.json();
}

/**
 * graphqlFetch: Routes AniList queries through backend airing endpoint where possible.
 */
export async function graphqlFetch(query, variables = {}, priority = false) {
  // Special case: Airing status check (used by episodeSyncService)
  if (query.includes('nextAiringEpisode') && variables.idMals && variables.idMals.length === 1) {
    const idMal = variables.idMals[0];
    const data = await localFetch(`/api/metadata/airing/${idMal}`);
    // Wrap back into AniList-like structure for compatibility
    return {
      data: {
        Page: {
          media: [
            {
              idMal: data.idMal,
              episodes: data.episodes,
              status: data.status,
              season: data.season,
              seasonYear: data.seasonYear,
              nextAiringEpisode: data.nextAiringEpisode
            }
          ]
        }
      }
    };
  }

  // Generic fallback for other GraphQL queries
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return await res.json();
}

export function clearQueue() {
  // No longer needed as backend handles concurrency
}
