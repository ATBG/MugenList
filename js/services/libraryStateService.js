/**
 * libraryStateService.js — Shared normalization + persistence helper for library mutations.
 */

import { saveAnime } from '../storage.js';
import { setState } from '../state.js';
import { storageQueue } from './storageQueue.js';
import { normalizeLibraryMetadata } from './franchiseService.js';

export async function normalizeAndCommitLibrary(previousLibrary, nextLibrary, targetRootIds = [], options = {}) {
  const persistMode = options.persistMode === 'immediate' ? 'immediate' : 'queue';
  const result = normalizeLibraryMetadata(nextLibrary, { targetRootIds });
  const normalizedLibrary = result.library;
  const previousByRootId = new Map((previousLibrary || []).map((entry) => [Number(entry.root_mal_id), entry]));
  const targetIds = new Set((targetRootIds || []).map(Number));
  const touchedFranchiseIds = new Set(
    normalizedLibrary
      .filter((entry) => targetIds.size === 0 || targetIds.has(Number(entry.root_mal_id)))
      .map((entry) => entry.franchise_id || `mal-${Number(entry.franchise_root_id || entry.root_mal_id)}`)
  );

  const changedEntries = normalizedLibrary.filter((entry) => {
    const franchiseId = entry.franchise_id || `mal-${Number(entry.franchise_root_id || entry.root_mal_id)}`;
    if (touchedFranchiseIds.size > 0 && !touchedFranchiseIds.has(franchiseId)) return false;
    return JSON.stringify(previousByRootId.get(Number(entry.root_mal_id)) || null) !== JSON.stringify(entry);
  });

  if (persistMode === 'immediate') {
    await Promise.all(changedEntries.map((entry) => saveAnime(entry)));
  } else if (changedEntries.length === 1) {
    storageQueue.queueAnimeWrite(changedEntries[0]);
  } else if (changedEntries.length > 1) {
    storageQueue.queueBatchWrite(changedEntries);
  }

  setState('library', normalizedLibrary);
  return { library: normalizedLibrary, changedEntries };
}
