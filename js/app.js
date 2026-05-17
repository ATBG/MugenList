/**
 * app.js — Entry point: initialize all modules, seed data, register routes
 */

import { openDB, getAllAnime, loadSettings, saveSettings, saveAllAnime, seedFromJSON } from './storage.js';
import { setState, getState, subscribe, patchState } from './state.js';
import { initWorkspaceTabs } from './ui/workspaceTabs.js';
import { initFiltersPanel } from './ui/filtersPanel.js';
import { initCommandPalette, toggle as togglePalette } from './ui/commandPalette.js';
import { initMiniTracker } from './ui/miniTracker.js';
import { initBackground } from './ui/animations.js';
import { registerRoute, navigate } from './router.js';
import { refreshLibraryRelations } from './services/relationFinder.js';
import { startCloudSync } from './services/cloudSync.js';
import { startEpisodeSync } from './services/episodeSyncService.js';
import { startAiringDaemon } from './services/airingDaemon.js';
import { startRefreshService } from './services/refreshService.js';
import { startDailySync } from './services/relationEngine.js';
import { initNotificationSystem } from './services/notificationSystem.js';
import { normalizeLibraryMetadata } from './services/franchiseService.js';
import { initCountdownManager } from './services/countdownManager.js';

// --- Pages ---
import { render as renderLibrary } from './pages/libraryPage.js';
import { render as renderFocus } from './pages/focusPage.js';
import { render as renderStats } from './pages/statsPage.js';
import { render as renderRecommendations } from './pages/recommendationsPage.js';
import { render as renderSettings } from './pages/settingsPage.js';
import { render as renderAddAnime } from './pages/addAnimePage.js';

// ---------- Default Settings ----------
const DEFAULT_SETTINGS = {
  theme: 'dark',
  language: 'en',
  view_mode: 'grid',
  card_size: 'medium',
  show_mini_tracker: true,
  auto_update_status: true,
  relation_checker_enabled: false, // disabled by default (API rate limiting)
  relation_checker_interval_hours: 24,
  cloud_sync_enabled: false,
  cloud_sync_endpoint: '',
  ai_enabled: false,
  ai_endpoint: '',
  ai_api_key: '',
  jikan_rate_limit: 3,
  poster_cache_enabled: true,
  background_animation: true,
  notifications_enabled: true,
  refresh_service_enabled: true,  // auto-refresh service
  refresh_interval_hours: 24,     // check stale entries every 24h
  refresh_on_app_start: true,     // run refresh check when app starts
  default_sort: 'custom_order',
  version: '1.0.0',
};

// ---------- Boot ----------
async function init() {
  try {
    // PHASE 0: Render initial shell so user sees something
    await import('./ui/mainWindow.js').then(m => m.renderMainWindow());
    
    // Show loading state
    setState('readyState', 'loading');
    
    // 1. Open DB
    await openDB();

    // 2. Load settings
    let settings = loadSettings();
    if (!settings) {
      settings = { ...DEFAULT_SETTINGS };
      saveSettings(settings);
    } else {
      settings = { ...DEFAULT_SETTINGS, ...settings };
    }
    setState('settings', settings);
    setState('viewMode', settings.view_mode || 'grid');
    // expose minimal state helpers for UI modules that need synchronous access
    window.__mugelState = { getState, setState, patchState, subscribe };

    // 3. Load library (starts completely empty/fresh for new browsers/IPs)
    let library = await getAllAnime();
    
    console.log('📂 getAllAnime() returned ' + library.length + ' items');
    console.log('📚 Setting library into state with ' + library.length + ' items');
    setState('library', library);
    console.log('📚 State updated. Verifying: getState("library").length = ' + (getState('library') || []).length);

    // Normalize franchise/ranking metadata once at boot so renders stay pure and cached.
    if (library.length > 0) {
      const normalized = normalizeLibraryMetadata(library);
      library = normalized.library;
      if (normalized.changed) {
        await saveAllAnime(library);
        console.log('🧭 Franchise metadata normalized and persisted at boot');
      }
    }

    // 4. Register routes
    registerRoute('library', renderLibrary);
    registerRoute('focus', renderFocus);
    registerRoute('stats', renderStats);
    registerRoute('recommendations', renderRecommendations);
    registerRoute('settings', renderSettings);
    registerRoute('add', renderAddAnime);
    
    // 5. HYDRATION COMPLETE — Mark state as ready
    setState('readyState', 'ready');
    setState('hydratedAt', Date.now());
    console.log('✅ State hydration complete');
    
    // 6. Command palette binds globally
    initCommandPalette();

    // 7. Background animation
    if (settings.background_animation) {
      initBackground();
    }

    // 8. Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ctrl+K — Command palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        togglePalette();
      }
      // Escape — close palette / modal
      if (e.key === 'Escape') {
        const palette = document.getElementById('command-palette-overlay');
        if (!palette?.classList.contains('hidden')) {
          import('./ui/commandPalette.js').then(m => m.close()).catch(err => console.warn('Failed to load/close commandPalette', err));
          return;
        }
        const modal = document.getElementById('modal-overlay');
        if (!modal?.classList.contains('hidden')) {
          import('./ui/dialogs.js').then(m => m.closeModal()).catch(err => console.warn('Failed to load/close dialogs', err));
        }
      }
    });

    // 9. Library search handled within library page; no palette hijack

    // 10. View mode sync with buttons
    const viewGridBtn = document.getElementById('view-grid');
    const viewListBtn = document.getElementById('view-list');
    if (settings.view_mode === 'list') {
      viewGridBtn?.classList.remove('active');
      viewListBtn?.classList.add('active');
    }

    // Subscribe to library changes to keep count updated
    subscribe('library', (lib) => {
      const countEl = document.getElementById('page-count');
      if (countEl && getState('activeTab') === 'library') {
        countEl.textContent = `${lib.length} title${lib.length !== 1 ? 's' : ''}`;
      }
    });

    // 11. Initialize notification system
    initNotificationSystem();

    // 12. Optional background services
    if (settings.cloud_sync_enabled && settings.cloud_sync_endpoint) {
      startCloudSync();
    }
    
    // 13. Background refresh service (24h freshness checks with change detection)
    if (settings.refresh_service_enabled !== false) {
      startRefreshService();
    }
    
    // 14. Real-time Airing & Episode Sync (Jikan + AniList)
    startEpisodeSync();
    startAiringDaemon();

    // 14b. Unified daily sync — new seasons + episode detection via relationEngine
    startDailySync();

    // 14c. Initialize countdown manager for platform-aware episode countdowns
    initCountdownManager();

    // 15. Navigate to library (initial route)
    navigate('library');

    // 15. Remove initial loader
    document.getElementById('initial-loader')?.remove();

    console.log('✅ MugelList initialized — library:', library.length, 'titles');

  } catch (err) {
    console.error('❌ MugelList init failed:', err);
    setState('readyState', 'error');
    const errorDisplay = document.getElementById('error-display');
    const errorMsg = document.getElementById('error-message');
    if (errorDisplay && errorMsg) {
      errorDisplay.style.display = 'block';
      errorMsg.textContent = `MugelList Initialization Failed\n\n${err.message}\n\n${err.stack}`;
    } else {
      const fallback = document.getElementById('dynamic-shell-mount') || document.getElementById('app');
      if (fallback) {
        fallback.innerHTML = `
          <div style="padding: 40px; color: #ff6b6b; font-family: monospace; white-space: pre-wrap;">
            <h1>MugelList Initialization Failed</h1>
            <p>${err.message}</p>
            <p>${err.stack}</p>
          </div>
        `;
      }
    }
  }
}

// Start the app
init();
