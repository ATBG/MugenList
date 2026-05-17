/**
 * commandPalette.js — Ctrl+K quick search and navigation (v2 schema)
 */

import { getState, getRootDisplayTitle, getSelectedSeason, normalizeStatus } from '../state.js';
import { navigate } from '../router.js';
import { fuzzyMatch } from '../utils.js';
import { incrementProgress, updateSeasonField } from '../services/animeManager.js';

let _selectedIndex = 0;
let _results = [];
const _recent = [];

export function initCommandPalette() {
  const overlay = document.getElementById('command-palette-overlay');
  if (!overlay) return;

  // Hydrate markup if not already present
  if (!overlay.dataset.hydrated) {
    overlay.innerHTML = `
      <div class="command-palette" role="dialog" aria-modal="true">
        <div class="palette-input-wrap">
          <svg class="palette-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input id="command-input" class="palette-input" type="text" placeholder="Search commands or anime..." aria-label="Command search" autocomplete="off" />
        </div>
        <div class="palette-results" id="command-results"></div>
      </div>
    `;
    overlay.dataset.hydrated = '1';
  }

  const input = document.getElementById('command-input');
  const resultsEl = document.getElementById('command-results');

  input?.addEventListener('input', (e) => {
    _selectedIndex = 0;
    renderResults(e.target.value, resultsEl);
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); _selectedIndex = Math.min(_selectedIndex + 1, _results.length - 1); updateSelection(resultsEl); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _selectedIndex = Math.max(_selectedIndex - 1, 0); updateSelection(resultsEl); }
    else if (e.key === 'Enter' && _results[_selectedIndex]) { e.preventDefault(); executeCommand(_results[_selectedIndex]); }
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

export function toggle() {
  const overlay = document.getElementById('command-palette-overlay');
  const input = document.getElementById('command-input');
  if (overlay?.classList.contains('hidden')) {
    overlay.classList.remove('hidden');
    input.value = '';
    _selectedIndex = 0;
    _results = getInitialCommands();
    renderResults('', document.getElementById('command-results'));
    setTimeout(() => input.focus(), 50);
  } else {
    close();
  }
}

export function close() {
  document.getElementById('command-palette-overlay')?.classList.add('hidden');
  document.getElementById('header-search')?.blur();
}

function getInitialCommands() {
  const base = [
    { type: 'nav', title: 'Go to Library', target: 'library', icon: '📚' },
    { type: 'nav', title: 'Go to Statistics', target: 'stats', icon: '📊' },
    { type: 'nav', title: 'Go to Recommendations', target: 'recommendations', icon: '🔮' },
    { type: 'nav', title: 'Add New Anime', target: 'add', icon: '➕' },
    { type: 'nav', title: 'Settings', target: 'settings', icon: '⚙️' },
  ];
  return _recent.slice(-5).reverse().concat(base);
}

function renderResults(query, container) {
  if (!container) return;

  if (!query.trim()) {
    _results = getInitialCommands();
  } else {
    const library = getState('library') || [];
    _results = [];

    // Search anime
    library.forEach(anime => {
      const matchRoot = fuzzyMatch(query, anime.title_english) || fuzzyMatch(query, anime.title_japanese);
      let matchSeason = false;
      Object.values(anime.seasons).forEach(s => {
        if (fuzzyMatch(query, s.title_english) || fuzzyMatch(query, s.title_japanese)) matchSeason = true;
      });

      if (matchRoot || matchSeason) {
        _results.push({
          type: 'anime',
          title: getRootDisplayTitle(anime),
          target: anime.root_mal_id,
          icon: '📺'
        });
        // Add quick actions for the first matched anime to reduce noise
        if (_results.filter(r => r.type === 'quick').length < 4) {
          const season = getSelectedSeason(anime);
          const status = normalizeStatus(season?.watch_status);
          _results.push({
            type: 'quick',
            action: 'increment',
            title: `+1 episode — ${getRootDisplayTitle(anime)}`,
            target: { rootId: anime.root_mal_id, seasonId: season?.mal_id },
            icon: '⏫'
          });
          _results.push({
            type: 'quick',
            action: 'set-watching',
            title: `Mark Watching — ${getRootDisplayTitle(anime)}`,
            target: { rootId: anime.root_mal_id, seasonId: season?.mal_id },
            icon: '▶️'
          });
          _results.push({
            type: 'quick',
            action: 'set-completed',
            title: `Mark Completed — ${getRootDisplayTitle(anime)}`,
            target: { rootId: anime.root_mal_id, seasonId: season?.mal_id },
            icon: '✅'
          });
        }
      }
    });

    // Also fuzzy search initial commands
    getInitialCommands().forEach(cmd => {
      if (fuzzyMatch(query, cmd.title)) _results.push(cmd);
    });

    _results = _results.slice(0, 10);
  }

  if (_results.length === 0) {
    container.innerHTML = `<div class="command-empty">No results found</div>`;
    return;
  }

  container.innerHTML = _results.map((r, i) => `
    <div class="palette-item ${i === _selectedIndex ? 'selected' : ''}" data-idx="${i}">
      <span class="palette-item-icon" aria-hidden="true">${r.icon}</span>
      <div>
        <div class="palette-item-title">${r.title}</div>
        ${r.type === 'anime' ? `<div class="palette-item-sub">Open focus view</div>` : `<div class="palette-item-sub">Navigate</div>`}
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.palette-item').forEach(el => {
    el.addEventListener('click', () => executeCommand(_results[parseInt(el.dataset.idx)]));
    el.addEventListener('mousemove', () => { _selectedIndex = parseInt(el.dataset.idx); updateSelection(container); });
  });
}

function updateSelection(container) {
  container.querySelectorAll('.palette-item').forEach((el, i) => el.classList.toggle('selected', i === _selectedIndex));
  const sel = container.querySelector('.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function executeCommand(cmd) {
  close();
  if (cmd.type === 'nav') {
    navigate(cmd.target);
  } else if (cmd.type === 'anime') {
    navigate('focus', { rootId: cmd.target });
    _recent.push({ ...cmd, recent: true });
  } else if (cmd.type === 'quick') {
    handleQuickAction(cmd);
    _recent.push({ ...cmd, recent: true });
  }
}

async function handleQuickAction(cmd) {
  const { rootId, seasonId } = cmd.target || {};
  if (!rootId) return;
  const library = getState('library') || [];
  const anime = library.find(a => a.root_mal_id === Number(rootId));
  if (!anime) return;
  const sid = seasonId || anime.selected_season_mal_id;

  if (cmd.action === 'increment') {
    await incrementProgress(rootId, sid);
  } else if (cmd.action === 'set-watching') {
    await updateSeasonField(rootId, sid, { watch_status: 'watching' });
  } else if (cmd.action === 'set-completed') {
    await updateSeasonField(rootId, sid, { watch_status: 'completed', progress: anime.seasons[String(sid)]?.total_episodes || 0 });
  }
}
