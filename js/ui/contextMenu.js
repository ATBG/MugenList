/**
 * contextMenu.js — Right-click drop-down handler for anime cards
 */

import { incrementProgress, decrementProgress } from '../services/animeManager.js';
import { openEditDialog, openDeleteConfirm } from './dialogs.js';
import { openPlaybackPicker } from './playbackPicker.js';
import { navigate } from '../router.js';

let _activeMenu = null;

export function attachContextMenu(card, anime, activeSeason) {
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    closeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.style.zIndex = 10000;

    menu.innerHTML = `
      <div class="context-menu__item" data-action="inc">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>
        <span>Increase Progress</span>
      </div>
      <div class="context-menu__item" data-action="dec">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M5 12h14"/></svg>
        <span>Decrease Progress</span>
      </div>
      <div class="context-menu__separator"></div>
      <div class="context-menu__item" data-action="play">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M5 3v18l15-9z"/></svg>
        <span>Play Next</span>
      </div>
      <div class="context-menu__item" data-action="focus">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        <span>Focus View</span>
      </div>
      <div class="context-menu__item" data-action="edit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <span>Edit Anime</span>
      </div>
      <div class="context-menu__separator"></div>
      <div class="context-menu__item danger" data-action="delete" style="color: var(--status-dropped)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        <span>Delete Entry</span>
      </div>
    `;

    document.body.appendChild(menu);
    _activeMenu = menu;

    menu.addEventListener('click', async (me) => {
      me.stopPropagation();
      const item = me.target.closest('.context-menu__item');
      const action = item?.dataset.action;
      if (!action) return;

      closeContextMenu();

      if (action === 'inc' && activeSeason) {
        await incrementProgress(anime.root_mal_id, activeSeason.mal_id);
      } else if (action === 'dec' && activeSeason) {
        await decrementProgress(anime.root_mal_id, activeSeason.mal_id);
      } else if (action === 'play') {
        const episode = activeSeason?.progress ? activeSeason.progress + 1 : 1;
        openPlaybackPicker(activeSeason || anime, episode);
      } else if (action === 'focus') {
        navigate('focus', { rootId: anime.root_mal_id });
      } else if (action === 'edit') {
        openEditDialog(anime);
      } else if (action === 'delete') {
        openDeleteConfirm(anime);
      }
    });

    // Ensure menu stays within viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
  });
}

function closeContextMenu() {
  if (_activeMenu) {
    _activeMenu.remove();
    _activeMenu = null;
  }
}

document.addEventListener('click', closeContextMenu);
