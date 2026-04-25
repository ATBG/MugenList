/**
 * filtersPanel.js — Collapsible filter sidebar (v2 schema)
 */

import { getState, patchState, subscribe, getRootWatchStatus } from '../state.js';
import { debounce } from '../utils.js';
import { getAllSeriesScopes, filterBySeriesScope } from '../services/seriesCategorizer.js';

const ALL_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy',
  'Historical', 'Horror', 'Mystery', 'Romance', 'Sci-Fi',
  'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
];

const STATUSES = [
  { id: 'watching', label: 'Watching', dotClass: 'dot-watching' },
  { id: 'completed', label: 'Completed', dotClass: 'dot-completed' },
  { id: 'plan_to_watch', label: 'Plan to Watch', dotClass: 'dot-plan_to_watch' },
  { id: 'paused', label: 'On Hold', dotClass: 'dot-paused' },
  { id: 'dropped', label: 'Dropped', dotClass: 'dot-dropped' },
];

const SORT_OPTIONS = [
  { value: 'custom_order', label: 'Custom Order' },
  { value: 'title_asc', label: 'Title (A–Z)' },
  { value: 'title_desc', label: 'Title (Z–A)' },
  { value: 'progress_desc', label: 'Progress (High)' },
  { value: 'updated_date_desc', label: 'Recently Updated' },
];

export function initFiltersPanel() {
  const panel = document.getElementById('filters-panel');
  if (!panel) {
    console.error('❌ initFiltersPanel: filters-panel not found!');
    return;
  }

  // Remove all old event listeners by replacing the entire panel innerHTML
  const seriesScopes = getAllSeriesScopes();
  const currentFilters = getState('filters');
  
  console.log('🎨 Initializing filters panel with current filters:', currentFilters);
  
  const html = `
    <!-- Tray header with close -->
    <div class="filters-tray-header">
      <span class="filters-tray-title">⚙ Filters &amp; Sort</span>
      <button class="filters-tray-close" id="filters-tray-close-btn" aria-label="Close filters">✕</button>
    </div>
    <div class="filters-container">
      <!-- Genre Section -->
      <div class="filter-section">
        <h3 class="filter-section__title">Genre</h3>
        <div class="filter-section__content" id="genre-pills">
          ${ALL_GENRES.map(g => `<button class="filter-chip${currentFilters.genres.includes(g) ? ' filter-chip--active' : ''}" data-genre="${g}">${g}</button>`).join('')}
        </div>
      </div>
      
      <!-- Series Scope Section -->
      <div class="filter-section">
        <h3 class="filter-section__title">Series Scope</h3>
        <div class="filter-section__content" id="series-scope-pills">
          ${seriesScopes.map(s => `<button class="filter-chip${currentFilters.seriesScope.includes(s.id) ? ' filter-chip--active' : ''}" data-series-scope="${s.id}" title="${s.desc}">${s.icon} ${s.label}</button>`).join('')}
        </div>
      </div>
      
      <!-- Watch Status Section -->
      <div class="filter-section">
        <h3 class="filter-section__title">Watch Status</h3>
        <div class="filter-section__status-list" id="status-btns">
          ${STATUSES.map(s => `
            <button class="filter-status-btn${currentFilters.watchStatus.includes(s.id) ? ' filter-status-btn--active' : ''}" data-status="${s.id}">
              <span class="filter-status-dot ${s.dotClass}"></span>
              <span>${s.label}</span>
            </button>
          `).join('')}
        </div>
      </div>
      
      <!-- Sort Section -->
      <div class="filter-section">
        <h3 class="filter-section__title">Sort By</h3>
        <select class="select" id="sort-select">
          ${SORT_OPTIONS.map(o => `<option value="${o.value}"${o.value === currentFilters.sort ? ' selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </div>
      
      <!-- Clear Button -->
      <button class="btn btn--ghost" id="filters-clear" style="width: 100%; margin-top: auto;">Clear All Filters</button>
    </div>
  `;

  // Replace all content to clean up old listeners
  panel.innerHTML = html;

  // Now add event listeners to new elements
  // Genre pills
  const genrePills = panel.querySelectorAll('.filter-chip[data-genre]');
  console.log('   Found ' + genrePills.length + ' genre pills');
  genrePills.forEach(btn => {
    btn.addEventListener('click', function(e) {
      const genre = this.dataset.genre;
      console.log('🔘 Genre pill clicked:', genre);
      const freshFilters = getState('filters'); // Get fresh state
      const isActive = freshFilters.genres.includes(genre);
      const genres = isActive
        ? freshFilters.genres.filter(g => g !== genre)
        : [...freshFilters.genres, genre];
      console.log('   Old genres:', freshFilters.genres);
      console.log('   New genres:', genres);
      patchState('filters', { genres });
    });
  });

  // Series Scope pills
  const seriesScopePills = panel.querySelectorAll('.filter-chip[data-series-scope]');
  console.log('   Found ' + seriesScopePills.length + ' series scope pills');
  seriesScopePills.forEach(btn => {
    btn.addEventListener('click', function(e) {
      const scope = this.dataset.seriesScope;
      console.log('🔘 Series Scope pill clicked:', scope);
      const freshFilters = getState('filters');
      const isActive = freshFilters.seriesScope.includes(scope);
      const seriesScope = isActive
        ? freshFilters.seriesScope.filter(s => s !== scope)
        : [...freshFilters.seriesScope, scope];
      console.log('   Old seriesScope:', freshFilters.seriesScope);
      console.log('   New seriesScope:', seriesScope);
      patchState('filters', { seriesScope });
    });
  });

  // Status buttons
  const statusBtns = panel.querySelectorAll('.filter-status-btn');
  console.log('   Found ' + statusBtns.length + ' status buttons');
  statusBtns.forEach(btn => {
    btn.addEventListener('click', function(e) {
      const status = this.dataset.status;
      console.log('🔘 Status button clicked:', status);
      const freshFilters = getState('filters');
      const isActive = freshFilters.watchStatus.includes(status);
      const watchStatus = isActive
        ? freshFilters.watchStatus.filter(s => s !== status)
        : [...freshFilters.watchStatus, status];
      console.log('   Old watchStatus:', freshFilters.watchStatus);
      console.log('   New watchStatus:', watchStatus);
      patchState('filters', { watchStatus });
    });
  });

  // Sort select
  const sortSel = panel.querySelector('#sort-select');
  if (sortSel) {
    sortSel.addEventListener('change', function(e) {
      const newSort = this.value;
      console.log('🔘 Sort changed:', newSort);
      patchState('filters', { sort: newSort });
    });
  }

  // Clear
  const clearBtn = panel.querySelector('#filters-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', function(e) {
      console.log('🔘 Clear filters clicked');
      clearFilters();
    });
  }

  // Header search sync (header element is outside filters panel)
  const headerSearch = document.getElementById('header-search');
  if (headerSearch && !headerSearch._eventAttached) {
    console.log('   Attaching search input listener');
    headerSearch._eventAttached = true;
    headerSearch.addEventListener('input', debounce(function(e) {
      const query = e.target?.value || '';
      console.log('🔍 Search input:', query);
      patchState('filters', { search: query });
    }, 250));
  }

  // Tray close button (inner X)
  const closeTrayBtn = panel.querySelector('#filters-tray-close-btn');
  if (closeTrayBtn) {
    closeTrayBtn.addEventListener('click', () => {
      // Trigger tray close by simulating a backdrop click
      const backdrop = document.getElementById('tray-backdrop');
      if (backdrop) backdrop.click();
    });
  }

  console.log('✅ Filters panel initialized');
}

export function clearFilters() {
  patchState('filters', { 
    genres: [], 
    watchStatus: [], 
    seriesScope: [],
    airing: null, 
    sort: 'updated_date_desc', 
    search: '' 
  });
  const headerSearch = document.getElementById('header-search');
  if (headerSearch) headerSearch.value = '';
  document.querySelectorAll('.filter-chip--active, .filter-status-btn--active, .quick-filter-pill.active').forEach(b => {
    b.classList.remove('filter-chip--active', 'filter-status-btn--active', 'active');
  });
  const sortSel = document.querySelector('#sort-select, #filters-panel #sort-select');
  if (sortSel) sortSel.value = 'updated_date_desc';
}

export function applyFiltersAndSort(library, filters) {
  // Pure functional filtering - no mutations
  let result = Array.isArray(library) ? [...library] : [];

  console.log('🔍 applyFiltersAndSort: START with ' + result.length + ' items');
  console.log('   Filters:', filters);

  // 1. SEARCH FILTER
  if (filters?.search && filters.search.trim()) {
    const q = filters.search.toLowerCase();
    const before = result.length;
    result = result.filter(a => {
      if (!a) return false;
      // Check root titles
      if (a.title_english?.toLowerCase().includes(q)) return true;
      if (a.title_japanese?.toLowerCase().includes(q)) return true;
      // Check season titles and genres
      return Object.values(a.seasons || {}).some(s => {
        if (!s) return false;
        if (s.title_english?.toLowerCase().includes(q)) return true;
        if (s.title_japanese?.toLowerCase().includes(q)) return true;
        if (s.genres?.some(ge => ge?.toLowerCase?.().includes(q))) return true;
        return false;
      });
    });
    console.log('   After SEARCH: ' + before + ' → ' + result.length);
  }

  // 2. GENRE FILTER (check root OR selected season)
  if (filters?.genres && Array.isArray(filters.genres) && filters.genres.length > 0) {
    const before = result.length;
    result = result.filter(a => {
      if (!a) return false;
      // Check root genres
      const rootMatch = filters.genres.some(fg => a.genres?.includes(fg));
      if (rootMatch) return true;
      // Check selected season genres
      const selectedSeason = a.seasons?.[String(a.selected_season_mal_id)];
      if (selectedSeason?.genres) {
        return filters.genres.some(g => selectedSeason.genres.includes(g));
      }
      return false;
    });
    console.log('   After GENRE: ' + before + ' → ' + result.length);
  }

  // 3. SERIES SCOPE FILTER
  if (filters?.seriesScope && Array.isArray(filters.seriesScope) && filters.seriesScope.length > 0) {
    const before = result.length;
    result = filterBySeriesScope(result, filters.seriesScope);
    console.log('   After SERIES_SCOPE: ' + before + ' → ' + result.length);
  }

  // 4. WATCH STATUS FILTER
  if (filters?.watchStatus && Array.isArray(filters.watchStatus) && filters.watchStatus.length > 0) {
    const before = result.length;
    result = result.filter(a => {
      if (!a) return false;
      const status = getRootWatchStatus(a);
      return filters.watchStatus.includes(status);
    });
    console.log('   After STATUS: ' + before + ' → ' + result.length);
  }

  // 5. SORT
  const sortBy = filters?.sort || 'updated_date_desc';
  console.log('   Sorting by: ' + sortBy);
  
  switch (sortBy) {
    case 'title_asc':
      result.sort((a, b) => {
        const aTitle = a?.title_english || a?.title_japanese || '';
        const bTitle = b?.title_english || b?.title_japanese || '';
        return aTitle.localeCompare(bTitle);
      });
      break;
    
    case 'title_desc':
      result.sort((a, b) => {
        const aTitle = a?.title_english || a?.title_japanese || '';
        const bTitle = b?.title_english || b?.title_japanese || '';
        return bTitle.localeCompare(aTitle);
      });
      break;
    
    case 'progress_desc':
      result.sort((a, b) => {
        const ap = Object.values(a?.seasons || {}).reduce((s, se) => s + (se?.progress || 0), 0);
        const bp = Object.values(b?.seasons || {}).reduce((s, se) => s + (se?.progress || 0), 0);
        return bp - ap;
      });
      break;
    
    case 'updated_date_desc':
    default:
      result.sort((a, b) => {
        const aDate = new Date(a?.updated_date || 0).getTime();
        const bDate = new Date(b?.updated_date || 0).getTime();
        return bDate - aDate;
      });
      break;
    
    case 'custom_order':
      result.sort((a, b) => (a?._sort_order || 0) - (b?._sort_order || 0));
      break;
  }

  console.log('🔍 applyFiltersAndSort: END with ' + result.length + ' items');
  return result;
}

export function updateFilterPillStates() {
  const currentFilters = getState('filters');
  console.log('🎨 Updating filter pill states:', currentFilters);
  
  // Update genre pills
  document.querySelectorAll('.filter-chip[data-genre]').forEach(btn => {
    const genre = btn.dataset.genre;
    const isActive = currentFilters.genres.includes(genre);
    btn.classList.toggle('filter-chip--active', isActive);
  });

  // Update series scope pills
  document.querySelectorAll('.filter-chip[data-series-scope]').forEach(btn => {
    const scope = btn.dataset.seriesScope;
    const isActive = currentFilters.seriesScope.includes(scope);
    btn.classList.toggle('filter-chip--active', isActive);
  });

  // Update status buttons
  document.querySelectorAll('.filter-status-btn').forEach(btn => {
    const status = btn.dataset.status;
    const isActive = currentFilters.watchStatus.includes(status);
    btn.classList.toggle('filter-status-btn--active', isActive);
  });

  // Update sort select
  const sortSel = document.querySelector('#sort-select');
  if (sortSel) {
    sortSel.value = currentFilters.sort || 'updated_date_desc';
  }

  // Update header search
  const headerSearch = document.getElementById('header-search');
  if (headerSearch) {
    headerSearch.value = currentFilters.search || '';
  }
}
