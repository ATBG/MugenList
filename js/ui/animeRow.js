/**
 * animeRow.js — List row component (v2 schema)
 */

import {
  getSelectedSeason, getRootProgress, getRootWatchStatus,
  getEffectivePoster, getSeasonDisplayTitle, getRootDisplayTitle, getSeasonsArray
} from '../state.js';
import { incrementProgress, decrementProgress } from '../services/animeManager.js';
import { openEditDialog, openDeleteConfirm } from './dialogs.js';
import { navigate } from '../router.js';
import { statusLabel, formatDurationDDHHMMSS } from '../utils.js';
import { lazyImage } from './lazyMedia.js';

export function createAnimeRow(anime) {
  const selectedSeason = getSelectedSeason(anime);
  const { watched, total, pct } = getRootProgress(anime);
  const rootStatus = getRootWatchStatus(anime);
  const poster = getEffectivePoster(anime, selectedSeason);
  const displayTitle = getRootDisplayTitle(anime);
  const genresStr = (anime.genres || selectedSeason?.genres || []).slice(0, 2).join(', ');
  const nextAiringAt = Number(selectedSeason?.next_episode_airtime || selectedSeason?.next_episode_airing_at || 0) || null;
  const showCountdown = Boolean(selectedSeason?.is_airing || selectedSeason?.status === 'Currently Airing') && nextAiringAt && nextAiringAt > Date.now();

  const row = document.createElement('div');
  row.className = 'row anime-row';
  row.dataset.rootId = anime.root_mal_id;
  row.setAttribute('draggable', 'true');

  const statusBadgeClass = {
    'watching': 'row__status--watching',
    'completed': 'row__status--completed',
    'plan_to_watch': 'row__status--plan',
    'dropped': 'row__status--dropped',
    'paused': 'row__status--paused'
  }[rootStatus] || '';

  row.innerHTML = `
    <!-- Poster -->
    <div class="row__poster">
      <img  src="assets/icons/placeholder.svg" data-src="${poster}" alt="${displayTitle}" onerror="this.src='assets/icons/placeholder.svg'" />
    </div>
    
    <!-- Info -->
    <div class="row__content">
      <div class="row__title">${displayTitle}</div>
      <div class="row__meta">
        <span class="row__status ${statusBadgeClass}">${statusLabel(rootStatus)}</span>
        <span>${Object.keys(anime.seasons).length} season${Object.keys(anime.seasons).length !== 1 ? 's' : ''}</span>
        ${genresStr ? `<span>${genresStr}</span>` : ''}
      </div>
      ${showCountdown ? `<div class="row__countdown" data-airing-at="${nextAiringAt}" style="font-size:0.72rem;color:var(--accent-light);opacity:0;transform:translateY(2px);transition:opacity .18s ease, transform .18s ease;">Next release in <span class="row__countdown-value">00:00:00:00</span></div>` : ''}
    </div>
    
    <!-- Progress -->
    <div class="row__progress">
      <div class="row__progress-bar">
        <div class="row__progress-fill" style="width:${pct}%;"></div>
      </div>
      <div class="row__progress-text">${selectedSeason ? `${selectedSeason.progress}/${selectedSeason.total_episodes}` : `${watched}/${total}`} eps · ${pct}%</div>
    </div>
    
    <!-- Controls -->
    <div style="display: flex; gap: 6px;">
      <button class="card__btn-small ep-btn dec-btn" aria-label="Decrease episode">−</button>
      <button class="card__btn-small ep-btn inc-btn">+</button>
    </div>
    
    <!-- Actions -->
    <div class="row__actions">
      <button class="card__action-btn focus-btn" title="Focus" aria-label="Focus view">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
      </button>
      <button class="card__action-btn edit-btn" title="Edit" aria-label="Edit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="card__action-btn delete-btn" title="Delete" aria-label="Delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/></svg>
      </button>
    </div>
  `;

  const activeSeason = selectedSeason;

  // Lazy load poster
  lazyImage(row.querySelector('.row__poster img'), poster);

  row.querySelector('.inc-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (activeSeason) await incrementProgress(anime.root_mal_id, activeSeason.mal_id);
  });

  row.querySelector('.dec-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (activeSeason) await decrementProgress(anime.root_mal_id, activeSeason.mal_id);
  });

  row.querySelector('.focus-btn')?.addEventListener('click', (e) => { e.stopPropagation(); navigate('focus', { rootId: anime.root_mal_id }); });
  row.querySelector('.edit-btn')?.addEventListener('click', (e) => { e.stopPropagation(); openEditDialog(anime); });
  row.querySelector('.delete-btn')?.addEventListener('click', (e) => { e.stopPropagation(); openDeleteConfirm(anime); });

  row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(anime.root_mal_id)); row.classList.add('dragging'); });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));

  attachRowCountdown(row);

  return row;
}

function attachRowCountdown(row) {
  const countdownEl = row.querySelector('.row__countdown');
  if (!countdownEl || countdownEl._bound) return;
  countdownEl._bound = true;

  let interval = null;
  const valueEl = countdownEl.querySelector('.row__countdown-value');

  const updateCountdown = () => {
    const target = Number(countdownEl.dataset.airingAt || 0);
    const diff = target - Date.now();
    if (!valueEl) return;
    valueEl.textContent = diff > 0 ? formatDurationDDHHMMSS(diff) : '00:00:00:00';
  };

  row.addEventListener('mouseenter', () => {
    countdownEl.style.opacity = '1';
    countdownEl.style.transform = 'translateY(0)';
    updateCountdown();
    interval = setInterval(updateCountdown, 1000);
  });

  row.addEventListener('mouseleave', () => {
    countdownEl.style.opacity = '0';
    countdownEl.style.transform = 'translateY(2px)';
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  });
}
