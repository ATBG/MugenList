/**
 * animeCard.js — Grid card component (v2 schema)
 */

import {
  getSelectedSeason, getSeasonsArray, getEffectivePoster, normalizeStatus,
  getRootProgress, getRootWatchStatus, getSeasonDisplayTitle, getRootDisplayTitle
} from '../state.js';
import { incrementProgress, decrementProgress, setSelectedSeason } from '../services/animeManager.js';
import { openEditDialog, openDeleteConfirm, openSeasonDetail } from './dialogs.js';
import { openPlaybackPicker } from './playbackPicker.js';
import { navigate } from '../router.js';
import { statusLabel, formatDurationDDHHMMSS } from '../utils.js';
import { lazyImage } from './lazyMedia.js';
import { attachContextMenu } from './contextMenu.js';
import { getContinueActionForAnime } from '../services/franchiseService.js';
import { attachCountdown, detachCountdown, updateCountdown } from '../services/countdownManager.js';

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
  card.className = 'card anime-card card--hoverable card--glass';
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

  let statusBadgeClass = {
    'watching': 'card__status-badge--watching',
    'completed': 'card__status-badge--completed',
    'plan_to_watch': 'card__status-badge--plan',
    'dropped': 'card__status-badge--dropped',
    'paused': 'card__status-badge--paused'
  }[rootStatus] || '';
  if (rootStatus === 'completed' && (selectedSeason?.status === 'Currently Airing' || (!selectedSeason && anime.status === 'Currently Airing'))) {
    statusBadgeClass = 'card__status-badge--caught-up';
  }

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
  const isAiring = selectedSeason?.status === 'Currently Airing' || (!selectedSeason && anime.status === 'Currently Airing');

  // Episode counts (watched / aired / total)
  const watchedCount = selectedSeason ? (selectedSeason.progress || 0) : (watched || 0);
  const airedCount = selectedSeason ? (typeof selectedSeason.aired_episodes !== 'undefined' ? selectedSeason.aired_episodes : (selectedSeason.episodes ?? '')) : (anime.aired_episodes ?? '');
  const totalCount = selectedSeason ? (typeof selectedSeason.total_episodes !== 'undefined' ? selectedSeason.total_episodes : '') : (total || '');

  // Franchise & Sequel Logic
  const fullLibrary = window.__mugelState?.getState?.('library') || [anime];
  const continueAction = getContinueActionForAnime(anime, fullLibrary);
  const airingSequel = seasonsArr.find(s => s.status === 'Currently Airing' && s.mal_id !== selectedSeason?.mal_id);
  const showJumpAction = !!continueAction?.to;
  
  // Seasonal labeling
  const seasonLabel = selectedSeason?.season_label ? `${selectedSeason.season_label} ${selectedSeason.season_year || ''}` : `S${seasonsArr.findIndex(s => s.mal_id === selectedSeason?.mal_id) + 1}`;

  card.innerHTML = `
    <div class="card__poster">
      <img class="card__image" src="assets/icons/placeholder.svg" data-src="${poster}" alt="${getRootDisplayTitle(anime)}" onerror="this.src='assets/icons/placeholder.svg'" />
      <div class="card__overlay"></div>
      
      <div class="card__status-badge ${statusBadgeClass}">
        <div class="status-dot"></div>
        <span class="status-text">${statusLabel(rootStatus, isAiring)}</span>
      </div>
      
      ${hasNewEpisode ? `<div class="card__new-badge">NEW</div>` : ''}
      
      <!-- Airing Countdown Overlay (managed by countdownManager) -->
      ${isAiringAndWaiting ? `
      <div class="card__countdown-container" data-countdown-root="${anime.root_mal_id}"></div>
      ` : ''}

      <!-- Action Buttons (Top Right) -->
      <div class="card__actions">
        <button class="card__action-btn focus-btn" title="Open Focus View" aria-label="Open Focus View">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16"><path d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="card__action-btn edit-btn" title="Edit" aria-label="Edit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16"><path d="M3 21v-3.75L14.8 5.45l3.75 3.75L6.75 21H3z"/><path d="M20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"/></svg>
        </button>
        <button class="card__action-btn delete-btn" title="Delete" aria-label="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16"><path d="M3 6h18" /><path d="M8 6v12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V6" /><path d="M10 6V4a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2"/></svg>
        </button>
        ${showJumpAction ? `<button class="card__action-btn jump-sequel-btn" title="Jump to sequel" aria-label="Jump to sequel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg></button>` : ''}
        <button class="card__action-btn play-btn" title="Play Now">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><path d="M5 3v18l15-9z"/></svg>
        </button>
      </div>
    </div>

    <div class="card__content">
      <h3 class="card__title">${getRootDisplayTitle(anime)}</h3>
      
      <div class="card__progress-section">
        <div class="card__progress-info">
          <div class="card__ep-meta">
            <div class="ep-watched"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 12s4-8 9-8 9 8 9 8-4 8-9 8-9-8-9-8z"/><circle cx="12" cy="12" r="3"/></svg><strong id="card-watched-${anime.root_mal_id}">${watchedCount}</strong><span>watched</span></div>
            <div class="ep-aired"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 5v14M5 12h14"/></svg><strong id="card-aired-${anime.root_mal_id}">${airedCount}</strong><span>aired</span></div>
            ${totalCount !== '' ? `<div class="ep-announced"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2l3 6 6 .5-4.5 4 1 6L12 16l-5.5 3.5 1-6L3 8.5 9 8 12 2z"/></svg><strong id="card-total-${anime.root_mal_id}">${totalCount}</strong><span>total</span></div>` : ''}
          </div>
          <span class="card__percentage">${pct}%</span>
        </div>
        <div class="card__progress-bar">
          <div class="card__progress-fill" id="card-bar-${anime.root_mal_id}" style="width:${pct}%"></div>
        </div>
      </div>
      
      <div class="card__footer">
        <div class="card__season-chip">${seasonLabel}</div>
        <div class="card__micro-controls">
          <button class="control-btn dec-btn" title="Decrease">-</button>
          <button class="control-btn inc-btn" title="Increase">+</button>
        </div>
      </div>
    </div>
  `;

  // Track current season for button handlers
  let activeSeason = selectedSeason;

  // Lazy load poster
  lazyImage(card.querySelector('.card__image'), poster);

  // Initialize countdown manager for this card
  if (isAiringAndWaiting && nextAiringAt) {
    const seasonId = selectedSeason?.mal_id || anime.root_mal_id;
    attachCountdown(card, Number(nextAiringAt), {
      rootId: anime.root_mal_id,
      seasonId: String(seasonId),
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

  card.querySelector('.play-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const episode = activeSeason?.progress ? activeSeason.progress + 1 : 1;
    openPlaybackPicker(activeSeason || anime, episode);
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

  // Update episode meta badges
  const watchedEl = card.querySelector(`#card-watched-${rootId}`);
  if (watchedEl) watchedEl.textContent = String(ep);

  const airedEl = card.querySelector(`#card-aired-${rootId}`);
  const airedVal = season.aired_episodes ?? season.episodes ?? '';
  if (airedEl) airedEl.textContent = (airedVal !== null && typeof airedVal !== 'undefined') ? String(airedVal) : '';

  const totalEl = card.querySelector(`#card-total-${rootId}`);
  if (totalEl) totalEl.textContent = tot || '';

  // Update status badge with correct modifier class
  const badge = card.querySelector('.card__status-badge');
  if (badge) {
    const status = getRootWatchStatus(anime);
    const isAiring = season?.status === 'Currently Airing' || (!season && anime.status === 'Currently Airing');
    
    // Remove all status classes
    badge.classList.remove(
      'card__status-badge--watching',
      'card__status-badge--completed',
      'card__status-badge--plan',
      'card__status-badge--dropped',
      'card__status-badge--paused',
      'card__status-badge--caught-up'
    );
    
    // Add correct status class
    const statusClassMap = {
      'watching': 'card__status-badge--watching',
      'completed': 'card__status-badge--completed',
      'plan_to_watch': 'card__status-badge--plan',
      'dropped': 'card__status-badge--dropped',
      'paused': 'card__status-badge--paused'
    };
    let statusClass = statusClassMap[status] || '';
    if (status === 'completed' && isAiring) {
      statusClass = 'card__status-badge--caught-up';
    }
    
    if (statusClass) badge.classList.add(statusClass);
    badge.title = statusLabel(status, isAiring);
    
    const textEl = badge.querySelector('.status-text');
    if (textEl) textEl.textContent = statusLabel(status, isAiring);
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

  // Use countdownManager for live countdown updates
  if (isAiring) {
    const updated = updateCountdown(rootId, Number(nextAiringAt));
    if (!updated) {
      // Countdown doesn't exist yet, attach it
      const seasonId = season?.mal_id || rootId;
      attachCountdown(card, Number(nextAiringAt), {
        rootId,
        seasonId: String(seasonId),
      });
    }
  } else {
    // Episode has aired, remove countdown
    detachCountdown(rootId);
  }
}
