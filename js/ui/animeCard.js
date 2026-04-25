/**
 * animeCard.js — Grid card component (v2 schema)
 */

import {
  getSelectedSeason, getSeasonsArray, getEffectivePoster, normalizeStatus,
  getRootProgress, getRootWatchStatus, getSeasonDisplayTitle, getRootDisplayTitle
} from '../state.js';
import { incrementProgress, decrementProgress, setSelectedSeason } from '../services/animeManager.js';
import { openEditDialog, openDeleteConfirm, openSeasonDetail } from './dialogs.js';
import { navigate } from '../router.js';
import { statusLabel, formatDurationDDHHMMSS } from '../utils.js';
import { lazyImage } from './lazyMedia.js';
import { attachContextMenu } from './contextMenu.js';
import { getContinueActionForAnime } from '../services/franchiseService.js';

const DOT_CLASS = {
  watching: 'dot-watching', completed: 'dot-completed',
  plan_to_watch: 'dot-plan_to_watch', dropped: 'dot-dropped', paused: 'dot-paused',
};

export function createAnimeCard(anime) {
  const selectedSeason = getSelectedSeason(anime);
  const { watched, total, pct } = getRootProgress(anime);
  const rootStatus = getRootWatchStatus(anime);
  const poster = getEffectivePoster(anime, selectedSeason);
  const seasonsArr = getSeasonsArray(anime);

  const card = document.createElement('div');
  card.className = 'card anime-card';
  card.dataset.rootId = anime.root_mal_id;
  card.setAttribute('draggable', 'true');
  card.setAttribute('role', 'article');
  card.setAttribute('aria-label', getRootDisplayTitle(anime));
  card.setAttribute('tabindex', '0'); // Keyboard accessibility

  const seasonOptions = seasonsArr.map((s, i) =>
    `<option value="${s.mal_id}" ${s.mal_id === anime.selected_season_mal_id ? 'selected' : ''}>
      S${i + 1}: ${getSeasonDisplayTitle(s).slice(0, 28)}${getSeasonDisplayTitle(s).length > 28 ? '…' : ''}
    </option>`
  ).join('');

  const statusBadgeClass = {
    'watching': 'card__status-badge--watching',
    'completed': 'card__status-badge--completed',
    'plan_to_watch': 'card__status-badge--plan',
    'dropped': 'card__status-badge--dropped',
    'paused': 'card__status-badge--paused'
  }[rootStatus] || '';

  // Build season chip text
  let seasonChipText = '';
  if (selectedSeason) {
    const seasonNum = seasonsArr.findIndex(s => s.mal_id === selectedSeason.mal_id) + 1;
    const displayTitle = getSeasonDisplayTitle(selectedSeason);
    seasonChipText = `S${seasonNum}: ${displayTitle}`.substring(0, 28).padEnd(28, '');
  } else {
    seasonChipText = `S1: ${getRootDisplayTitle(anime)}`.substring(0, 28);
  }

  // Countdown & Badge Logic
  const hasNewEpisode = selectedSeason?.has_new_episode;
  const nextAiringAt = selectedSeason?.next_episode_airing_at;
  const isAiringAndWaiting = (nextAiringAt && nextAiringAt > Date.now()); 

  // Franchise & Sequel Logic
  const fullLibrary = window.__mugelState?.getState?.('library') || [anime];
  const continueAction = getContinueActionForAnime(anime, fullLibrary);
  const airingSequel = seasonsArr.find(s => s.status === 'Currently Airing' && s.mal_id !== selectedSeason?.mal_id);
  const showJumpAction = !!continueAction?.to;
  
  // Seasonal labeling
  const seasonLabel = selectedSeason?.season_label ? `${selectedSeason.season_label} ${selectedSeason.season_year || ''}` : `S${seasonsArr.findIndex(s => s.mal_id === selectedSeason?.mal_id) + 1}`;

  card.innerHTML = `
    <!-- Poster Image Container (Premium Layout) -->
    <div class="card__poster">
      <img class="card__image" src="assets/icons/placeholder.svg" data-src="${poster}" alt="${getRootDisplayTitle(anime)}" onerror="this.src='assets/icons/placeholder.svg'" />
      
      <!-- Cinematic Overlay Gradient -->
      <div class="card__overlay"></div>
      
      <!-- Status Badge (Top Left) -->
      <div class="card__status-badge ${statusBadgeClass}">
        <div class="status-dot"></div>
        <span class="status-text">${statusLabel(rootStatus)}</span>
      </div>
      
      <!-- Metadata Peek (Overlay on Hover) -->
      <div class="card__metadata-peek">
        <div class="peek-genres">${(selectedSeason?.genres || anime.genres || []).slice(0, 3).map(g => `<span>${g}</span>`).join('')}</div>
        <div class="peek-status">${selectedSeason?.status || 'Active'}</div>
      </div>
      
      <!-- New Episode / Airing Badge -->
      <div class="card__corner-badges">
        ${hasNewEpisode ? `<div class="card__new-badge">NEW EP</div>` : ''}
        ${airingSequel ? `<div class="card__info-badge card__info-badge--sequel">AIRING SEQUEL</div>` : ''}
      </div>
      
      <!-- Airing Countdown Overlay -->
      ${isAiringAndWaiting ? `
      <div class="card__countdown opacity-0" data-airing-at="${nextAiringAt}">
        <div class="card__countdown-content">
           <div class="card__countdown-label">NEXT EPISODE</div>
           <span class="countdown-value"></span>
        </div>
      </div>
      ` : ''}

      <!-- Action Buttons (Top Right) -->
      <div class="card__actions">
        <button class="card__action-btn focus-btn" title="Focus" aria-label="Focus">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
        <button class="card__action-btn edit-btn" title="Edit" aria-label="Edit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </div>
      
      <!-- Season Chip / Label (Bottom of Poster) -->
      <div class="card__season-selector">
        <div class="card__season-row">
           <div class="card__season-chip">${seasonLabel}</div>
           ${seasonsArr.length > 1 ? `
             <div class="custom-select-wrapper card__season-select-wrap">
               <select class="card-season-select" aria-label="Select season">${seasonOptions}</select>
               <svg class="select-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>
             </div>
           ` : ''}
        </div>
      </div>

      <!-- Jump to Sequel Action -->
      ${showJumpAction ? `
        <div class="card__jump-action">
           <button class="jump-sequel-btn">
              <span>${continueAction.label}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="12" height="12" class="jump-sequel-btn__icon"><polyline points="9 18 15 12 9 6"/></svg>
           </button>
        </div>
      ` : ''}
    </div>

    <!-- Card Content Section (Below Poster) -->
    <div class="card__content">
      <h3 class="card__title">${getRootDisplayTitle(anime)}</h3>
      
      <div class="card__stats">
        <div class="card__progress-info">
          <span class="card__progress-text" id="card-prog-${anime.root_mal_id}">${selectedSeason ? `${selectedSeason.progress}/${selectedSeason.total_episodes}` : `${watched}/${total}`}</span>
          <span class="card__percentage">${pct}%</span>
        </div>
        <div class="card__progress-bar">
          <div class="card__progress-fill" id="card-bar-${anime.root_mal_id}" style="width:${pct}%"></div>
        </div>
      </div>
      
      <!-- Micro Episode Controls -->
      <div class="card__micro-controls">
        <button class="control-btn dec-btn" title="Decrease episode">−</button>
        <div class="control-divider"></div>
        <button class="control-btn inc-btn" title="Increase episode">+</button>
      </div>
    </div>
  `;

  // Track current season for button handlers
  let activeSeason = selectedSeason;

  // Lazy load poster
  lazyImage(card.querySelector('.card__image'), poster);

  // Countdown Hover Logic
  const countdownOverlay = card.querySelector('.card__countdown');
  if (countdownOverlay) {
    let countdownInterval = null;
    const targetTime = Number(countdownOverlay.dataset.airingAt);
    const valueEl = countdownOverlay.querySelector('.countdown-value');

    const updateCountdown = () => {
      const diff = targetTime - Date.now();
      if (diff <= 0) {
        valueEl.textContent = 'AIRING NOW';
        return;
      }
      valueEl.textContent = formatDurationDDHHMMSS(diff);
    };

    card.addEventListener('mouseenter', () => {
      countdownOverlay.classList.remove('opacity-0');
      countdownOverlay.classList.add('opacity-100');
      updateCountdown();
      countdownInterval = setInterval(updateCountdown, 1000);
    });

    card.addEventListener('mouseleave', () => {
      countdownOverlay.classList.add('opacity-0');
      countdownOverlay.classList.remove('opacity-100');
      if (countdownInterval) clearInterval(countdownInterval);
      countdownInterval = null;
    });
  }

  // Season switcher (prevent navigation when changing season)
  const seasonSelector = card.querySelector('.card-season-select');
  if (seasonSelector) {
    seasonSelector.addEventListener('change', async (e) => {
      e.stopPropagation();
      const newId = Number(e.target.value);
      await setSelectedSeason(anime.root_mal_id, newId);
      // Update card display inline
      const fresh = getAnimeFromLibrary(anime.root_mal_id);
      if (fresh) activeSeason = getSelectedSeason(fresh);
      refreshCardProgress(card, fresh || anime, activeSeason);
    });
    
    // Prevent season selector click from navigating
    seasonSelector.addEventListener('click', (e) => e.stopPropagation());
    seasonSelector.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // Episode controls
  card.querySelector('.inc-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!activeSeason) return;
    await incrementProgress(anime.root_mal_id, activeSeason.mal_id);
    const fresh = getAnimeFromLibrary(anime.root_mal_id);
    if (fresh) activeSeason = getSelectedSeason(fresh);
    refreshCardProgress(card, fresh || anime, activeSeason);
  });

  card.querySelector('.dec-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!activeSeason) return;
    await decrementProgress(anime.root_mal_id, activeSeason.mal_id);
    const fresh = getAnimeFromLibrary(anime.root_mal_id);
    if (fresh) activeSeason = getSelectedSeason(fresh);
    refreshCardProgress(card, fresh || anime, activeSeason);
  });

  // Action buttons
  card.querySelector('.focus-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    navigate('focus', { rootId: anime.root_mal_id });
  });

  card.querySelector('.edit-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditDialog(anime);
  });

  card.querySelector('.delete-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openDeleteConfirm(anime);
  });

  // Jump to sequel
  card.querySelector('.jump-sequel-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (continueAction?.to) {
      const targetRootId = continueAction.to.parent_root_id || anime.root_mal_id;
      await setSelectedSeason(targetRootId, continueAction.to.mal_id);
      navigate('focus', { rootId: targetRootId });
    }
  });

  // Click on poster to open season detail (avoid season selector area)
  const posterContainer = card.querySelector('.card__poster');
  posterContainer?.addEventListener('click', (e) => {
    // Don't navigate if clicking on season selector or actions
    if (e.target.closest('.card__season-selector') || e.target.closest('.card__actions')) {
      return;
    }
    if (activeSeason) openSeasonDetail(anime, activeSeason);
  });

  // Drag
  card.addEventListener('dragstart', (e) => { 
    e.dataTransfer.setData('text/plain', String(anime.root_mal_id)); 
    card.classList.add('dragging'); 
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  // Context Menu
  attachContextMenu(card, anime, activeSeason);

  return card;
}

function getAnimeFromLibrary(rootMalId) {
  const { getState } = window.__mugelState || {};
  if (!getState) {
    // fallback: dynamic import
    return null;
  }
  return getState('library')?.find(a => a.root_mal_id === Number(rootMalId)) || null;
}

function refreshCardProgress(card, anime, season) {
  if (!season) return;
  const rootId = anime.root_mal_id;
  const ep = season.progress || 0;
  const tot = season.total_episodes || 0;
  const pct = tot > 0 ? Math.round((ep / tot) * 100) : 0;

  // Update progress bar fill width (preserve premium gradient/glow styling)
  const barFill = card.querySelector(`#card-bar-${rootId}`);
  if (barFill) {
    barFill.style.width = `${pct}%`;
  }

  // Update progress text
  const progText = card.querySelector(`#card-prog-${rootId}`);
  if (progText) {
    progText.textContent = `${ep}/${tot} episodes`;
  }

  // Update status badge with correct modifier class
  const badge = card.querySelector('.card__status-badge');
  if (badge) {
    const status = getRootWatchStatus(anime);
    // Remove all status classes
    badge.classList.remove(
      'card__status-badge--watching',
      'card__status-badge--completed',
      'card__status-badge--plan',
      'card__status-badge--dropped',
      'card__status-badge--paused'
    );
    
    // Add correct status class
    const statusClassMap = {
      'watching': 'card__status-badge--watching',
      'completed': 'card__status-badge--completed',
      'plan_to_watch': 'card__status-badge--plan',
      'dropped': 'card__status-badge--dropped',
      'paused': 'card__status-badge--paused'
    };
    const statusClass = statusClassMap[status] || '';
    if (statusClass) badge.classList.add(statusClass);
    badge.title = statusLabel(status);
  }

  // Update poster image if season changed
  const poster = getEffectivePoster(anime, season);
  const img = card.querySelector('.card__image');
  if (img && img.dataset.src !== poster) {
    img.src = poster;
    img.dataset.src = poster;
  }
}

/**
 * Update an existing card DOM in-place for a given anime object.
 * This avoids a full library re-render when a single entry changes.
 */
export function updateCardFromAnime(anime) {
  if (!anime) return;
  const rootId = anime.root_mal_id;
  const selector = `.anime-card[data-root-id="${rootId}"]`;
  const card = document.querySelector(selector);
  if (!card) return; // card not currently in DOM

  const season = getSelectedSeason(anime);
  // Update progress / poster / status
  try {
    refreshCardProgress(card, anime, season);
  } catch (err) {
    console.warn('updateCardFromAnime: refreshCardProgress failed', err);
  }

  // Countdown overlay handling: ensure overlay exists when airing, otherwise remove it
  const poster = card.querySelector('.card__poster');
  if (!poster) return;

  const nextAiringAt = season?.next_episode_airing_at;
  const isAiring = nextAiringAt && Number(nextAiringAt) > Date.now();

  let overlay = card.querySelector('.card__countdown');

  // Helper to attach hover countdown behaviour
  const attachCountdown = (el, targetMs) => {
    if (!el) return;
    if (el._countdownAttached) {
      el.dataset.airingAt = String(targetMs);
      return;
    }
    el.dataset.airingAt = String(targetMs);
    let interval = null;
    const valueEl = el.querySelector('.countdown-value');
    const updateCountdown = () => {
      const diff = Number(el.dataset.airingAt) - Date.now();
      if (diff <= 0) {
        if (valueEl) valueEl.textContent = 'AIRING NOW';
        return;
      }
      if (valueEl) valueEl.textContent = formatDurationDDHHMMSS(diff);
    };

    const enter = () => {
      el.classList.remove('opacity-0');
      el.classList.add('opacity-100');
      updateCountdown();
      interval = setInterval(updateCountdown, 1000);
    };
    const leave = () => {
      el.classList.add('opacity-0');
      el.classList.remove('opacity-100');
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    card.addEventListener('mouseenter', enter);
    card.addEventListener('mouseleave', leave);
    el._countdownAttached = true;
  };

  if (isAiring) {
    // Create overlay if missing
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'card__countdown opacity-0';
        overlay.innerHTML = `
        <div class="card__countdown-content">
           <div class="card__countdown-label">NEXT EPISODE</div>
           <span class="countdown-value"></span>
        </div>
      `;
      poster.appendChild(overlay);
    }
    attachCountdown(overlay, Number(nextAiringAt));
  } else {
    // Remove if exists
    if (overlay) {
      try { overlay.remove(); } catch (e) { /* ignore */ }
    }
  }
}
