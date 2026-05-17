/**
 * pythonEpisodeState.js — Synchronizes local file presence with the app state.
 * Periodically scans designated folders and updates the 'local_files' state.
 */

import { getState, setState } from '../state.js';
import { BACKEND_URL } from '../api.js';

let _syncInterval = null;

/**
 * Starts the periodic sync of local file metadata from the Python backend.
 */
export function startLocalFileStateSync() {
    if (_syncInterval) return;
    
    // Initial sync
    syncLocalFiles();
    
    // Every 5 minutes
    _syncInterval = setInterval(syncLocalFiles, 5 * 60 * 1000);
}

export function stopLocalFileStateSync() {
    if (_syncInterval) {
        clearInterval(_syncInterval);
        _syncInterval = null;
    }
}

/**
 * Fetches the list of local files from the backend and commits to global state.
 */
export async function syncLocalFiles() {
    const settings = getState('settings');
    const path = settings?.local_path;
    if (!path) return;
    
    console.log('[LocalState] Syncing files from:', path);
    
    try {
        const res = await fetch(`${BACKEND_URL}/api/local/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        if (!res.ok) throw new Error(`Scan failed: ${res.status}`);
        
        const data = await res.json();
        const files = data.files || [];
        
        // Map files by mal_id and episode for quick lookup
        // Note: For now we'll just store the raw list or a map
        setState('local_files', files);
        console.log(`[LocalState] Found ${files.length} local episodes.`);
    } catch (err) {
        console.error('[LocalState] Sync failed:', err);
    }
}
