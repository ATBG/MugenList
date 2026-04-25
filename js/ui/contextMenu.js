/**
 * contextMenu.js — Right-click drop-down handler for anime cards
 */

import { incrementProgress, decrementProgress } from '../services/animeManager.js';
import { openEditDialog, openDeleteConfirm } from './dialogs.js';
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
      <div class="context-menu-inner">
        <div class="context-item" data-action="inc">Increase Progress</div>
        <div class="context-item" data-action="dec">Decrease Progress</div>
        <div class="context-separator"></div>
        <div class="context-item" data-action="focus">Focus View</div>
        <div class="context-item" data-action="edit">Edit Entry</div>
        <div class="context-separator"></div>
        <div class="context-item danger" data-action="delete">Delete</div>
      </div>
    `;

    document.body.appendChild(menu);
    _activeMenu = menu;

    menu.addEventListener('click', async (me) => {
      me.stopPropagation();
      const action = me.target.dataset.action;
      if (!action) return;

      closeContextMenu();

      if (action === 'inc' && activeSeason) {
        await incrementProgress(anime.root_mal_id, activeSeason.mal_id);
      } else if (action === 'dec' && activeSeason) {
        await decrementProgress(anime.root_mal_id, activeSeason.mal_id);
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
