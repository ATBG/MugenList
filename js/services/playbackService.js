/**
 * playbackService.js — High-level playback orchestration.
 * Handles the "Play Next" logic by checking local files and remote resolvers.
 */

import { openPlaybackPicker } from '../ui/playbackPicker.js';
import { BACKEND_URL } from '../api.js';
import { getState } from '../state.js';

/**
 * Initiates playback for an episode by prompting the user for a source.
 * @param {Object} anime - The anime object from the state.
 * @param {number} episode - The episode number to play.
 */
export async function playEpisode(anime, episode) {
    return openPlaybackPicker(anime, episode);
}

/**
 * Communicates with backend to play a local file.
 */
async function playLocalFile(path) {
    const res = await fetch(`${BACKEND_URL}/api/local/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
    });
    if (!res.ok) throw new Error('Failed to play local file');
    return await res.json();
}

/**
 * Checks if a local file exists for the given anime and episode.
 * Depends on the 'settings.local_path' in state.
 */
async function findLocalFile(anime, episode) {
    const settings = getState('settings');
    const localPath = settings?.local_path;
    if (!localPath) return null;
    
    try {
        const res = await fetch(`${BACKEND_URL}/api/local/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: localPath })
        });
        if (!res.ok) return null;
        
        const data = await res.json();
        const files = data.files || [];
        
        // Find best match based on episode number
        // In a real app, we'd also check the title similarity
        return files.find(f => f.episode === episode);
    } catch (err) {
        console.warn('Local file search failed:', err);
        return null;
    }
}
