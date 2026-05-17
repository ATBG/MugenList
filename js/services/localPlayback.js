/**
 * localPlayback.js — helpers for picking local files/folders and opening them
 * Uses File System Access API where available and falls back to input elements.
 */

async function idbOpen() {
  if (!('indexedDB' in window)) return null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mugellist-fs-handles', 1);
    req.onupgradeneeded = () => {
      try { req.result.createObjectStore('handles'); } catch (e) { console.warn('localPlayback: createObjectStore failed or already exists', e); }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => { console.warn('localPlayback: indexedDB open failed', e); resolve(null); };
  });
}

async function idbPut(key, value) {
  try {
    const db = await idbOpen();
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(value, key);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); resolve(false); };
    });
  } catch (err) {
    return false;
  }
}

async function idbGet(key) {
  try {
    const db = await idbOpen();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get(key);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch (err) {
    return null;
  }
}

export async function pickLocalSource({ allowDirectory = true } = {}) {
  // Prefer directory picker when allowed
  try {
    if (allowDirectory && 'showDirectoryPicker' in window) {
      const dirHandle = await window.showDirectoryPicker();
      return { kind: 'directory', handle: dirHandle };
    }
  } catch (err) {
    // user cancelled or not permitted
  }

  // Try file picker API
  try {
    if ('showOpenFilePicker' in window) {
      const handles = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Video files', accept: { 'video/*': ['.mp4', '.mkv', '.webm', '.avi'] } }] });
      if (handles && handles.length) return { kind: 'file', handle: handles[0] };
    }
  } catch (err) {
    // fall through
  }

  // Fallback to an <input type="file"> flow
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) { resolve(null); document.body.removeChild(input); return; }
      resolve({ kind: 'file', handle: f });
      document.body.removeChild(input);
    });
    document.body.appendChild(input);
    input.click();
  });
}

export async function openLocalSource(source, episode) {
  try {
    if (!source) return null;
    // File handle path
    if (source.kind === 'file') {
      // Two cases: native FileSystemFileHandle or File object
      if (typeof source.handle.getFile === 'function') {
        const file = await source.handle.getFile();
        const url = URL.createObjectURL(file);
        window.open(url, '_blank');
        // try persisting the handle
        try { await idbPut('lastLocalPlayback', source.handle); } catch (e) { console.warn('localPlayback: failed to persist lastLocalPlayback handle', e); }
        return url;
      }
      // Plain File object
      if (source.handle instanceof File) {
        const url = URL.createObjectURL(source.handle);
        window.open(url, '_blank');
        return url;
      }
    }

    // Directory handle: attempt to find episode file heuristically
    if (source.kind === 'directory' && source.handle) {
      const dir = source.handle;
      const ep = parseInt(episode || 0, 10) || 0;
      const epRegex = ep ? new RegExp(`(?:ep|episode|e)[\-_\s]*0*${ep}\b`, 'i') : null;
      let candidate = null;
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue;
        const lower = String(name).toLowerCase();
        if (!candidate && /\.(mkv|mp4|webm|avi)$/i.test(lower)) candidate = handle;
        if (epRegex && epRegex.test(name)) { candidate = handle; break; }
      }
      if (candidate) {
        const file = await candidate.getFile();
        const url = URL.createObjectURL(file);
        try { await idbPut('lastLocalPlayback', dir); } catch (e) { console.warn('localPlayback: failed to persist lastLocalPlayback directory handle', e); }
        window.open(url, '_blank');
        return url;
      }
      // no candidate found — return directory handle for possible later UI
      try { await idbPut('lastLocalPlayback', dir); } catch (e) { console.warn('localPlayback: failed to persist lastLocalPlayback directory handle', e); }
      return null;
    }
  } catch (err) {
    console.warn('openLocalSource failed', err);
    return null;
  }
}

export async function getSavedLocalSource() {
  try {
    const h = await idbGet('lastLocalPlayback');
    return h || null;
  } catch (err) {
    return null;
  }
}

export default {
  pickLocalSource,
  openLocalSource,
  getSavedLocalSource
};
