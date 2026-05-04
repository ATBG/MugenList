/**
 * focusPage.js — Deep view for a single franchise (v2 schema)
 */

import {
  getRootProgress, getRootWatchStatus, normalizeStatus,
  getEffectivePoster, getSeasonDisplayTitle, getRootDisplayTitle, getSelectedSeason, getState
} from '../state.js';
import { incrementProgress, decrementProgress, setSelectedSeason, mergeRelationSeason } from '../services/animeManager.js';
import { navigate } from '../router.js';
import { statusLabel, formatDurationDDHHMMSS, showToast } from '../utils.js';
import { openEditDialog, openRelationSelectionDialog } from '../ui/dialogs.js';
import { openPlaybackPicker } from '../ui/playbackPicker.js';
import { buildFocusCluster } from '../services/franchiseService.js';
import { scanForNewSeasons, scanForNewEpisodes } from '../services/relationEngine.js';
import { refreshAnimeNow } from '../services/refreshService.js';

export function render(container, params = {}) {
  const rootId = Number(params.rootId);
  const library = getState('library') || [];
  const anime = library.find(a => a.root_mal_id === rootId);

  if (!anime) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">Anime not found</div>
        <button class="btn btn--primary" onclick="navigate('library')" style="margin-top:16px;">Back to Library</button>
      </div>
    `;
    return;
  }

  const focusCluster = buildFocusCluster(library, anime);
  const displayAnime = focusCluster.entries.find((entry) => entry.root_mal_id === rootId) || anime;
  const selectedSeason = focusCluster.seasons.find((season) => season.selected && season.parent_root_id === rootId) || getSelectedSeason(displayAnime);
  const { watched, total, pct } = getRootProgress(displayAnime);
  const rootStatus = getRootWatchStatus(displayAnime);
  const poster = getEffectivePoster(displayAnime, selectedSeason);
  const allGenres = [...new Set(focusCluster.seasons.flatMap((season) => season.genres || []))];
  const primaryNextWatch = focusCluster.primaryNextWatch;
  const currentAiringContinuation = focusCluster.currentAiringContinuation;
  const continueAction = focusCluster.continueAction;
  const adjacentSeasons = focusCluster.adjacentSeasons || [];
  const historySeasons = focusCluster.seasons
    .filter((season) => !season.selected && Number(season.franchise_order_index || 0) < Number(selectedSeason?.franchise_order_index || Number.MAX_SAFE_INTEGER))
    .slice(-4);
  const countdownSeason = (selectedSeason?.is_airing && getSeasonAirtime(selectedSeason))
    ? selectedSeason
    : currentAiringContinuation;
  const nextAiringAt = getSeasonAirtime(countdownSeason);
  const isAiringAndWaiting = Boolean(nextAiringAt && nextAiringAt > Date.now());

  container.innerHTML = `
    <div style="max-width:900px">
      <!-- Back button -->
      <button id="focus-back-btn" class="btn btn--secondary" style="margin-bottom:16px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="15 18 9 12 15 6"/></svg>
        Back to Library
      </button>

      <!-- Hero -->
      <div class="focus-hero">
        <div class="focus-banner-wrap">
          <img class="focus-banner-img" src="${poster}" alt="" onerror="this.style.display='none'" />
          <div class="focus-hero-content">
            <img class="focus-poster" src="${poster}" alt="${getRootDisplayTitle(displayAnime)}" onerror="this.src='assets/icons/placeholder.svg'" />
            <div class="focus-meta">
              <h1 class="focus-title">${getRootDisplayTitle(displayAnime)}</h1>
              <div class="focus-stats-row">
                <span class="badge-${rootStatus}" style="padding:3px 10px;border-radius:9999px;font-size:0.8rem;font-weight:600;">${statusLabel(rootStatus)}</span>
                <span>${watched} / ${total} episodes</span>
                <span>${focusCluster.seasons.length} franchise item${focusCluster.seasons.length !== 1 ? 's' : ''}</span>
              </div>
              ${isAiringAndWaiting ? `
                <div id="focus-countdown-pill" style="margin-top: 8px; font-size: 0.8rem; font-weight: 700; background: rgba(0,0,0,0.6); padding: 4px 10px; border-radius: 6px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid rgba(255,255,255,0.1); color: #fff;">
                  <span style="color: var(--accent-light);">${countdownSeason === selectedSeason ? 'Selected airing title' : getFocusSeasonLabel(countdownSeason)} in:</span>
                  <span id="focus-countdown-val">...</span>
                </div>
              ` : ''}
              <div class="genre-tags" style="margin-top:8px;">
                ${allGenres.slice(0, 8).map(g => `<span class="genre-tag">${g}</span>`).join('')}
              </div>
            </div>
          </div>
        </div>

        <div style="padding:16px 24px;border-top:1px solid var(--border);">
          <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:var(--text-muted);margin-bottom:6px;">
            <span>Franchise Overall Progress</span><span>${pct}%</span>
          </div>
          <div class="progress-bar-wrap" style="height:6px;">
            <div class="progress-bar-fill${rootStatus==='completed'?' completed':''}" style="width:${pct}%;animation:none;"></div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:14px;">
            ${renderFocusInfoCard('Primary Next Watch', primaryNextWatch ? getFocusSeasonLabel(primaryNextWatch) : 'Nothing queued', primaryNextWatch ? getFocusSeasonMeta(primaryNextWatch) : 'You are caught up on the core path.')}
            ${renderFocusInfoCard('Current Airing', currentAiringContinuation ? getFocusSeasonLabel(currentAiringContinuation) : 'No live continuation', currentAiringContinuation ? getFocusSeasonMeta(currentAiringContinuation) : 'No airing continuation in this franchise right now.')}
            ${renderFocusInfoCard('Adjacent Seasons', adjacentSeasons.length ? adjacentSeasons.map(getFocusSeasonLabel).join(' • ') : 'No nearby seasons', adjacentSeasons.length ? 'Closest entries around your current focus.' : 'Select another season to build context here.')}
            ${renderFocusInfoCard('History', historySeasons.length ? historySeasons.map(getFocusSeasonLabel).join(' • ') : 'Fresh start', historySeasons.length ? 'Previously watched or earlier franchise context.' : 'No earlier franchise history yet.')}
          </div>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;">
        <button id="focus-play-btn" class="btn btn--primary">Play</button>
        <button id="focus-edit-btn" class="btn btn--secondary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit Details
        </button>
        ${continueAction ? `
          <button id="focus-continue-btn" class="btn btn--primary">${continueAction.label}</button>
        ` : ''}
        <button id="focus-research-btn" class="btn btn--secondary">Refresh Data</button>
      </div>

      <!-- Watch Session Mode -->
      <div class="watch-session">
        <div class="session-bg" style="background-image:url('${poster}');"></div>
        <div class="session-contents">
          <div class="session-heading">Watch Session</div>
          <div class="session-progress">
            <button id="session-dec" class="session-btn" aria-label="Minus one episode">−1</button>
            <div class="session-meta">
              <div class="session-title">${getSeasonDisplayTitle(selectedSeason)}</div>
              <div class="session-count"><span id="session-count">${selectedSeason?.progress || 0}</span> / ${selectedSeason?.total_episodes || '∞'} eps</div>
            </div>
            <button id="session-inc" class="session-btn" aria-label="Plus one episode">+1</button>
          </div>
          <div class="session-timer">
            <div class="session-timer-display" id="session-timer-display">00:00:00</div>
            <div class="session-timer-actions">
              <button class="btn btn--secondary" id="session-timer-toggle">Start Timer</button>
              <button class="btn btn--secondary" id="session-timer-reset">Reset</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Seasons list -->
      <div class="focus-hero" style="margin-bottom:0">
        <div style="padding:16px 24px;border-bottom:1px solid var(--border);">
          <h2 style="font-size:1rem;font-weight:700;color:var(--text-primary);">Franchise Timeline</h2>
        </div>
        <div class="focus-seasons-list" id="focus-seasons-list"></div>
      </div>
      <div id="focus-research-summary" style="font-size: 0.8rem; color: var(--text-muted); margin-top: 12px; text-align: center;"></div>
    </div>
  `;

  document.getElementById('focus-back-btn')?.addEventListener('click', () => navigate('library'));
  document.getElementById('focus-edit-btn')?.addEventListener('click', () => openEditDialog(displayAnime));
  document.getElementById('focus-play-btn')?.addEventListener('click', () => {
    const episode = selectedSeason?.progress ? selectedSeason.progress + 1 : 1;
    openPlaybackPicker(selectedSeason || displayAnime, episode);
  });
  document.getElementById('focus-continue-btn')?.addEventListener('click', async () => {
    if (!continueAction?.to) return;
    await setSelectedSeason(continueAction.to.parent_root_id, continueAction.to.mal_id);
    navigate('focus', { rootId: continueAction.to.parent_root_id, force: true });
  });
  document.getElementById('session-inc')?.addEventListener('click', async () => {
    await incrementProgress(selectedSeason.parent_root_id || displayAnime.root_mal_id, selectedSeason.mal_id);
    refreshSession(selectedSeason.parent_root_id || displayAnime.root_mal_id);
  });
  document.getElementById('session-dec')?.addEventListener('click', async () => {
    await decrementProgress(selectedSeason.parent_root_id || displayAnime.root_mal_id, selectedSeason.mal_id);
    refreshSession(selectedSeason.parent_root_id || displayAnime.root_mal_id);
  });
  setupSessionTimer();

  // Manual re-search handler
  async function manualRescanFocus() {
    const btn = document.getElementById('focus-research-btn');
    const summaryEl = document.getElementById('focus-research-summary');
    if (btn) { btn.disabled = true; }
    if (summaryEl) summaryEl.textContent = 'Checking for new seasons and episode updates…';

    try {
      const currentLibrary = getState('library') || [];
      const seasonResult = await scanForNewSeasons(displayAnime, currentLibrary);
      const episodeResult = await scanForNewEpisodes(displayAnime, currentLibrary);
      try { await refreshAnimeNow(displayAnime.root_mal_id); } catch (e) { console.warn('refreshAnimeNow failed', e); }

      const autoAdded = seasonResult.autoAdded;
      const suggestions = seasonResult.suggestions;
      const updatedCount = episodeResult.updatedSeasons || 0;

      if (autoAdded > 0) {
        showToast(`Auto-added ${autoAdded} new season(s)`, 'success');
      }

      if ((suggestions || []).length > 0) {
        if (summaryEl) summaryEl.textContent = `Found ${autoAdded} auto-added and ${suggestions.length} suggested items.`;
        openRelationSelectionDialog(displayAnime, suggestions, async (selected) => {
          let extraAdded = 0;
          for (const sel of selected || []) {
            try { await mergeRelationSeason(displayAnime.root_mal_id, sel.jikanData); extraAdded += 1; } catch (e) { console.warn('Failed to add suggested', e); }
          }
          const totalAdded = autoAdded + extraAdded;
          const msg = totalAdded > 0 ? `Added ${totalAdded} new season(s). Updated ${updatedCount} episode counts.` : `Updated ${updatedCount} episode counts.`;
          showToast(msg, totalAdded > 0 ? 'success' : 'info');
          if (summaryEl) summaryEl.textContent = msg;
          navigate('focus', { rootId: displayAnime.root_mal_id, force: true });
          if (btn) btn.disabled = false;
        });
      } else {
        const msg = (autoAdded || updatedCount) ? `Added ${autoAdded} new season(s). Updated ${updatedCount} episode counts.` : 'Up to date — no changes found';
        showToast(msg, (autoAdded || updatedCount) ? 'success' : 'info');
        if (summaryEl) summaryEl.textContent = msg;
        navigate('focus', { rootId: displayAnime.root_mal_id, force: true });
      }
    } catch (err) {
      console.warn('Manual re-search failed:', err);
      showToast('Re-search failed: ' + (err && err.message), 'error');
      if (document.getElementById('focus-research-summary')) document.getElementById('focus-research-summary').textContent = 'Re-search failed. Try again.';
    } finally {
      if (document.getElementById('focus-research-btn')) document.getElementById('focus-research-btn').disabled = false;
    }
  }

  document.getElementById('focus-research-btn')?.addEventListener('click', async () => { await manualRescanFocus(); });

  // Initialise Countdown logic if present
  if (isAiringAndWaiting) {
    const valEl = document.getElementById('focus-countdown-val');
    const pillEl = document.getElementById('focus-countdown-pill');
    if (valEl) {
      const targetTime = Number(nextAiringAt);
      const updateFocusCountdown = () => {
        const diff = targetTime - Date.now();
        if (diff <= 0) {
          if (pillEl) pillEl.innerHTML = `<span style="color: var(--accent-light); text-transform: uppercase; letter-spacing: 1px;">Airing Now!</span>`;
          return;
        }
        valEl.textContent = formatDurationDDHHMMSS(diff);
      };
      updateFocusCountdown();
      const ival = setInterval(() => {
        if (!document.getElementById('focus-countdown-val')) {
          clearInterval(ival);
          return;
        }
        updateFocusCountdown();
      }, 1000);
    }
  }

  const list = document.getElementById('focus-seasons-list');
  if (list) {
    focusCluster.seasons.forEach(season => {
      const isSelected = !!season.selected;
      const isCompleted = normalizeStatus(season.watch_status) === 'completed';
      const isAiring = Boolean(season.is_airing || season.status === 'Currently Airing');
      const sp = season.total_episodes > 0 ? Math.round((season.progress / season.total_episodes) * 100) : 0;
      const isHistorical = isCompleted && !isAiring && Number(season.franchise_order_index || 0) < Number(primaryNextWatch?.franchise_order_index || selectedSeason?.franchise_order_index || 0);
      const nextSeasonAirtime = getSeasonAirtime(season);
      
      const row = document.createElement('div');
      row.className = `focus-season-row ${isSelected ? 'selected' : ''}`;
      row.style.cursor = 'pointer';
      row.style.position = 'relative';
      row.style.opacity = isHistorical ? '0.72' : '1';
      if (isAiring) row.style.borderLeft = '4px solid var(--accent-light)';

      row.innerHTML = `
        <img src="${season.poster_url || season.user_poster || season.root_entry?.poster_url || displayAnime.poster_url}" alt="" style="width:40px;height:54px;object-fit:cover;border-radius:6px;flex-shrink:0;" onerror="this.style.display='none'" />
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:0.875rem;margin-bottom:2px;color:${isSelected ? 'var(--accent-light)' : 'var(--text-primary)'}">
            ${getFocusSeasonLabel(season)}
            ${isSelected ? '<span style="font-size:0.6rem;background:var(--accent-dim);color:var(--accent-light);padding:1px 5px;border-radius:9px;margin-left:4px;vertical-align:middle;text-transform:uppercase;">Selected</span>' : ''}
            ${isAiring ? '<span style="font-size:0.6rem;background:rgba(139, 92, 246, 0.2);color:#a78bfa;padding:1px 5px;border-radius:9px;margin-left:4px;vertical-align:middle;text-transform:uppercase;border:1px solid rgba(139,92,246,0.3)">Airing</span>' : ''}
            ${(season.is_movie || season.is_ova || season.is_special) ? `<span style="font-size:0.6rem;background:rgba(255,255,255,0.08);color:var(--text-muted);padding:1px 5px;border-radius:9px;margin-left:4px;vertical-align:middle;text-transform:uppercase;">Supplemental</span>` : ''}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span class="badge-${normalizeStatus(season.watch_status)}" style="padding:1px 6px;border-radius:9999px;font-size:0.65rem;font-weight:700;text-transform:uppercase;">${statusLabel(normalizeStatus(season.watch_status))}</span>
            <span style="font-size:0.75rem;color:var(--text-muted);font-weight:500;">${season.total_episodes ? `${season.progress||0}/${season.total_episodes}` : `${season.progress||0} eps`}</span>
          </div>
          <div class="progress-bar-wrap" style="height:4px;margin-bottom:4px;background:rgba(255,255,255,0.05);"><div class="progress-bar-fill${normalizeStatus(season.watch_status)==='completed'?' completed':''}" style="width:${sp}%;animation:none;"></div></div>
          ${nextSeasonAirtime ? `<div class="focus-row-countdown" data-next-airing="${nextSeasonAirtime}" style="font-size:0.72rem;color:var(--accent-light);opacity:0;transform:translateY(2px);transition:opacity .18s ease, transform .18s ease;">Next release in <span class="focus-row-countdown__value">00:00:00:00</span></div>` : ''}
        </div>
        <div style="display:flex;gap:4px;align-items:center;">
          <button class="ep-btn dec-btn" data-root="${season.parent_root_id}" data-season="${season.mal_id}" aria-label="Decrease">−</button>
          <button class="ep-btn inc-btn" data-root="${season.parent_root_id}" data-season="${season.mal_id}" aria-label="Increase">+</button>
        </div>
      `;

      // Select hook
      row.addEventListener('click', async (e) => {
        if (e.target.closest('button')) return;
        await setSelectedSeason(season.parent_root_id, season.mal_id);
        navigate('focus', { rootId: season.parent_root_id, force: true });
      });
      attachHoverCountdown(row);
      list.appendChild(row);
    });

    list.querySelectorAll('.inc-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await incrementProgress(btn.dataset.root, btn.dataset.season);
        navigate('focus', { rootId: Number(btn.dataset.root), force: true });
      });
    });
    list.querySelectorAll('.dec-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await decrementProgress(btn.dataset.root, btn.dataset.season);
        navigate('focus', { rootId: Number(btn.dataset.root), force: true });
      });
    });
  }
}

function renderFocusInfoCard(label, title, meta) {
  return `
    <div style="padding:12px 14px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,0.03);backdrop-filter:blur(10px);min-height:92px;">
      <div style="font-size:0.68rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px;">${label}</div>
      <div style="font-size:0.95rem;font-weight:700;color:var(--text-primary);margin-bottom:4px;line-height:1.35;">${title}</div>
      <div style="font-size:0.78rem;color:var(--text-muted);line-height:1.4;">${meta}</div>
    </div>
  `;
}

function getSeasonAirtime(season) {
  return Number(season?.next_episode_airtime || season?.next_episode_airing_at || 0) || null;
}

function getFocusSeasonLabel(season) {
  if (!season) return 'Unknown';
  const pieces = [];
  if (season.season_number) pieces.push(`S${season.season_number}`);
  if (season.part_number) pieces.push(`Part ${season.part_number}`);
  if (season.is_movie) pieces.push('Movie');
  if (season.is_ova) pieces.push('OVA');
  if (season.is_special) pieces.push('Special');
  const prefix = pieces.join(' ');
  const baseTitle = season.season_label
    ? `${season.season_label} ${season.season_year || ''}`.trim()
    : getSeasonDisplayTitle(season);
  return prefix ? `${prefix} • ${baseTitle}` : baseTitle;
}

function getFocusSeasonMeta(season) {
  if (!season) return 'No season metadata available.';
  const bits = [];
  if (season.parent_title) bits.push(season.parent_title);
  if (season.total_episodes) bits.push(`${season.progress || 0}/${season.total_episodes} eps`);
  if (season.is_airing) {
    const nextAt = getSeasonAirtime(season);
    bits.push(nextAt ? `Next release in ${formatDurationDDHHMMSS(Math.max(0, nextAt - Date.now()))}` : 'Currently airing');
  } else if (season.status) {
    bits.push(season.status);
  }
  return bits.join(' • ');
}

function attachHoverCountdown(row) {
  const countdownEl = row.querySelector('.focus-row-countdown');
  if (!countdownEl || countdownEl._bound) return;
  countdownEl._bound = true;

  let interval = null;
  const valueEl = countdownEl.querySelector('.focus-row-countdown__value');
  const targetTime = Number(countdownEl.dataset.nextAiring || 0);

  const updateCountdown = () => {
    const diff = targetTime - Date.now();
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

function refreshSession(rootId) {
  const library = getState('library') || [];
  const anime = library.find(a => a.root_mal_id === Number(rootId));
  if (!anime) return;
  const season = getSelectedSeason(anime);
  const countEl = document.getElementById('session-count');
  if (countEl) countEl.textContent = season?.progress || 0;
}

let _timerStart = null;
let _timerInterval = null;
function setupSessionTimer() {
  const display = document.getElementById('session-timer-display');
  const toggleBtn = document.getElementById('session-timer-toggle');
  const resetBtn = document.getElementById('session-timer-reset');
  if (!display || !toggleBtn || !resetBtn) return;

  const render = () => {
    if (!_timerStart) { display.textContent = '00:00:00'; return; }
    const elapsed = Math.max(0, Date.now() - _timerStart);
    const h = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
    display.textContent = `${h}:${m}:${s}`;
  };

  toggleBtn.addEventListener('click', () => {
    if (_timerInterval) {
      clearInterval(_timerInterval);
      _timerInterval = null;
      _timerStart = null;
      toggleBtn.textContent = 'Start Timer';
      render();
    } else {
      _timerStart = Date.now();
      _timerInterval = setInterval(render, 1000);
      toggleBtn.textContent = 'Stop Timer';
    }
  });

  resetBtn.addEventListener('click', () => {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    _timerStart = null;
    toggleBtn.textContent = 'Start Timer';
    render();
  });

  render();
}
