/**
 * settingsPage.js — Settings UI
 */

import { getState, setState } from '../state.js';
import { saveSettings, exportLibrary, importLibrary, clearAllAnime } from '../storage.js';
import { showToast } from '../utils.js';
import { startRelationChecker, stopRelationChecker } from '../services/relationChecker.js';
import { startCloudSync, stopCloudSync } from '../services/cloudSync.js';
import { startRefreshService, stopRefreshService, manualLibrarySync } from '../services/refreshService.js';
import { getStaleCount } from '../services/refreshUtils.js';

export function render(container) {
  const settings = getState('settings') || {};

  container.innerHTML = `
    <div class="settings-sections">

      <!-- Appearance -->
      <div class="settings-section">
        <div class="settings-section-header"><div class="settings-section-title">🎨 Appearance</div></div>
        <div class="settings-section-body">
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Animated Background</div>
              <div class="settings-row-desc">Canvas starfield particle animation</div>
            </div>
            <div class="form-toggle" id="toggle-bg-anim">
              <div class="toggle-switch${settings.background_animation ? ' active' : ''}" id="ts-bg"><div class="toggle-knob"></div></div>
              <span class="toggle-label">${settings.background_animation ? 'On' : 'Off'}</span>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Mini Tracker</div>
              <div class="settings-row-desc">Show floating \"Now Watching\" controller</div>
            </div>
            <div class="form-toggle" id="toggle-mini">
              <div class="toggle-switch${settings.show_mini_tracker !== false ? ' active' : ''}" id="ts-mini"><div class="toggle-knob"></div></div>
              <span class="toggle-label">${settings.show_mini_tracker === false ? 'Off' : 'On'}</span>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Card Size</div>
            </div>
            <select class="form-select" id="card-size-sel" style="width:140px;">
              <option value="small"${settings.card_size==='small'?' selected':''}>Small</option>
              <option value="medium"${settings.card_size==='medium'||!settings.card_size?' selected':''}>Medium</option>
              <option value="large"${settings.card_size==='large'?' selected':''}>Large</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Library -->
      <div class="settings-section">
        <div class="settings-section-header"><div class="settings-section-title">📚 Library</div></div>
        <div class="settings-section-body">
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Auto Update Status</div>
              <div class="settings-row-desc">Automatically set status to Completed when all episodes are watched</div>
            </div>
            <div class="form-toggle" id="toggle-auto-status">
              <div class="toggle-switch${settings.auto_update_status ? ' active' : ''}" id="ts-auto"><div class="toggle-knob"></div></div>
              <span class="toggle-label">${settings.auto_update_status ? 'On' : 'Off'}</span>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Relation Checker</div>
              <div class="settings-row-desc">Periodically check for sequels/prequels not in your library</div>
            </div>
            <div class="form-toggle" id="toggle-rel-check">
              <div class="toggle-switch${settings.relation_checker_enabled ? ' active' : ''}" id="ts-rel"><div class="toggle-knob"></div></div>
              <span class="toggle-label">${settings.relation_checker_enabled ? 'On' : 'Off'}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Auto-Refresh -->
      <div class="settings-section">
        <div class="settings-section-header"><div class="settings-section-title">🔄 Auto-Refresh</div></div>
        <div class="settings-section-body">
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Background Refresh</div>
              <div class="settings-row-desc">Automatically update anime metadata every 24 hours</div>
            </div>
            <div class="form-toggle" id="toggle-refresh">
              <div class="toggle-switch${settings.refresh_service_enabled !== false ? ' active' : ''}" id="ts-refresh"><div class="toggle-knob"></div></div>
              <span class="toggle-label">${settings.refresh_service_enabled !== false ? 'On' : 'Off'}</span>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Notifications</div>
              <div class="settings-row-desc">Alert when new episodes or status changes are detected</div>
            </div>
            <div class="form-toggle" id="toggle-notif">
              <div class="toggle-switch${settings.notifications_enabled ? ' active' : ''}" id="ts-notif"><div class="toggle-knob"></div></div>
              <span class="toggle-label">${settings.notifications_enabled ? 'On' : 'Off'}</span>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Library Sync</div>
              <div class="settings-row-desc">Force refresh for all metadata and countdowns</div>
            </div>
              <div style="display:flex;gap:8px;align-items:center;">
                <button class="btn--secondary" id="refresh-stale-btn">Refresh Now</button>
                <button class="btn--primary" id="refresh-library-btn">Refresh Library Now</button>
              </div>
              <div id="library-refresh-progress" style="margin-top:8px;display:none;">
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;" id="library-refresh-current">Preparing…</div>
                <div class="progress-track" style="background:rgba(255,255,255,0.06);height:8px;border-radius:6px;overflow:hidden;">
                  <div id="library-refresh-fill" style="width:0%;height:100%;background:linear-gradient(90deg,var(--accent),#a5a6f6);transition:width 220ms ease;"></div>
                </div>
              </div>
          </div>

          <!-- Progress UI -->
          <div id="sync-progress-container" class="mt-4 hidden p-4 bg-white/5 rounded-xl border border-white/10">
            <div class="flex justify-between items-center mb-2">
              <span id="sync-status-text" class="text-sm font-medium text-white/70">Syncing Library...</span>
              <span id="sync-percent-text" class="text-sm font-bold text-blue-400">0%</span>
            </div>
            <div class="w-full h-2 bg-white/10 rounded-full overflow-hidden">
              <div id="sync-progress-bar" class="h-full bg-blue-500 transition-all duration-300 shadow-[0_0_10px_rgba(56,189,248,0.5)]" style="width: 0%"></div>
            </div>
            <div id="sync-current-item" class="mt-2 text-xs text-white/40 truncate italic">Initializing...</div>
          </div>
        </div>
      </div>

      <!-- Cloud Sync -->
      <div class="settings-section">
        <div class="settings-section-header"><div class="settings-section-title">☁️ Cloud Sync</div></div>
        <div class="settings-section-body">
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Enable Cloud Sync</div>
            </div>
            <div class="form-toggle" id="toggle-cloud">
              <div class="toggle-switch${settings.cloud_sync_enabled ? ' active' : ''}" id="ts-cloud"><div class="toggle-knob"></div></div>
              <span class="toggle-label">${settings.cloud_sync_enabled ? 'On' : 'Off'}</span>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Sync Endpoint URL</label>
            <input class="form-input" id="cloud-endpoint" placeholder="https://your-api.example.com/sync" value="${settings.cloud_sync_endpoint || ''}" />
          </div>
          <button class="btn-secondary" id="save-cloud-btn">Save Sync Settings</button>
        </div>
      </div>

      <!-- AI Features -->
      <div class="settings-section">
        <div class="settings-section-header"><div class="settings-section-title">🤖 AI Features</div></div>
        <div class="settings-section-body">
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Enable AI</div>
              <div class="settings-row-desc">Use external LLM for recommendation text and taste analysis</div>
            </div>
            <div class="form-toggle" id="toggle-ai">
              <div class="toggle-switch${settings.ai_enabled ? ' active' : ''}" id="ts-ai"><div class="toggle-knob"></div></div>
              <span class="toggle-label">${settings.ai_enabled ? 'On' : 'Off'}</span>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">AI Endpoint</label>
            <input class="form-input" id="ai-endpoint" placeholder="https://api.openai.com/v1/completions" value="${settings.ai_endpoint || ''}" />
          </div>
          <div class="form-group">
            <label class="form-label">API Key</label>
            <input class="form-input" id="ai-key" type="password" placeholder="sk-…" value="${settings.ai_api_key || ''}" />
          </div>
          <button class="btn-secondary" id="save-ai-btn">Save AI Settings</button>
        </div>
      </div>

      <!-- Data Management -->
      <div class="settings-section">
        <div class="settings-section-header"><div class="settings-section-title">💾 Data Management</div></div>
        <div class="settings-section-body">
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Export Library</div>
              <div class="settings-row-desc">Download a full JSON backup of your library and settings</div>
            </div>
            <button class="btn-secondary" id="export-btn">Export JSON</button>
          </div>
          <div class="settings-row">
            <div class="settings-row-info">
              <div class="settings-row-label">Import Library</div>
              <div class="settings-row-desc">Restore from a backup file</div>
            </div>
            <div style="display:flex;gap:8px;">
              <button class="btn-secondary" id="import-merge-btn">Import (Merge)</button>
              <button class="btn-secondary" id="import-replace-btn">Import (Replace)</button>
            </div>
          </div>
          <input type="file" id="import-file-input" accept=".json" style="display:none" />
          <div class="settings-row" style="margin-top:8px;">
            <div class="settings-row-info">
              <div class="settings-row-label">Reset Library</div>
              <div class="settings-row-desc">Permanently delete all anime from library</div>
            </div>
            <button class="btn-secondary btn-danger" id="reset-btn">Reset All Data</button>
          </div>
        </div>
      </div>

      <!-- About -->
      <div class="settings-section">
        <div class="settings-section-header"><div class="settings-section-title">ℹ️ About</div></div>
        <div class="settings-section-body">
          <div style="font-size:0.875rem;color:var(--text-muted);line-height:1.7;">
            <strong style="color:var(--text-primary)">MugelList v1.0.0</strong><br>
            A local-first anime tracking system. All data stored in your browser's IndexedDB — no account required.<br><br>
            Powered by the <a href="https://jikan.moe" target="_blank" style="color:var(--accent-light)">Jikan API</a> (MyAnimeList data).
          </div>
        </div>
      </div>
    </div>
  `;

  // Toggle handlers
  setupToggle('ts-bg', 'background_animation', 'toggle-bg-anim');
  setupToggle('ts-auto', 'auto_update_status', 'toggle-auto-status');
  setupToggle('ts-mini', 'show_mini_tracker', 'toggle-mini', (val) => {
    const mt = document.getElementById('mini-tracker');
    if (!mt) return;
    mt.classList.toggle('hidden', val === false);
  });
  setupToggle('ts-rel', 'relation_checker_enabled', 'toggle-rel-check', (val) => {
    val ? startRelationChecker() : stopRelationChecker();
  });
  setupToggle('ts-refresh', 'refresh_service_enabled', 'toggle-refresh', (val) => {
    val ? startRefreshService() : stopRefreshService();
  });
  setupToggle('ts-notif', 'notifications_enabled', 'toggle-notif');
  setupToggle('ts-cloud', 'cloud_sync_enabled', 'toggle-cloud', (val) => {
    val ? startCloudSync() : stopCloudSync();
  });
  setupToggle('ts-ai', 'ai_enabled', 'toggle-ai');

  // Refresh Library Sync
  const refreshBtn = document.getElementById('refresh-stale-btn');
  const libraryBtn = document.getElementById('refresh-library-btn');

  // Quick: refresh stale items (sequential, lightweight)
  refreshBtn?.addEventListener('click', async () => {
    const library = getState('library') || [];
    const staleCount = getStaleCount(1);
    if (library.length === 0) { showToast('Library is empty', 'info'); return; }
    if (staleCount === 0) { showToast('No stale anime found', 'info'); return; }

    showToast(`Refreshing ${staleCount} stale titles…`, 'info');

    try {
      // Build explicit list of stale items (threshold 1 day)
      const items = library.filter(a => {
        const last = a.last_jikan_update ? new Date(a.last_jikan_update).getTime() : 0;
        return (Date.now() - last) > (24 * 60 * 60 * 1000);
      });

      await manualLibrarySync(items, ({ completed, total, current, changed, error }) => {
        // Minimal progress via small toast and console
        if (changed) showToast(`Updated: ${current}`, 'success', 1500);
      });

      showToast('Stale refresh complete', 'success');
    } catch (err) {
      console.error('Stale refresh failed', err);
      showToast('Stale refresh encountered errors', 'error');
    }
  });

  // Full library sync with controlled concurrency and progress UI
  libraryBtn?.addEventListener('click', async () => {
    const library = getState('library') || [];
    if (library.length === 0) { showToast('Library is empty', 'info'); return; }

    const container = document.getElementById('sync-progress-container');
    const bar = document.getElementById('sync-progress-bar');
    const statusText = document.getElementById('sync-status-text');
    const percentText = document.getElementById('sync-percent-text');
    const currentItem = document.getElementById('sync-current-item');

    // UI Start
    container.classList.remove('hidden');
    libraryBtn.disabled = true; refreshBtn.disabled = true;

    try {
      const result = await manualLibrarySync(({ completed, total, current, changed, error }) => {
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
        if (bar) bar.style.width = `${pct}%`;
        if (percentText) percentText.textContent = `${pct}%`;
        if (currentItem) currentItem.textContent = current ? `Updating: ${current}` : '';
        if (statusText) statusText.textContent = `Syncing (${completed}/${total})`;

        // Show subtle per-item update when something actually changed
        if (changed && current) {
          showToast(`Updated: ${current}`, 'success', 1400);
        }

        if (error) {
          console.warn('Sync item error', current, error);
        }
      });

      showToast(`Refresh complete — ${result.updated} updated, ${result.errors} errors`, 'success');
    } catch (err) {
      console.error('Library sync error', err);
      showToast('Sync failed', 'error');
    } finally {
      // Reset UI
      container.classList.add('hidden');
      libraryBtn.disabled = false; refreshBtn.disabled = false;
      if (bar) bar.style.width = '0%';
      if (percentText) percentText.textContent = '0%';
      if (statusText) statusText.textContent = 'Sync complete';
      setTimeout(() => { if (statusText) statusText.textContent = ''; if (currentItem) currentItem.textContent = ''; }, 2500);
    }
  });

  // Save cloud
  document.getElementById('save-cloud-btn')?.addEventListener('click', () => {
    const s = getState('settings');
    const updated = {
      ...s,
      cloud_sync_endpoint: document.getElementById('cloud-endpoint')?.value?.trim() || '',
    };
    saveSettings(updated);
    setState('settings', updated);
    showToast('Sync settings saved', 'success');
  });

  // Save AI
  document.getElementById('save-ai-btn')?.addEventListener('click', () => {
    const s = getState('settings');
    const updated = {
      ...s,
      ai_endpoint: document.getElementById('ai-endpoint')?.value?.trim() || '',
      ai_api_key: document.getElementById('ai-key')?.value?.trim() || '',
    };
    saveSettings(updated);
    setState('settings', updated);
    showToast('AI settings saved', 'success');
  });

  // Export
  document.getElementById('export-btn')?.addEventListener('click', async () => {
    await exportLibrary();
    showToast('Library exported!', 'success');
  });

  // Import
  const fileInput = document.getElementById('import-file-input');
  let importMode = 'merge';

  document.getElementById('import-merge-btn')?.addEventListener('click', () => { importMode = 'merge'; fileInput?.click(); });
  document.getElementById('import-replace-btn')?.addEventListener('click', () => { importMode = 'replace'; fileInput?.click(); });

  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const count = await importLibrary(file, importMode);
      const { getAllAnime } = await import('../storage.js');
      const updated = await getAllAnime();
      setState('library', updated);
      showToast(`Imported ${count} anime (${importMode})`, 'success');
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    }
    fileInput.value = '';
  });

  // Reset
  document.getElementById('reset-btn')?.addEventListener('click', async () => {
    if (!confirm('Are you sure? This will delete ALL anime from your library permanently.')) return;
    await clearAllAnime();
    setState('library', []);
    showToast('Library reset', 'info');
  });
}

function setupToggle(switchId, settingKey, containerId, callback) {
  const sw = document.getElementById(switchId);
  const cont = document.getElementById(containerId);
  sw?.addEventListener('click', () => {
    const settings = getState('settings');
    const newVal = !settings[settingKey];
    const updated = { ...settings, [settingKey]: newVal };
    saveSettings(updated);
    setState('settings', updated);
    sw.classList.toggle('active', newVal);
    if (cont) cont.querySelector('.toggle-label').textContent = newVal ? 'On' : 'Off';
    callback?.(newVal);
  });
}
