/**
 * seriesCategorizer.js — Compute series scope categories dynamically
 * 
 * Categories:
 * - "Legendary Titan" (1000+ episodes)
 * - "Long-Road Runner" (200-999 episodes)
 * - "Marathon Classic" (100-199 episodes)
 * - "Seasonal Saga" (2+ seasons, any episode count)
 * - "One-Arc Wonder" (single season)
 * - "Feature Film" (movies, OVAs, specials)
 */

export function getSeriesScope(anime) {
  if (!anime || !anime.seasons) return null;
  
  const seasons = Object.values(anime.seasons || {});
  if (seasons.length === 0) return null;
  
  const totalEpisodes = seasons.reduce((sum, s) => sum + (s.total_episodes || 0), 0);
  
  // Feature Film: single season with very few episodes (movie)
  if (seasons.length === 1 && totalEpisodes <= 2) {
    return 'Feature Film';
  }
  
  // Legendary Titan: 1000+ episodes total
  if (totalEpisodes >= 1000) {
    return 'Legendary Titan';
  }
  
  // Seasonal Saga: 2+ seasons
  if (seasons.length >= 2) {
    return 'Seasonal Saga';
  }
  
  // Long-Road Runner: 200-999 episodes (single season)
  if (totalEpisodes >= 200 && totalEpisodes < 1000) {
    return 'Long-Road Runner';
  }
  
  // Marathon Classic: 100-199 episodes (single season)
  if (totalEpisodes >= 100 && totalEpisodes < 200) {
    return 'Marathon Classic';
  }
  
  // One-Arc Wonder: single season, <100 episodes
  return 'One-Arc Wonder';
}

export function getAllSeriesScopes() {
  return [
    { id: 'legendary-titan', label: 'Legendary Titan', icon: '👹', desc: '1000+ episodes' },
    { id: 'long-road-runner', label: 'Long-Road Runner', icon: '🏃', desc: '200-999 episodes' },
    { id: 'marathon-classic', label: 'Marathon Classic', icon: '🏅', desc: '100-199 episodes' },
    { id: 'seasonal-saga', label: 'Seasonal Saga', icon: '📺', desc: '2+ seasons' },
    { id: 'one-arc-wonder', label: 'One-Arc Wonder', icon: '⭐', desc: 'Single season' },
    { id: 'feature-film', label: 'Feature Film', icon: '🎬', desc: 'Movies & OVAs' },
  ];
}

export function filterBySeriesScope(animeArray, scopeIds) {
  if (!scopeIds || scopeIds.length === 0) {
    return animeArray;
  }
  
  return animeArray.filter(anime => {
    const scope = getSeriesScope(anime);
    if (!scope) return false;
    
    // Map display names to filter IDs
    const scopeMap = {
      'Legendary Titan': 'legendary-titan',
      'Long-Road Runner': 'long-road-runner',
      'Marathon Classic': 'marathon-classic',
      'Seasonal Saga': 'seasonal-saga',
      'One-Arc Wonder': 'one-arc-wonder',
      'Feature Film': 'feature-film',
    };
    
    return scopeIds.includes(scopeMap[scope]);
  });
}
