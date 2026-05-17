/**
 * cloudSync.js — Simulated cloud sync
 */

import { getState, setState } from '../state.js';
import { saveAnime } from '../storage.js';
import { showToast } from '../utils.js';

let _syncTimer = null;

export function startCloudSync(intervalMs = 5 * 60 * 1000) {
  stopCloudSync();
  _syncTimer = setInterval(syncLibrary, intervalMs);
}

export function stopCloudSync() {
  if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
}

export async function syncLibrary() {
  const settings = getState('settings');
  if (!settings?.cloud_sync_enabled || !settings?.cloud_sync_endpoint) return;

  const library = getState('library');
  const payload = library.map(a => ({
    root_mal_id: a.root_mal_id,
    title: a.title_english || a.title_japanese,
    updated_date: a.updated_date,
    seasons: Object.values(a.seasons || {}).map(s => ({
      mal_id: s.mal_id,
      progress: s.progress,
      total_episodes: s.total_episodes,
      watch_status: s.watch_status,
      updated_date: s.updated_date,
    })),
  }));

  try {
    const res = await fetch(settings.cloud_sync_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library: payload, synced_at: new Date().toISOString() }),
    });

    if (!res.ok) throw new Error(`Sync failed: HTTP ${res.status}`);

    const remote = await res.json();
    if (remote?.library) {
      await _mergeRemote(library, remote.library);
      showToast('Library synced with cloud', 'success');
    }
  } catch (e) {
    console.warn('Cloud sync error:', e.message);
  }
}

async function _mergeRemote(local, remote) {
  // Latest timestamp wins
  const updated = [...local];
  for (const remoteGroup of remote) {
    const idx = updated.findIndex(g => g.root_mal_id === Number(remoteGroup.root_mal_id));
    const localGroup = idx >= 0 ? updated[idx] : null;

    // Convert remote seasons into object keyed by mal_id
    const remoteSeasons = {};
    (remoteGroup.seasons || []).forEach(rs => { remoteSeasons[String(rs.mal_id)] = rs; });

    if (!localGroup) {
      // Add new entry from remote
      const seasonsObj = {};
      Object.values(remoteSeasons).forEach(rs => {
        seasonsObj[String(rs.mal_id)] = {
          mal_id: rs.mal_id,
          progress: rs.progress || 0,
          total_episodes: rs.total_episodes || 0,
          watch_status: rs.watch_status || 'plan_to_watch',
          updated_date: rs.updated_date || remoteGroup.updated_date || new Date().toISOString(),
        };
      });
      const newEntry = {
        root_mal_id: Number(remoteGroup.root_mal_id),
        selected_season_mal_id: Number(remoteGroup.selected_season_mal_id || remoteGroup.root_mal_id),
        title_english: remoteGroup.title || 'Synced Title',
        title_japanese: remoteGroup.title_japanese || remoteGroup.title || '',
        poster_url: remoteGroup.poster_url || '',
        genres: remoteGroup.genres || [],
        seasons: seasonsObj,
        updated_date: remoteGroup.updated_date || new Date().toISOString(),
      };
      updated.push(newEntry);
      await saveAnime(newEntry);
      continue;
    }

    const mergedSeasons = { ...localGroup.seasons };
    let hasChanges = false;
    
    Object.values(remoteSeasons).forEach(rs => {
      const key = String(rs.mal_id);
      const existing = mergedSeasons[key];
      
      if (!existing) {
        mergedSeasons[key] = {
          mal_id: rs.mal_id,
          progress: rs.progress || 0,
          total_episodes: rs.total_episodes || 0,
          watch_status: rs.watch_status || 'plan_to_watch',
          updated_date: rs.updated_date || remoteGroup.updated_date || new Date().toISOString(),
        };
        hasChanges = true;
      } else {
        const localSeasonAge = new Date(existing.updated_date || 0).getTime();
        const remoteSeasonAge = new Date(rs.updated_date || remoteGroup.updated_date || 0).getTime();
        
        if (remoteSeasonAge > localSeasonAge) {
          mergedSeasons[key] = {
            ...existing,
            // Never let remote progress silently downgrade local progress
            progress: Math.max(existing.progress || 0, rs.progress || 0),
            total_episodes: rs.total_episodes || existing.total_episodes,
            watch_status: rs.watch_status || existing.watch_status,
            updated_date: rs.updated_date || existing.updated_date,
          };
          hasChanges = true;
        }
      }
    });

    if (hasChanges) {
      const merged = {
        ...localGroup,
        seasons: mergedSeasons,
        updated_date: new Date().toISOString(),
      };
      updated[idx] = merged;
      await saveAnime(merged);
    }
  }
  setState('library', updated);
}
