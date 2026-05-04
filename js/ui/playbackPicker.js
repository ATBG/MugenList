import { showToast } from '../utils.js';
import { getState } from '../state.js';
import { closeModal } from './dialogs.js';
import { BACKEND_URL } from '../api.js';

/**
 * Opens a picker for the user to choose a playback source.
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
                <span class="desc">Search and stream via AniKai</span>
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
        modeSelection.classList.add('hidden');
        resultsArea.classList.remove('hidden');
        loadLocalSource(anime, episode, content);
    });

    content.querySelector('#btn-online')?.addEventListener('click', () => {
        modeSelection.classList.add('hidden');
        resultsArea.classList.remove('hidden');
        loadAnikaiSource(anime, episode, content);
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

        const res = await fetch(`${BACKEND_URL}/api/local/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: selectedPath })
        });

        if (!res.ok) throw new Error('Backend scan failed');

        const data = await res.json();
        const file = (data.files || []).find(f => f.episode === episode);

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
                        showToast('Failed to play file', 'error');
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
                            showToast('Failed to launch PotPlayer', 'error');
                        }
                    } catch (e) {
                        showToast('Playback error', 'error');
                    }
                };
            }
        } else {
            list.innerHTML = '<div class="empty">No local file found for this episode in the selected folder.</div>';
        }
    } catch (err) {
        console.error('Local playback flow failed', err);
        list.innerHTML = '<div class="error">Local play failed.</div>';
        showToast('Local play error', 'error');
    }
}

async function loadAnikaiSource(anime, episode, container) {
    const list = container.querySelector('#source-list');
    list.innerHTML = '<div class="loading">Resolving online stream...</div>';
    
    // We only open the tab if we are highly confident we'll jump.
    // To prevent pop-up blocking issues, we'll open it now but with a "Resolving" message.
    const win = window.open('about:blank', '_blank');
    if (win) win.document.write('<html><head><title>Resolving AniKai...</title><style>body{background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;margin:0;}</style></head><body><h2>Jumping to AniKai...</h2></body></html>');

    try {
        // Gather all possible titles for better matching
        // Prioritize English/Romaji title for search queries as Kanji can cause URL issues
        const title = anime.title_english || anime.title || anime.title_japanese;
        const alt_titles = [
            anime.title_english,
            anime.title_japanese,
            ...(anime.synonyms || [])
        ].filter(t => t && t !== title);
        
        // Get the current season object
        const seasonId = String(anime.selected_season_mal_id);
        const seasonObj = anime.seasons ? anime.seasons[seasonId] : null;

        // Try to derive an explicit season number. Priority:
        // 1) season_number on the season object (preferred)
        // 2) explicit ordinal parsed from the season's title (e.g. "Season 3", "3rd Season", "S3")
        // 3) fallback to franchise_order_index (already 1-based)
        // 4) final fallback to 1
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

        let season = null;
        if (seasonObj && Number.isFinite(Number(seasonObj.season_number))) {
            season = Number(seasonObj.season_number);
        } else {
            // Try parsing from common title fields on the season object first
            const probe = seasonObj?.title_english || seasonObj?.title || seasonObj?.title_japanese || anime.title_english || anime.title || anime.title_japanese;
            const parsed = extractSeasonOrdinalFromString(probe);
            season = parsed || anime.franchise_order_index || 1;
        }

        season = Number.isFinite(Number(season)) ? Number(season) : 1;
        const total_episodes = seasonObj?.total_episodes || 0;
        
        console.log('AniKai Resolution Payload:', { title, alt_titles, episode, season, total_episodes });
        
        const startTime = Date.now();
        const res = await fetch(`${BACKEND_URL}/api/anikai/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                title: title, 
                alt_titles: alt_titles,
                episode,
                season: season,
                total_episodes: total_episodes
            })
        });
        const duration = (Date.now() - startTime) / 1000;
        console.log(`AniKai Resolution took ${duration.toFixed(2)}s`);

        if (!res.ok) throw new Error('Resolution failed');
        
        const data = await res.json();
        const confidence = data.confidence || 0;
        
        if (data.url) {
            // Requirement: Verify match before opening. Reject low-confidence.
            if (confidence >= 90) {
                // High confidence: Auto-jump
                if (win) win.location.href = data.url;
                else window.location.href = data.url;
                closeModal();
            } else if (confidence >= 75) {
                // Moderate confidence: Ask for validation (Requirement: Show a clear message if uncertain)
                if (win) win.close();
                list.innerHTML = `
                    <div class="source-item warning">
                        <div class="info">
                            <span class="source-name">AniKai (Uncertain Match)</span>
                            <span class="confidence">Confidence: ${Math.round(confidence)}%</span>
                            <p class="match-meta">Match: ${data.matched?.title || 'Unknown'}</p>
                        </div>
                        <button class="play-btn">Open Anyway</button>
                    </div>
                `;
                list.querySelector('.play-btn').onclick = () => {
                    window.open(data.url, '_blank');
                    closeModal();
                };
            } else {
                // Low confidence: Reject (Requirement: Reject low-confidence matches)
                if (win) win.close();
                list.innerHTML = `
                    <div class="empty">
                        <p>No reliable match found (Max Confidence: ${Math.round(confidence)}%)</p>
                        <p style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">Result found: ${data.matched?.title || 'None'}</p>
                        <a href="${data.url}" target="_blank" class="search-fallback">Search AniKai Manually</a>
                    </div>
                `;
            }
        } else {
            if (win) win.close();
            list.innerHTML = '<div class="empty">No online stream found.</div>';
        }
    } catch (err) {
        if (win) win.close();
        list.innerHTML = '<div class="error">Online resolution failed.</div>';
        showToast('AniKai resolution error', 'error');
    }
}
