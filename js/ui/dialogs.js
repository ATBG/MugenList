/**
 * dialogs.js — Modal dialog system (v2 schema)
 */

import { updateAnimeField, updateSeasonField, deleteAnimeEntry } from '../services/animeManager.js';
import { getSeasonsArray, getSelectedSeason, getEffectivePoster, getSeasonDisplayTitle, getRootDisplayTitle, normalizeStatus } from '../state.js';
import { showToast, statusLabel, STATUS_LABELS } from '../utils.js';
import { navigate } from '../router.js';

function openModal(html) {
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  if (!overlay || !content) return;
  content.innerHTML = html;
  overlay.classList.remove('hidden');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  }, { once: true });
}

export function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay?.classList.add('hidden');
}

// ---------- Edit Anime Franchise ----------

export function openEditDialog(anime) {
  const seasons = getSeasonsArray(anime);
  const activeSeason = getSelectedSeason(anime);

  const seasonOptions = seasons.map(s => `<option value="${s.mal_id}" ${s.mal_id === activeSeason?.mal_id ? 'selected' : ''}>${getSeasonDisplayTitle(s)}</option>`).join('');
  const statusOptions = Object.entries(STATUS_LABELS).map(([val, label]) =>
    `<option value="${val}">${label}</option>`
  ).join('');

  openModal(`
    <div class="modal-header">
      <h2 class="modal-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Edit — ${getRootDisplayTitle(anime)}</h2>
      <button class="modal-close" id="modal-close-btn" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Franchise English Title</label>
        <input class="form-input" id="edit-root-title" value="${anime.title_english || ''}" />
      </div>

      <hr style="border:none;border-top:1px solid var(--border);margin:16px 0;" />

      <div class="form-group">
        <label class="form-label">Edit Season Data</label>
        <select class="form-select" id="edit-season-select">${seasonOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Watch Status</label>
        <select class="form-select" id="edit-status">${statusOptions}</select>
      </div>
      <div style="display:flex;gap:12px;">
        <div class="form-group" style="flex:1;">
          <label class="form-label">Progress</label>
          <input class="form-input" id="edit-progress" type="number" min="0" value="${activeSeason?.progress || 0}" />
        </div>
        <div class="form-group" style="flex:1;">
          <label class="form-label">Total Episodes</label>
          <input class="form-input" id="edit-total" type="number" min="0" value="${activeSeason?.total_episodes || 0}" />
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn-secondary" id="modal-cancel-btn">Cancel</button>
      <button class="btn-primary" id="modal-save-btn">Save Changes</button>
    </div>
  `);

  const statusSelect = document.getElementById('edit-status');
  if (statusSelect && activeSeason) statusSelect.value = activeSeason.watch_status;

  const seasonSelect = document.getElementById('edit-season-select');
  seasonSelect?.addEventListener('change', () => {
    const s = anime.seasons[seasonSelect.value];
    if (!s) return;
    if (statusSelect) statusSelect.value = s.watch_status;
    const progEl = document.getElementById('edit-progress');
    const totalEl = document.getElementById('edit-total');
    if (progEl) progEl.value = s.progress || 0;
    if (totalEl) totalEl.value = s.total_episodes || 0;
  });

  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-save-btn')?.addEventListener('click', async () => {
    const newRootTitle = document.getElementById('edit-root-title')?.value?.trim();
    const selSeasonId = document.getElementById('edit-season-select')?.value;
    const newStatus = document.getElementById('edit-status')?.value;
    const newProg = parseInt(document.getElementById('edit-progress')?.value || '0');
    const newTotal = parseInt(document.getElementById('edit-total')?.value || '0');

    if (newRootTitle !== anime.title_english) {
      await updateAnimeField(anime.root_mal_id, { title_english: newRootTitle });
    }
    if (selSeasonId) {
      await updateSeasonField(anime.root_mal_id, selSeasonId, {
        watch_status: newStatus,
        progress: newProg,
        total_episodes: newTotal,
      });
    }
    showToast('Saved!', 'success');
    closeModal();
  });
}

// ---------- Confirm Delete ----------

export function openDeleteConfirm(anime) {
  const title = getRootDisplayTitle(anime);
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">Delete "${title}"?</h2>
      <button class="modal-close" id="modal-close-btn" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="modal-body">
      <p style="color:var(--text-secondary);line-height:1.6;">
        This will permanently remove <strong style="color:var(--text-primary)">${title}</strong> and all its seasons from your library. This action cannot be undone.
      </p>
    </div>
    <div class="modal-footer">
      <button class="btn-secondary" id="modal-cancel-btn">Cancel</button>
      <button class="btn-secondary btn-danger" id="modal-delete-btn">Delete</button>
    </div>
  `);

  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-delete-btn')?.addEventListener('click', async () => {
    await deleteAnimeEntry(anime.root_mal_id);
    closeModal();
  });
}

// ---------- Season Detail ----------

export function openSeasonDetail(anime, season) {
  const pct = season.total_episodes > 0 ? Math.round((season.progress / season.total_episodes) * 100) : 0;
  const genres = (season.genres || []).map(g => `<span class="genre-tag">${g}</span>`).join('');
  const poster = getEffectivePoster(anime, season);
  const title = getSeasonDisplayTitle(season);

  openModal(`
    <div class="modal-header">
      <h2 class="modal-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${title}</h2>
      <button class="modal-close" id="modal-close-btn" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="modal-body">
      <div style="display:flex;gap:16px;margin-bottom:16px;">
        <img src="${poster}" alt="" style="width:100px;height:140px;object-fit:cover;border-radius:8px;flex-shrink:0;" onerror="this.style.display='none'" />
        <div>
          <div class="genre-tags" style="margin-bottom:8px;">${genres}</div>
          <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;"><strong style="color:var(--neon-green)">${statusLabel(normalizeStatus(season.watch_status))}</strong></div>
          <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">Type: ${season.status}</div>
          <div style="font-size:0.8rem;color:var(--text-muted);">Episodes: ${season.progress} / ${season.total_episodes || '?'}</div>
        </div>
      </div>
      <div class="progress-bar-wrap" style="height:6px;margin-bottom:8px;">
        <div class="progress-bar-fill${pct===100?' completed':''}" style="width:${pct}%;animation:none;"></div>
      </div>
      <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:12px;">Overall completion: ${pct}%</div>
    </div>
    <div class="modal-footer">
      <button class="btn-secondary" id="modal-close-btn2">Close</button>
      <button class="btn-primary" id="modal-focus-btn">Open Full View</button>
    </div>
  `);

  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-close-btn2')?.addEventListener('click', closeModal);
  document.getElementById('modal-focus-btn')?.addEventListener('click', () => {
    closeModal();
    navigate('focus', { rootId: anime.root_mal_id });
  });
}
