import { showToast } from '../utils.js';
import { getState } from '../state.js';
import { closeModal } from './dialogs.js';
import { BACKEND_URL } from '../api.js';

/**
 * Helper to extract season number from common title strings
 */
function extractSeasonOrdinalFromString(str) {
    if (!str) return null;
    const s = String(str).trim();
    let m = s.match(/season\s+(\d+)/i);
    if (m && m[1]) return Number(m[1]);
    m = s.match(/(\d+)(?:st|nd|rd|th)\s+season/i);
    if (m && m[1]) return Number(m[1]);
    m = s.match(/\bS(\d+)\b/i);
    if (m && m[1]) return Number(m[1]);
    m = s.match(/\bpart\s+(\d+)\b/i);
    if (m && m[1]) return Number(m[1]);
    return null;
}

/**
 * Opens a picker for the user to choose a playback source (Local or Miruro Online).
 * @param {Object} anime - The anime object.
 * @param {number} episode - The episode number.
 */
export async function openPlaybackPicker(anime, episode) {
    console.log('Opening playback picker for:', anime?.title_english || anime?.title, 'episode:', episode);
    
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    if (!overlay || !content) {
        showToast('UI modal not available', 'error');
        return;
    }

    content.innerHTML = `
        <div class="modal-header">
            <h3>Play Episode ${episode}</h3>
            <p style="color:var(--text-secondary);margin:4px 0 0 0;">${anime.title_english || anime.title_japanese || anime.title || ''}</p>
        </div>
        <div class="mode-selection">
            <button id="btn-local" class="mode-btn">
                <span class="icon">📁</span>
                <span class="label">Local File</span>
                <span class="desc">Play from your computer</span>
            </button>
            <button id="btn-online" class="mode-btn">
                <span class="icon">🌐</span>
                <span class="label">Online Stream</span>
                <span class="desc">Search and stream via Miruro</span>
            </button>
        </div>

        <div class="results-area hidden" id="results-area">
            <div class="source-list" id="source-list">
                <div class="loading">Searching...</div>
            </div>
            <button class="back-btn">← Back to Options</button>
        </div>

        <div class="modal-footer">
            <button class="close-btn">Cancel</button>
        </div>
    `;

    overlay.classList.remove('hidden');
    overlay.classList.add('modal-centered');

    const resultsArea = content.querySelector('#results-area');
    const modeSelection = content.querySelector('.mode-selection');

    const close = () => {
        try { closeModal(); } catch (e) { overlay.classList.add('hidden'); }
    };

    content.querySelector('.close-btn')?.addEventListener('click', close);
    content.querySelector('.back-btn')?.addEventListener('click', () => {
        resultsArea.classList.add('hidden');
        modeSelection.classList.remove('hidden');
    });

    content.querySelector('#btn-local')?.addEventListener('click', () => {
        resultsArea.classList.remove('hidden');
        modeSelection.classList.add('hidden');
        loadLocalSource(anime, episode, content);
    });

    content.querySelector('#btn-online')?.addEventListener('click', () => {
        resultsArea.classList.remove('hidden');
        modeSelection.classList.add('hidden');
        loadOnlineSource(anime, episode, content);
    });
}

async function loadLocalSource(anime, episode, container) {
    const list = container.querySelector('#source-list');
    list.innerHTML = '<div class="loading">Opening folder picker…</div>';

    try {
        // Try to detect installed players (PotPlayer)
        let players = [];
        try {
            const dp = await fetch(`${BACKEND_URL}/api/local/detect_player`);
            if (dp && dp.ok) {
                const dpj = await dp.json();
                players = dpj.players || [];
            }
        } catch (e) {
            console.warn('Player detection failed', e);
        }

        // Ask user to pick a directory on the host machine (native dialog via backend)
        const pick = await fetch(`${BACKEND_URL}/api/local/pick`);
        if (!pick.ok) throw new Error('Folder selection failed');
        const pj = await pick.json();
        const selectedPath = pj.path;
        if (!selectedPath) {
            list.innerHTML = '<div class="empty">No folder was selected.</div>';
            return;
        }

        list.innerHTML = `<div class="loading">Scanning ${selectedPath} …</div>`;

        // Gather season number for matching
        const seasonId = String(anime.selected_season_mal_id);
        const seasonObj = anime.seasons ? anime.seasons[seasonId] : null;
        
        let season = null;
        if (seasonObj && Number.isFinite(Number(seasonObj.season_number))) {
            season = Number(seasonObj.season_number);
        } else {
            const probe = seasonObj?.title_english || seasonObj?.title || seasonObj?.title_japanese || anime.title_english || anime.title || anime.title_japanese;
            const parsed = extractSeasonOrdinalFromString(probe);
            season = parsed || anime.franchise_order_index || 1;
        }
        season = Number.isFinite(Number(season)) ? Number(season) : 1;

        // Perform backend recursive scan with python-side dynamic matching
        const res = await fetch(`${BACKEND_URL}/api/local/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                path: selectedPath,
                episode: episode,
                season: season
            })
        });

        if (!res.ok) throw new Error('Backend scan failed');

        const data = await res.json();
        const file = data.matched_file;

        if (file) {
            const pot = players.find(p => p.id === 'potplayer');
            list.innerHTML = `
                <div class="source-item">
                    <div class="info">
                        <span class="filename">${file.filename}</span>
                        <span class="path">${file.full_path}</span>
                    </div>
                    <div class="actions">
                        <button class="play-btn">Play (Default)</button>
                        ${pot ? `<button class="play-pot-btn">Play (PotPlayer)</button>` : ''}
                    </div>
                </div>
            `;

            list.querySelector('.play-btn').onclick = async () => {
                try {
                    const playRes = await fetch(`${BACKEND_URL}/api/local/play`, { 
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: file.full_path }) 
                    });
                    if (playRes.ok) {
                        showToast(`Playing: ${file.filename}`, 'success');
                        closeModal();
                    } else {
                        const errData = await playRes.json().catch(() => ({}));
                        showToast(errData.error || 'Failed to play file', 'error');
                    }
                } catch (e) {
                    showToast('Playback error', 'error');
                }
            };

            if (pot) {
                list.querySelector('.play-pot-btn').onclick = async () => {
                    try {
                        const playRes = await fetch(`${BACKEND_URL}/api/local/play`, { 
                            method: 'POST', 
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: file.full_path, player: 'potplayer' }) 
                        });
                        if (playRes.ok) {
                            showToast(`Playing in PotPlayer: ${file.filename}`, 'success');
                            closeModal();
                        } else {
                            const errData = await playRes.json().catch(() => ({}));
                            showToast(errData.error || 'Failed to launch PotPlayer', 'error');
                        }
                    } catch (e) {
                        showToast('Playback error', 'error');
                    }
                };
            }
        } else {
            list.innerHTML = `<div class="empty">No local file found for Episode ${episode} (Season ${season}) in the selected folder.</div>`;
        }
    } catch (err) {
        console.error('Local playback flow failed', err);
        list.innerHTML = '<div class="error">Local play failed.</div>';
        showToast('Local play error', 'error');
    }
}

async function loadOnlineSource(anime, episode, container) {
    const list = container.querySelector('#source-list');
    list.innerHTML = '<div class="loading">Resolving online stream via Miruro...</div>';
    
    // Open window now to prevent popup blocker from blocking the redirect
    const win = window.open('about:blank', '_blank');
    if (win) {
        win.document.write('<html><head><title>Resolving Miruro...</title><style>body{background:#0b0b0f;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;margin:0;} .spinner {border: 4px solid rgba(255,255,255,0.1); border-left-color: #3b82f6; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin-bottom: 20px;} @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style></head><body><div class="spinner"></div><h2>Resolving Miruro stream...</h2></body></html>');
    }

    try {
        const title = anime.title_english || anime.title || anime.title_japanese;
        const alt_titles = [
            anime.title_english,
            anime.title_japanese,
            ...(anime.synonyms || [])
        ].filter(t => t && t !== title);
        
        const seasonId = String(anime.selected_season_mal_id);
        const seasonObj = anime.seasons ? anime.seasons[seasonId] : null;

        let season = null;
        if (seasonObj && Number.isFinite(Number(seasonObj.season_number))) {
            season = Number(seasonObj.season_number);
        } else {
            const probe = seasonObj?.title_english || seasonObj?.title || seasonObj?.title_japanese || anime.title_english || anime.title || anime.title_japanese;
            const parsed = extractSeasonOrdinalFromString(probe);
            season = parsed || anime.franchise_order_index || 1;
        }

        season = Number.isFinite(Number(season)) ? Number(season) : 1;
        const total_episodes = seasonObj?.total_episodes || 0;
        const anilist_id = anime.anilist_id || seasonObj?.anilist_id || null;
        
        console.log('Miruro Online Resolution Payload:', { title, alt_titles, episode, season, total_episodes, anilist_id });
        
        const startTime = Date.now();
        const res = await fetch(`${BACKEND_URL}/api/online/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                title: title, 
                alt_titles: alt_titles,
                episode: episode,
                season: season,
                total_episodes: total_episodes,
                anilist_id: anilist_id
            })
        });
        const duration = (Date.now() - startTime) / 1000;
        console.log(`Miruro Online Resolution took ${duration.toFixed(2)}s`);

        if (!res.ok) throw new Error('Resolution failed');
        
        const data = await res.json();
        const confidence = data.confidence || 0;
        
        if (data.url) {
            // Require high confidence (>= 80%) for auto-redirect
            if (confidence >= 80) {
                if (win) win.location.href = data.url;
                else window.location.href = data.url;
                closeModal();
                showToast(`Playing stream: ${data.title || title}`, 'success');
            } else if (confidence >= 55) {
                // Uncertain match: ask user to open manually after inspecting reasons
                if (win) win.close();
                
                const reasonsList = (data.reasons || []).map(r => `<li style="margin-bottom:4px;">${r}</li>`).join('');
                list.innerHTML = `
                    <div class="source-item warning" style="border-left: 4px solid var(--accent-orange, #f97316); padding: 16px; background: rgba(249,115,22,0.05); border-radius: var(--radius-md, 8px);">
                        <div class="info">
                            <span class="source-name" style="font-weight:bold; color:var(--accent-orange, #f97316); font-size:1.1rem; display:block; margin-bottom:4px;">Miruro (Uncertain Match)</span>
                            <span class="confidence" style="font-size:0.9rem; color:var(--text-secondary);">Confidence: ${Math.round(confidence)}%</span>
                            <p class="match-meta" style="margin:8px 0; font-size:0.95rem;">Resolved Show: <strong>${data.title || 'Unknown'}</strong></p>
                            <div class="match-reasons" style="font-size:0.8rem; color:var(--text-muted); margin-top:12px; border-top: 1px solid var(--border-soft); padding-top:8px;">
                                <p style="margin:0 0 6px 0; font-weight:bold; color:var(--text-secondary);">Match Reasoning Details:</p>
                                <ul style="margin:0; padding-left:16px; line-height:1.4;">${reasonsList}</ul>
                            </div>
                        </div>
                        <div class="actions" style="margin-top:16px; display:flex; gap:8px;">
                            <button class="play-btn" style="background:var(--accent-orange, #f97316); border:none; padding:8px 16px; border-radius:4px; color:#fff; font-weight:bold; cursor:pointer;">Open Stream anyway</button>
                        </div>
                    </div>
                `;
                list.querySelector('.play-btn').onclick = () => {
                    window.open(data.url, '_blank');
                    closeModal();
                };
            } else {
                // Reject match and prompt manual search
                if (win) win.close();
                const reasonsList = (data.reasons || []).map(r => `<li style="margin-bottom:4px;">${r}</li>`).join('');
                
                list.innerHTML = `
                    <div class="empty" style="padding:16px; text-align:center;">
                        <p style="color:var(--text-danger, #ef4444); font-weight:bold; font-size:1.1rem; margin:0 0 8px 0;">No Reliable Match Found</p>
                        <p style="font-size:0.9rem; color:var(--text-secondary); margin:4px 0;">Max Match Confidence: ${Math.round(confidence)}%</p>
                        <p style="font-size:0.85rem; color:var(--text-muted); margin-top:4px;">Best candidate resolved: ${data.title || 'None'}</p>
                        <div class="match-reasons" style="font-size:0.78rem; text-align:left; color:var(--text-muted); margin-top:16px; border-top:1px solid var(--border-soft); padding-top:8px;">
                            <p style="margin:0 0 6px 0; font-weight:bold; color:var(--text-secondary);">Analysis Log:</p>
                            <ul style="margin:0; padding-left:16px; line-height:1.4;">${reasonsList}</ul>
                        </div>
                        <a href="${data.url}" target="_blank" class="search-fallback" style="display:inline-block; margin-top:20px; color:var(--accent-primary, #3b82f6); text-decoration:none; border: 1px solid var(--accent-primary, #3b82f6); padding:8px 16px; border-radius:4px; font-weight:bold; transition:all 0.2s;">Search Miruro Manually</a>
                    </div>
                `;
            }
        } else {
            if (win) win.close();
            list.innerHTML = '<div class="empty">No online stream found.</div>';
        }
    } catch (err) {
        if (win) win.close();
        list.innerHTML = '<div class="error">Online stream resolution failed. Check internet connection.</div>';
        showToast('Miruro resolution error', 'error');
    }
}
