/**
 * addAnimePage.js — Add anime via Jikan search (v2 schema)
 */

import { searchAnime, getAnimeById } from '../services/jikanClient.js';
import { addAnimeEntry, addSeasonToEntry } from '../services/animeManager.js';
import { scanForNewSeasons } from '../services/relationEngine.js';
import { openRelationSelectionDialog } from '../ui/dialogs.js';
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
    const { results, pagination } = await searchAnime(query, _searchPage, 20);
    _searchResults.push(...results);
    if (status) status.textContent = `Found ${pagination?.items?.total || results.length} results`;

    results.forEach(anime => {
      const card = buildResultCard(anime);
      grid?.appendChild(card);
    });

    if (loadMore) {
      loadMore.style.display = pagination?.has_next_page ? 'block' : 'none';
    }
  } catch (err) {
    if (status) status.textContent = err.message.includes('429') ? 'Rate limited — please wait a moment.' : 'Search failed. Check your connection.';
  }
}

function buildResultCard(anime) {
  const card = document.createElement('div');
  card.className = 'search-result-card';
  card.dataset.malId = anime.mal_id;
  card.innerHTML = `
    <div class="search-result-poster">
      <img src="${anime.poster || ''}" alt="${anime.title}" onerror="this.parentElement.style.background='var(--bg-elevated)'" loading="lazy" />
    </div>
    <div class="search-result-title">${anime.title}</div>
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
    return library.some(g => Object.values(g.seasons).some(s => s.mal_id === malId));
}

async function showDetail(anime) {
  _selectedAnime = anime;
  const panel = document.getElementById('detail-panel');
  if (!panel) return;

  const library = getState('library') || [];
  const alreadyInLibrary = isAnimeInLibrary(anime.mal_id);

  panel.innerHTML = `
    <div style="display:flex;gap:12px;margin-bottom:16px;">
      <img src="${anime.poster}" alt="${anime.title}" style="width:90px;height:126px;object-fit:cover;border-radius:8px;flex-shrink:0;" onerror="this.style.display='none'" />
      <div>
        <h3 style="font-size:1rem;font-weight:700;margin-bottom:6px;line-height:1.3;">${anime.title}</h3>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
          ${(anime.genres || []).slice(0, 3).map(g => `<span class="genre-tag">${g}</span>`).join('')}
        </div>
        <div style="font-size:0.8rem;color:var(--text-muted);">
          ${anime.episodes ? `${anime.episodes} eps` : 'Unknown eps'} •
          ${anime.score ? `⭐ ${anime.score}` : 'Unrated'} •
          ${anime.year || 'Year unknown'}
        </div>
      </div>
    </div>
    <p style="font-size:0.8rem;color:var(--text-secondary);line-height:1.6;margin-bottom:16px;">${(anime.synopsis || 'No synopsis available.').slice(0, 300)}${anime.synopsis?.length > 300 ? '…' : ''}</p>
    <div class="divider"></div>
    <div style="margin-top:12px;">
      <div class="form-group">
        <label class="form-label">Add to Franchise</label>
        <select class="form-select" id="add-to-group-sel">
          <option value="new">➕ Create new franchise root</option>
          ${library.map(g => `<option value="${g.root_mal_id}">${getRootDisplayTitle(g)}</option>`).join('')}
        </select>
      </div>
      
      ${alreadyInLibrary ? '<div style="font-size:0.85rem;color:var(--status-watching);margin-bottom:10px;">Season already in library</div>' : ''}
      <button class="btn btn--primary" id="add-confirm-btn" style="width:100%;padding:12px 16px;font-size:0.95rem;" ${alreadyInLibrary ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        ${alreadyInLibrary ? 'Already in Library' : 'Add to Library'}
      </button>
    </div>
  `;

  document.getElementById('add-confirm-btn')?.addEventListener('click', async () => {
    const groupSel = document.getElementById('add-to-group-sel')?.value;
    const btn = document.getElementById('add-confirm-btn');
    if (btn) { btn.textContent = 'Adding…'; btn.disabled = true; }

    try {
      if (groupSel === 'new') {
        // Relation discovery logic
        const tempAnime = {
          root_mal_id: Number(anime.mal_id),
          selected_season_mal_id: Number(anime.mal_id),
          title_english: anime.title_english || anime.title,
          title_japanese: anime.title_jp || '',
          seasons: {},
          franchise_id: null,
        };

        let scanResult = { autoAdded: 0, suggestions: [], relationsFound: 0 };
        try {
          scanResult = await scanForNewSeasons(tempAnime, getState('library') || [], { maxDepth: 1 });
        } catch (err) {
          console.warn('Relation discovery failed:', err);
        }

        const candidates = scanResult.suggestions.map((sug) => ({
          mal_id: sug.mal_id,
          title: sug.jikanData?.title || sug.jikanData?.title_english || 'Unknown',
          poster: sug.jikanData?.poster || '',
          relationType: sug.relationType || 'RELATED',
          prechecked: ['SEQUEL','PREQUEL','CHILD','PARENT'].includes(sug.relationType || ''),
          jikanData: sug.jikanData,
          alreadyInLibrary: isAnimeInLibrary(sug.mal_id),
        }));

        if (candidates.length > 0) {
            openRelationSelectionDialog(anime, candidates, async (selected) => {
                try {
                    const rootEntry = await addAnimeEntry(anime);
                    if (rootEntry) {
                        for (const sel of selected || []) {
                            if (isAnimeInLibrary(sel.jikanData.mal_id)) continue;
                            try {
                                await addSeasonToEntry(Number(rootEntry.root_mal_id), sel.jikanData);
                            } catch (e) {
                                console.warn('Failed to add related season:', e);
                            }
                        }
                        showToast('Franchise created with related titles!', 'success');
                        showDetail(anime); // Refresh panel
                    }
                } catch (e) {
                    showToast('Failed adding franchise: ' + e.message, 'error');
                }
            });
            // Reset button if we opened a dialog
            if (btn) { btn.textContent = 'Add to Library'; btn.disabled = false; }
            return;
        } else {
            const entry = await addAnimeEntry(anime);
            if (entry) showToast('Franchise created!', 'success');
        }
      } else {
        await addSeasonToEntry(Number(groupSel), anime);
        showToast('Season added to franchise!', 'success');
      }
      
      if (btn) { 
          btn.textContent = '✓ Added!'; 
          btn.style.background = 'var(--neon-green)'; 
          btn.style.color = '#000'; 
          btn.disabled = true;
      }
      showDetail(anime); // Refresh panel
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
      if (btn) { btn.textContent = 'Add to Library'; btn.disabled = false; }
    }
  });
}
