/**
 * miniTracker.js — Floating draggable episode tracker (v2 schema)
 */

import { getState, subscribe, getSeasonsArray, getEffectivePoster, getSeasonDisplayTitle, getRootDisplayTitle, normalizeStatus } from '../state.js';
import { incrementProgress, decrementProgress } from '../services/animeManager.js';

export function initMiniTracker() {
  const tracker = document.getElementById('mini-tracker');
  if (!tracker) return;

  tracker.innerHTML = `
    <div class="mini-tracker-header" id="mini-tracker-drag-handle">
      <span class="mini-tracker-title">⏱ Now Watching</span>
      <button class="mini-tracker-close" id="mini-tracker-close" aria-label="Close mini tracker">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="mini-tracker-body" id="mini-tracker-body"></div>
  `;

  document.getElementById('mini-tracker-close')?.addEventListener('click', hideMiniTracker);
  document.getElementById('mini-tracker-toggle')?.addEventListener('click', toggleMiniTracker);

  makeDraggable(tracker, document.getElementById('mini-tracker-drag-handle'));

  // respect settings
  const settings = getState('settings') || {};
  if (settings.show_mini_tracker !== false) {
    showMiniTracker();
  } else {
    hideMiniTracker();
  }

  subscribe('settings', (s) => {
    if (!s) return;
    if (s.show_mini_tracker === false) hideMiniTracker();
    else showMiniTracker();
  });

  subscribe('library', () => renderMiniTrackerBody());
  renderMiniTrackerBody();
}

function renderMiniTrackerBody() {
  const body = document.getElementById('mini-tracker-body');
  if (!body) return;

  const library = getState('library') || [];
  // Find anime that have at least one season "watching"
  const watchingAnime = library.filter(a => getSeasonsArray(a).some(s => s.watch_status === 'watching'));

  if (watchingAnime.length === 0) {
    body.innerHTML = `<div class="mini-tracker-empty">No anime currently watching.<br>Start watching to track here.</div>`;
    return;
  }

  body.innerHTML = '';
  watchingAnime.slice(0, 4).forEach(anime => {
    // Pick first watching season
    const season = getSeasonsArray(anime).find(s => s.watch_status === 'watching');
    if (!season) return;

    const ep = season.progress || 0;
    const total = season.total_episodes || '?';
    const pct = total !== '?' && total > 0 ? Math.round((ep / total) * 100) : 0;
    const poster = getEffectivePoster(anime, season);

    const item = document.createElement('div');
    item.className = 'mini-anime-item';
    item.innerHTML = `
      <img class="mini-anime-poster" src="${poster}" alt="${getRootDisplayTitle(anime)}" onerror="this.src='assets/icons/placeholder.svg'" />
      <div class="mini-anime-info">
        <div class="mini-anime-title">${getRootDisplayTitle(anime)}</div>
        <div class="mini-anime-ep">Ep ${ep} / ${total}</div>
        <div class="progress-bar-wrap" style="margin-top:4px;">
          <div class="progress-bar-fill" style="width:${pct}%;animation:none;"></div>
        </div>
      </div>
      <div class="mini-ep-controls">
        <button class="mini-ep-btn dec-btn" data-root="${anime.root_mal_id}" data-season="${season.mal_id}" aria-label="Decrease">−</button>
        <button class="mini-ep-btn inc-btn" data-root="${anime.root_mal_id}" data-season="${season.mal_id}" aria-label="Increase">+</button>
      </div>
    `;
    body.appendChild(item);
  });

  body.querySelectorAll('.inc-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await incrementProgress(btn.dataset.root, btn.dataset.season);
    });
  });

  body.querySelectorAll('.dec-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await decrementProgress(btn.dataset.root, btn.dataset.season);
    });
  });
}

export function showMiniTracker() {
  document.getElementById('mini-tracker')?.classList.remove('hidden');
}

export function hideMiniTracker() {
  document.getElementById('mini-tracker')?.classList.add('hidden');
}

export function toggleMiniTracker() {
  document.getElementById('mini-tracker')?.classList.toggle('hidden');
}

function makeDraggable(el, handle) {
  if (!handle) return;
  let ox = 0, oy = 0;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    ox = e.clientX - rect.left;
    oy = e.clientY - rect.top;

    const onMove = (me) => {
      let x = me.clientX - ox;
      let y = me.clientY - oy;
      x = Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth));
      y = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight));
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
