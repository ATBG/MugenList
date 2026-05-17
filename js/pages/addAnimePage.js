/**
 * addAnimePage.js — Add anime via Jikan search (v2 schema)
 * Overhauled to implement Prompt 31: Simple Season Fetching and Grouped Add Flow
 */

import { backendSearch, backendGetRelations, backendSaveFranchise } from '../services/backendSearchService.js';
import { addAnimeFromBackend } from '../services/animeManager.js';
import { getState, getRootDisplayTitle } from '../state.js';
import { debounce, showToast } from '../utils.js';

let _selectedAnime = null;
let _searchResults = [];
let _searchPage = 1;

export function render(container) {
  _selectedAnime = null;
  _searchResults = [];
  _searchPage = 1;

  container.innerHTML = `
    <div class="add-anime-layout">
      <!-- Search panel -->
      <div>
        <div class="form-group">
          <label class="form-label">Search Anime</label>
          <div class="search-bar" style="border-radius:var(--radius);max-width:100%;">
            <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input class="palette-input" id="jikan-search-input" type="search" placeholder="e.g. Attack on Titan, Naruto…" style="font-size:1rem;padding:12px 14px;" autocomplete="off" aria-controls="search-results" aria-expanded="false" />
          </div>
        </div>
        <div id="search-status" style="font-size:0.85rem;color:var(--text-muted);margin-bottom:10px;min-height:22px;"></div>
        <div class="search-results-grid" id="search-results" role="listbox" aria-label="Anime search results"></div>
        <button class="btn btn--secondary" id="load-more-btn" style="margin-top:14px;display:none;width:100%;padding:12px;">Load More</button>
      </div>

      <!-- Detail panel -->
      <div>
        <div class="detail-panel" id="detail-panel">
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:200px;color:var(--text-muted);text-align:center;gap:12px;">
            <div style="font-size:2.5rem;">🔍</div>
            <div>Search for an anime and click to see details</div>
          </div>
        </div>
      </div>
    </div>
  `;

  const input = document.getElementById('jikan-search-input');
  input?.addEventListener('input', debounce(async (e) => {
    const q = e.target.value.trim();
    if (!q) { 
        document.getElementById('search-results').innerHTML = ''; 
        document.getElementById('search-status').textContent = '';
        document.getElementById('load-more-btn').style.display = 'none';
        return; 
    }
    _searchPage = 1;
    await doSearch(q, true);
  }, 500));

  document.getElementById('load-more-btn')?.addEventListener('click', async () => {
    const q = input?.value?.trim();
    if (!q) return;
    _searchPage++;
    await doSearch(q, false);
  });
}

async function doSearch(query, reset = true) {
  const status = document.getElementById('search-status');
  const grid = document.getElementById('search-results');
  const loadMore = document.getElementById('load-more-btn');
  if (status) status.textContent = 'Searching…';
  if (reset) { _searchResults = []; if (grid) grid.innerHTML = ''; }

  try {
    const res = await backendSearch(query);
    const results = res.results || [];
    _searchResults = results;
    if (status) status.textContent = `Found ${results.length} results`;

    results.forEach(anime => {
      const card = buildResultCard(anime);
      grid?.appendChild(card);
    });

    if (loadMore) {
      loadMore.style.display = 'none'; // Backend searches return standard list, client-side load more disabled
    }
  } catch (err) {
    if (status) status.textContent = 'Search failed. Check your connection.';
  }
}

function buildResultCard(anime) {
  const card = document.createElement('div');
  card.className = 'search-result-card';
  card.dataset.malId = anime.mal_id;
  
  const infoParts = [];
  if (anime.type) infoParts.push(anime.type);
  if (anime.episodes) infoParts.push(`${anime.episodes} eps`);
  if (anime.year) infoParts.push(anime.year);
  const infoText = infoParts.join(' • ');

  card.innerHTML = `
    <div class="search-result-poster">
      <img src="${anime.poster || ''}" alt="${anime.title}" onerror="this.parentElement.style.background='var(--bg-elevated)'" loading="lazy" />
      ${anime.score ? `<div class="search-result-score" style="position:absolute; bottom:6px; right:6px; background:rgba(0,0,0,0.7); font-size:0.75rem; padding:2px 6px; border-radius:4px; font-weight:600; color:var(--accent);">⭐ ${anime.score}</div>` : ''}
    </div>
    <div class="search-result-info-box" style="padding:10px; display:flex; flex-direction:column; gap:4px;">
      <div class="search-result-title" style="font-size:0.85rem; font-weight:600; line-height:1.3; overflow:hidden; text-overflow:ellipsis; display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical; height:2.6em; color:var(--text-primary);">${anime.title}</div>
      <div class="search-result-meta" style="font-size:0.75rem; color:var(--text-muted);">${infoText}</div>
    </div>
  `;
  card.addEventListener('click', () => {
    document.querySelectorAll('.search-result-card.selected').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    showDetail(anime);
  });
  return card;
}

function isAnimeInLibrary(malId) {
    const library = getState('library') || [];
    return library.some(g => Object.values(g.seasons).some(s => s.mal_id === Number(malId)));
}

async function showDetail(anime) {
  _selectedAnime = anime;
  const panel = document.getElementById('detail-panel');
  if (!panel) return;

  // Show loading spinner
  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:300px;color:var(--text-muted);gap:14px;text-align:center;">
      <div class="spinner" style="border: 3px solid rgba(255,255,255,0.05); border-top: 3px solid var(--accent); border-radius:50%; width:36px; height:36px; animation: spin 1s linear infinite;"></div>
      <div style="font-size:0.85rem;letter-spacing:0.05em;text-transform:uppercase;color:var(--accent);font-weight:700;">Building Franchise Graph…</div>
      <div style="font-size:0.8rem;color:var(--text-secondary);max-width:200px;">Analyzing sequels, prequels, and candidate seasons on backend</div>
    </div>
  `;

  // Define key spin animation if not exists
  if (!document.getElementById('spin-keyframes')) {
    const style = document.createElement('style');
    style.id = 'spin-keyframes';
    style.innerHTML = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .relation-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px;
        border-radius: 8px;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.05);
        margin-bottom: 8px;
        transition: all 0.2s ease;
      }
      .relation-item:hover {
        background: rgba(255,255,255,0.04);
        border-color: rgba(255,255,255,0.1);
        transform: translateX(4px);
      }
      .relation-item.main-checked {
        border-color: rgba(var(--accent-rgb), 0.3);
        background: rgba(var(--accent-rgb), 0.03);
      }
      .relation-badge {
        font-size: 0.65rem;
        font-weight: 700;
        text-transform: uppercase;
        padding: 2px 6px;
        border-radius: 4px;
        letter-spacing: 0.05em;
      }
    `;
    document.head.appendChild(style);
  }

  try {
    const data = await backendGetRelations(anime.mal_id);
    const main = data.main || anime;
    const relations = data.relations || [];

    // Check if main is already in library
    const alreadyInLib = isAnimeInLibrary(main.mal_id);

    // Let's filter out relations that are already in the library
    const filteredRelations = relations.map(r => ({
      ...r,
      alreadyInLibrary: isAnimeInLibrary(r.mal_id)
    }));

    // Build the UI
    let relationsHtml = '';
    if (filteredRelations.length === 0) {
      relationsHtml = `
        <div style="padding:16px;background:rgba(255,255,255,0.02);border:1px dashed rgba(255,255,255,0.08);border-radius:8px;text-align:center;color:var(--text-muted);font-size:0.8rem;">
          No sequel, prequel, or related seasons detected.
        </div>
      `;
    } else {
      relationsHtml = filteredRelations.map(rel => {
        const typeLabel = rel.relationType || 'RELATED';
        let badgeStyle = 'border: 1px solid var(--text-muted); color: var(--text-muted);';
        if (typeLabel === 'SEQUEL') {
          badgeStyle = 'border: 1px solid var(--accent); color: var(--accent); background: rgba(var(--accent-rgb), 0.08);';
        } else if (typeLabel === 'PREQUEL') {
          badgeStyle = 'border: 1px solid var(--neon-blue); color: var(--neon-blue); background: rgba(0, 150, 255, 0.08);';
        } else if (['CHILD', 'PARENT', 'SPIN_OFF'].includes(typeLabel)) {
          badgeStyle = 'border: 1px solid var(--status-planning); color: var(--status-planning); background: rgba(140, 80, 255, 0.08);';
        }

        const isChecked = rel.prechecked && !rel.alreadyInLibrary;
        const isDisabled = rel.alreadyInLibrary;

        return `
          <label class="relation-item ${isChecked ? 'main-checked' : ''}" style="cursor: ${isDisabled ? 'default' : 'pointer'}; opacity: ${isDisabled ? 0.6 : 1};">
            <input type="checkbox" class="relation-checkbox" data-mal-id="${rel.mal_id}" ${isChecked ? 'checked' : ''} ${isDisabled ? 'disabled' : ''} style="accent-color: var(--accent); width:18px; height:18px;" />
            <div style="flex-grow:1; display:flex; flex-direction:column; gap:2px;">
              <div style="font-size:0.85rem; font-weight:600; color:var(--text-primary); line-height:1.3;">${rel.title}</div>
              <div style="display:flex; align-items:center; gap:8px; font-size:0.75rem; color:var(--text-muted);">
                <span>${rel.format || 'TV'}</span> •
                <span>${rel.episodes ? `${rel.episodes} eps` : 'unknown eps'}</span>
                ${rel.alreadyInLibrary ? '<span style="color:var(--neon-green); font-weight:600;">[In Library]</span>' : ''}
              </div>
            </div>
            <span class="relation-badge" style="${badgeStyle}">${typeLabel.replace('_', ' ')}</span>
          </label>
        `;
      }).join('');
    }

    panel.innerHTML = `
      <div class="detail-header" style="display:flex;gap:16px;margin-bottom:16px;">
        <img src="${main.poster || anime.poster}" alt="${main.title}" style="width:110px;height:154px;object-fit:cover;border-radius:8px;box-shadow: 0 4px 20px rgba(0,0,0,0.5);flex-shrink:0;" onerror="this.style.display='none'" />
        <div style="display:flex; flex-direction:column; justify-content:space-between; flex-grow:1;">
          <div>
            <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:6px;line-height:1.3;color:var(--text-primary);">${main.title}</h3>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
              ${(main.genres || anime.genres || []).slice(0, 3).map(g => `<span class="genre-tag" style="font-size:0.7rem;padding:2px 8px;">${g}</span>`).join('')}
            </div>
          </div>
          <div style="font-size:0.8rem;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px;">
            <div>Format: <strong style="color:var(--text-primary);">${main.type || 'TV'}</strong></div>
            <div>Episodes: <strong style="color:var(--text-primary);">${main.episodes || 'unknown'}</strong></div>
            <div>Score: <strong style="color:var(--accent);">⭐ ${main.score || 'unrated'}</strong></div>
          </div>
        </div>
      </div>

      <p style="font-size:0.78rem;color:var(--text-secondary);line-height:1.6;margin-bottom:20px;background:rgba(255,255,255,0.01);padding:10px;border-radius:6px;border:1px solid rgba(255,255,255,0.03); max-height:80px; overflow-y:auto;">
        ${main.synopsis || anime.synopsis || 'No synopsis available.'}
      </p>

      <div class="divider" style="margin: 16px 0;"></div>

      <h4 style="font-size:0.9rem; font-weight:700; color:var(--text-primary); margin-bottom:12px; display:flex; align-items:center; gap:8px;">
        <span>📦</span> Related Seasons & Prequels/Sequels
      </h4>
      
      <div style="max-height: 240px; overflow-y: auto; padding-right: 4px; margin-bottom: 20px;">
        <!-- Main title is always implicit and checked -->
        <label class="relation-item main-checked" style="opacity:0.9; cursor:default;">
          <input type="checkbox" checked disabled style="accent-color: var(--accent); width:18px; height:18px;" />
          <div style="flex-grow:1; display:flex; flex-direction:column; gap:2px;">
            <div style="font-size:0.85rem; font-weight:600; color:var(--text-primary); line-height:1.3;">${main.title}</div>
            <div style="font-size:0.75rem; color:var(--text-muted); display:flex; align-items:center; gap:8px;">
              <span>${main.type || 'TV'}</span> • <span>${main.episodes ? `${main.episodes} eps` : 'unknown eps'}</span>
              ${alreadyInLib ? '<span style="color:var(--neon-green); font-weight:600;">[In Library]</span>' : ''}
            </div>
          </div>
          <span class="relation-badge" style="border: 1px solid var(--accent); color: var(--accent); background: rgba(var(--accent-rgb), 0.1);">MAIN ENTRY</span>
        </label>

        ${relationsHtml}
      </div>

      <button class="btn btn--primary" id="add-confirm-btn" style="width:100%;padding:14px 16px;font-size:0.95rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; display:flex; align-items:center; justify-content:center; gap:8px;" ${alreadyInLib && filteredRelations.every(r => r.alreadyInLibrary) ? 'disabled style="background:var(--bg-elevated);color:var(--text-muted);cursor:default;"' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        ${alreadyInLib && filteredRelations.every(r => r.alreadyInLibrary) ? 'All items in Library' : 'Add Checked Titles'}
      </button>
    `;

    // Watch for checkbox changes to highlight selected relation cards
    panel.querySelectorAll('.relation-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const item = cb.closest('.relation-item');
        if (cb.checked) {
          item?.classList.add('main-checked');
        } else {
          item?.classList.remove('main-checked');
        }
      });
    });

    // Add click handler
    document.getElementById('add-confirm-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('add-confirm-btn');
      if (btn) { 
        btn.innerHTML = `
          <div class="spinner" style="border: 2px solid rgba(0,0,0,0.1); border-top: 2px solid #000; border-radius:50%; width:16px; height:16px; animation: spin 1s linear infinite;"></div>
          <span>Assembling Franchise Bundle…</span>
        `; 
        btn.disabled = true; 
      }

      // Collect selected IDs (main is always included)
      const selectedIds = [Number(main.mal_id)];
      panel.querySelectorAll('.relation-checkbox').forEach(cb => {
        if (cb.checked && !cb.disabled) {
          selectedIds.push(Number(cb.dataset.malId));
        }
      });

      try {
        const bundle = await backendSaveFranchise(Number(main.mal_id), selectedIds);
        const stored = await addAnimeFromBackend(bundle);
        
        if (stored) {
          showToast('Franchise created and saved successfully!', 'success');
          if (btn) {
            btn.innerHTML = '✓ Added to Library!';
            btn.style.background = 'var(--neon-green)';
            btn.style.color = '#000';
            btn.disabled = true;
          }
          setTimeout(() => {
            showDetail(anime);
          }, 1500);
        } else {
          showToast('Failed to save to local IndexedDB.', 'error');
          if (btn) {
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add Checked Titles';
            btn.disabled = false;
          }
        }
      } catch (err) {
        showToast('Failed to add: ' + err.message, 'error');
        if (btn) {
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add Checked Titles';
          btn.disabled = false;
        }
      }
    });

  } catch (err) {
    panel.innerHTML = `
      <div style="padding:24px; text-align:center; color:var(--status-planning);">
        <div style="font-size:2rem; margin-bottom:8px;">⚠️</div>
        <div style="font-size:0.85rem; font-weight:600;">Failed to load franchise relations</div>
        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">${err.message}</div>
      </div>
    `;
  }
}
