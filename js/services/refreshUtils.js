/**
 * refreshUtils.js — Utility functions for refresh operations
 * Provides UI-friendly methods for checking refresh status
 */

import { getState } from '../state.js';
import { getTimeUntilNextRefresh, getRefreshStatus, refreshAnimeNow, manualLibrarySync } from './refreshService.js';

/**
 * Get a human-readable string for refresh status of an anime
 */
export function getRefreshStatusText(anime) {
  if (!anime) return 'Unknown';
  
  const status = getRefreshStatus(anime);
  
  if (status === 'never') return 'Never refreshed';
  if (status === 'ready') return 'Ready to refresh';
  if (status === '0h') return 'Just refreshed';
  
  return `Refreshes in ${status}`;
}

/**
 * Get last refresh timestamp as a human-readable string
 */
export function getLastRefreshTime(anime) {
  if (!anime?.last_jikan_update) return 'Never';
  
  try {
    const timestamp = new Date(anime.last_jikan_update);
    const now = Date.now();
    const diffMs = now - timestamp.getTime();
    
    // Less than a minute
    if (diffMs < 60 * 1000) return 'Just now';
    
    // Less than an hour
    if (diffMs < 60 * 60 * 1000) {
      const mins = Math.floor(diffMs / (60 * 1000));
      return `${mins} minute${mins > 1 ? 's' : ''} ago`;
    }
    
    // Less than a day
    if (diffMs < 24 * 60 * 60 * 1000) {
      const hours = Math.floor(diffMs / (60 * 60 * 1000));
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    }
    
    // Days
    const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    return `${days} day${days > 1 ? 's' : ''} ago`;
  } catch (err) {
    return 'Unknown';
  }
}

/**
 * Check if an anime is due for refresh
 */
export function isDueForRefresh(anime) {
  const timeUntil = getTimeUntilNextRefresh(anime);
  return timeUntil !== null && timeUntil === 0;
}

/**
 * Check if an anime is stale (hasn't been refreshed in a while)
 */
export function isStale(anime, thresholdDays = 2) {
  if (!anime?.last_jikan_update) return true;
  
  const lastUpdate = new Date(anime.last_jikan_update).getTime();
  const now = Date.now();
  const diffDays = (now - lastUpdate) / (24 * 60 * 60 * 1000);
  
  return diffDays > thresholdDays;
}

/**
 * Get count of stale anime in library
 */
export function getStaleCount(thresholdDays = 1) {
  const library = getState('library') || [];
  return library.filter(a => isStale(a, thresholdDays)).length;
}

/**
 * Trigger manual refresh for a single anime
 */
export async function manualRefreshAnime(rootMalId) {
  try {
    await refreshAnimeNow(rootMalId);
    return { success: true };
  } catch (err) {
    console.error('Manual refresh failed:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Trigger concurrent refresh for entirety of the library
 */
export async function refreshEntireLibrary(onProgress) {
  const library = getState('library') || [];
  
  if (library.length === 0) return { count: 0, total: 0 };

  let refreshedCount = 0;
  await manualLibrarySync(({ completed, total }) => {
    refreshedCount = completed;
    if (onProgress) onProgress(completed, total);
  });

  return { count: refreshedCount, total: library.length };
}
