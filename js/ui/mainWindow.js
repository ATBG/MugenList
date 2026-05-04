/**
 * mainWindow.js — Dynamic Window layout engine
 */

import { toggle as togglePalette } from './commandPalette.js';
import { initWorkspaceTabs, openTab } from './workspaceTabs.js';
import { initMiniTracker } from './miniTracker.js';

export function renderMainWindow() {
  const mount = document.getElementById('dynamic-shell-mount');
  if (!mount) return;

  mount.innerHTML = `
    <div class="desktop-shell">
      <!-- Minimalist Desktop Top Bar -->
      <header class="top-bar">
        <div class="top-bar-left">
          <div class="top-bar-logo">
            <span class="logo-icon">⛩</span>
            <span class="logo-text">MugelList</span>
          </div>
        </div>

        <div class="top-bar-center">
          <!-- Search box integrated globally, triggers command palette -->
          <div class="top-search-bar" id="top-search-bar">
            <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <span class="search-placeholder">Search library or jump to page...</span>
            <kbd class="search-shortcut">Ctrl+K</kbd>
          </div>
        </div>

        <div class="top-bar-right">
          <!-- Primary Add Anime action — prominent, labeled, thumb-friendly -->
          <button class="top-add-btn" id="top-add-btn" aria-label="Add Anime" title="Add Anime">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span class="top-add-btn__label">Add Anime</span>
          </button>
          <button class="top-action-btn" id="top-settings-btn" aria-label="Settings" title="Settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
      </header>

      <!-- Window System: Tabs and Shelves -->
      <div class="window-tab-system">
        <!-- Active Tab Bar -->
        <nav id="tab-bar" class="tab-bar"></nav>
        
        <!-- Minimized Tab Shelf (only shown when tabs exist) -->
        <div id="tab-shelf" class="tab-shelf empty"></div>
      </div>

      <!-- Main Central Window Content Area -->
      <main id="workspace" class="workspace"></main>

      <!-- Mobile FAB for quick add access -->
      <button class="mobile-fab" id="mobile-fab" aria-label="Add Anime" title="Add Anime">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="22" height="22"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>
  `;

  // Bind top bar global actions
  document.getElementById('top-search-bar')?.addEventListener('click', () => {
    togglePalette();
  });

  document.getElementById('top-add-btn')?.addEventListener('click', () => {
    openTab({ type: 'add', id: 'system-add', title: 'Add Anime', closable: true });
  });

  document.getElementById('mobile-fab')?.addEventListener('click', () => {
    openTab({ type: 'add', id: 'system-add', title: 'Add Anime', closable: true });
  });

  document.getElementById('top-settings-btn')?.addEventListener('click', () => {
    openTab({ type: 'settings', id: 'system-settings', title: 'Settings', closable: true });
  });

  // Init foundational UI systems based on the new DOM
  initWorkspaceTabs();
  initMiniTracker(); // re-checks for #mini-tracker elements
}
