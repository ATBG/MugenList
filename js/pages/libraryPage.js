/**
 * libraryPage.js — Library view matching recommendations page layout (v4)
 * Uses page-content scroll context, centered container, section-style header.
 */

import { getState, subscribe, getFilters } from '../state.js';
import { createAnimeCard, updateCardFromAnime } from '../ui/animeCard.js';
import { createAnimeRow } from '../ui/animeRow.js';
import { applyFiltersAndSort } from '../ui/filtersPanel.js';

let _unsubs = [];
let _trayOpen = false;
let _prevUpdatedMap = {}; // root_mal_id -> updated_date

export function render(container) {
  const readyState = getState('readyState');

  if (readyState !== 'ready') {
    container.innerHTML = `
      <div class="library-container">
        <div class="library-page-header">
          <div class="library-page-header__inner">
            <div>
              <h1 class="library-page-title">My Library</h1>
              <p class="library-page-subtitle">Loading your collection…</p>
            </div>
          </div>
        </div>
        <div class="anime-grid">
          ${Array(12).fill('<div class="skeleton-card"></div>').join('')}
        </div>
      </div>
    `;

    const unsub = subscribe('readyState', (state) => {
      if (state === 'ready') { unsub(); render(container); }
    });
    return;
  }

  _trayOpen = false;

  container.innerHTML = `
    <div class="library-container">

      <!-- Page header — matches recommendations style -->
      <div class="library-page-header">
        <div class="library-page-header__inner">
          <div class="library-page-header__left">
            <div>
              <h1 class="library-page-title">My Library</h1>
              <p class="library-page-subtitle" id="library-subtitle">Loading…</p>
            </div>
          </div>
          <div class="library-page-header__right">
            <!-- View toggle -->
            <div class="view-toggle-group">
              <button id="view-grid" class="view-btn" title="Grid View">
                <svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
              </button>
              <button id="view-list" class="view-btn" title="List View">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3" cy="6" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/><circle cx="3" cy="18" r="1" fill="currentColor"/></svg>
              </button>
            </div>

            <!-- Search -->
            <div class="library-search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input id="header-search" type="text" placeholder="Search…" class="library-search-input" autocomplete="off" />
            </div>

            <!-- Filters button -->
            <button class="btn btn--ghost btn-filters" id="filters-toggle">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
              Filters
            </button>
          </div>
        </div>

        <!-- Quick-filter pills row -->
        <div class="library-pills-row" id="quick-filters-bar"></div>
      </div>

      <!-- Grid / List -->
      <div id="library-view" class="anime-grid"></div>

    </div>

    <!-- Tray (portal-level) -->
    <div id="tray-backdrop" class="tray-backdrop"></div>
    <aside id="filters-panel" class="filters-tray hidden" aria-label="Filters"></aside>
  `;

  // Set initial view mode
  const currentView = getState('viewMode') || 'grid';
  _syncViewBtns(currentView);

  // Pre-populate search from state
  const searchEl = document.getElementById('header-search');
  if (searchEl) {
    searchEl.value = getFilters().search || '';
    searchEl.addEventListener('input', async (e) => {
      const { patchState } = await import('../state.js');
      patchState('filters', { search: e.target.value });
    });
  }

  // View toggle
  document.getElementById('view-grid')?.addEventListener('click', async () => {
    const { setState: ss, getState: gs } = await import('../state.js');
    const { saveSettings } = await import('../storage.js');
    ss('viewMode', 'grid');
    saveSettings({ ...(gs('settings') || {}), view_mode: 'grid' });
    _syncViewBtns('grid');
  });

  document.getElementById('view-list')?.addEventListener('click', async () => {
    const { setState: ss, getState: gs } = await import('../state.js');
    const { saveSettings } = await import('../storage.js');
    ss('viewMode', 'list');
    saveSettings({ ...(gs('settings') || {}), view_mode: 'list' });
    _syncViewBtns('list');
  });

  // Tray open/close
  const filtersToggle = document.getElementById('filters-toggle');
  const filtersTray   = document.getElementById('filters-panel');
  const trayBackdrop  = document.getElementById('tray-backdrop');

  const openTray = () => {
    _trayOpen = true;
    filtersTray.classList.add('open');
    filtersTray.classList.remove('hidden');
    trayBackdrop.classList.add('open');
    filtersToggle.classList.add('active');
  };
  const closeTray = () => {
    _trayOpen = false;
    filtersTray.classList.remove('open');
    filtersTray.classList.add('hidden');
    trayBackdrop.classList.remove('open');
    filtersToggle.classList.remove('active');
  };

  filtersToggle?.addEventListener('click', () => _trayOpen ? closeTray() : openTray());
  trayBackdrop?.addEventListener('click', closeTray);

  const escHandler = (e) => {
    if (e.key === 'Escape' && _trayOpen) closeTray();
    if (!document.getElementById('filters-toggle')) document.removeEventListener('keydown', escHandler);
  };
  document.addEventListener('keydown', escHandler);

  // Init filters panel
  import('../ui/filtersPanel.js').then(m => m.initFiltersPanel()).catch(err => console.warn('Failed to init filtersPanel', err));

  // State subscriptions
  _unsubs.forEach(u => u());
  _unsubs = [];
  _unsubs.push(subscribe('library', (lib) => _onLibraryChanged(lib)));
  _unsubs.push(subscribe('filters', () => _redraw()));
  _unsubs.push(subscribe('viewMode', () => _redraw()));

  _renderPills();
  _redraw();
}

function _onLibraryChanged(library) {
  // library subscription — perform incremental patch when possible
  try {
    const view = document.getElementById('library-view');
    if (!view) return;
    if ((getState('viewMode') || 'grid') === 'list') {
      _redraw();
      return;
    }
    // If view currently empty (initial), just redraw
    if (view.childElementCount === 0) {
      _redraw();
      return;
    }

    // Apply filters + sort same as _redraw
    const filters = getFilters();
    const filtered = applyFiltersAndSort(library || [], filters);
    const limit = Math.min(filtered.length, 500);

    // Build a set of current root ids in new list
    const newIds = new Set(filtered.slice(0, limit).map(i => Number(i.root_mal_id)));

    // Remove DOM nodes that are no longer in filtered results
    const existingNodes = Array.from(view.querySelectorAll('.anime-card'));
    for (const node of existingNodes) {
      const rid = Number(node.dataset.rootId || node.getAttribute('data-root-id'));
      if (!newIds.has(rid)) {
        node.remove();
        delete _prevUpdatedMap[rid];
      }
    }

    // Update or append changed/new items
    for (let i = 0; i < limit; i++) {
      const item = filtered[i];
      const rid = Number(item.root_mal_id);
      const prev = _prevUpdatedMap[rid];
      const updatedDate = item.updated_date || '';

      const existing = view.querySelector(`.anime-card[data-root-id="${rid}"]`);
      if (existing) {
        // If updated_date changed, update DOM in place
        if (prev !== updatedDate) {
          try { updateCardFromAnime(item); } catch (e) { console.warn('Patch update failed', e); }
        }
      } else {
        // New item: append node
        try {
          const node = getState('viewMode') === 'list' ? createAnimeRow(item) : createAnimeCard(item);
          if (node) view.appendChild(node);
        } catch (e) {
          console.warn('Failed to append new card', e);
        }
      }

      _prevUpdatedMap[rid] = updatedDate;
    }
  } catch (err) {
    console.error('Incremental library patch failed, falling back to full redraw', err);
    _redraw();
  }
}

/* ── helpers ─────────────────────────────────────────────────────── */

function _syncViewBtns(mode) {
  document.getElementById('view-grid')?.classList.toggle('active', mode === 'grid');
  document.getElementById('view-list')?.classList.toggle('active', mode === 'list');
}

function _redraw() {
  const view     = document.getElementById('library-view');
  const subtitle = document.getElementById('library-subtitle');
  if (!view) return;

  const library  = getState('library') || [];
  const filters  = getFilters();
  const viewMode = getState('viewMode') || 'grid';
  const filtered = applyFiltersAndSort(library, filters);

  // Update pills active state
  _renderPills();

  // Subtitle count
  if (subtitle) {
    const hasFilter = (filters.search?.trim()) || filters.genres?.length || filters.watchStatus?.length;
    subtitle.textContent = hasFilter
      ? `${filtered.length} of ${library.length} titles`
      : `${library.length} titles in your collection`;
  }

  // Empty state
  if (filtered.length === 0) {
    const noLib  = library.length === 0;
    const noSearch = !noLib && filters.search?.trim();
    view.className = 'library-empty-area';
    view.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${noLib ? '📚' : noSearch ? '🔍' : '🎯'}</div>
        <h3 class="empty-state-title">${noLib ? 'Your library is empty' : noSearch ? 'No results' : 'No matches'}</h3>
        <p class="empty-state-desc">${
          noLib    ? 'Add your first anime to start tracking.' :
          noSearch ? `Nothing matches "${filters.search}".` :
                     'Try adjusting your filters.'
        }</p>
        ${noLib ? `<button class="btn btn--primary empty-state-action" id="empty-add-btn">Add Anime</button>` : ''}
        ${!noLib && !noSearch ? `<button class="btn btn--secondary empty-state-action" id="empty-clear-btn">Clear Filters</button>` : ''}
      </div>
    `;
    document.getElementById('empty-add-btn')?.addEventListener('click', () => {
      import('../ui/workspaceTabs.js').then(m => m.openTab({ type: 'add', id: 'system-add', title: 'Add Anime', closable: true })).catch(err => console.warn('Failed to open add tab', err));
    });
    document.getElementById('empty-clear-btn')?.addEventListener('click', () => {
      import('../ui/filtersPanel.js').then(m => m.clearFilters()).catch(err => console.warn('Failed to load filtersPanel to clear filters', err));
    });
    return;
  }

  // Set grid/list class matching recommendations `.anime-grid`
  view.className = viewMode === 'list' ? 'library-list-view' : 'anime-grid';

  // Render cards
  const frag = document.createDocumentFragment();
  const limit = Math.min(filtered.length, 500);
  for (let i = 0; i < limit; i++) {
    try {
      const node = viewMode === 'list' ? createAnimeRow(filtered[i]) : createAnimeCard(filtered[i]);
      if (node) frag.appendChild(node);
    } catch (err) {
      console.error('Card render error:', err);
    }
  }
  view.innerHTML = '';
  view.appendChild(frag);
}

function _renderPills() {
  const bar = document.getElementById('quick-filters-bar');
  if (!bar) return;

  const active = getFilters().watchStatus || [];
  const statuses = [
    { id: 'watching',      label: 'Watching',   color: '#38bdf8' },
    { id: 'completed',     label: 'Completed',  color: '#34d399' },
    { id: 'plan_to_watch', label: 'Planned',    color: '#fbbf24' },
    { id: 'paused',        label: 'On Hold',    color: '#fb923c' },
    { id: 'dropped',       label: 'Dropped',    color: '#f87171' },
  ];

  bar.innerHTML = statuses.map(s => `
    <button class="lib-pill ${active.includes(s.id) ? 'lib-pill--active' : ''}" data-status="${s.id}">
      <span class="lib-pill__dot" style="background:${s.color};box-shadow:0 0 5px ${s.color}88"></span>
      ${s.label}
    </button>
  `).join('');

  bar.querySelectorAll('.lib-pill').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { patchState, getState: gs } = await import('../state.js');
      const cur = [...(gs('filters')?.watchStatus || [])];
      const id  = btn.dataset.status;
      patchState('filters', {
        watchStatus: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
      });
    });
  });
}
