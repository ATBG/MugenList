/**
 * storage.js — IndexedDB v2 + localStorage wrappers
 * Primary key: root_mal_id (number)
 */

const DB_NAME = 'MugelListDB';
const DB_VERSION = 2;          // bumped for schema v2
const ANIME_STORE = 'anime_v2';
const SETTINGS_KEY = 'mugellist_settings_v2';

let db = null;

// ---------- IndexedDB ----------

export async function openDB() {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      const oldVersion = e.oldVersion;

      // Create v2 store (root_mal_id is a number, used as keyPath)
      if (!database.objectStoreNames.contains(ANIME_STORE)) {
        const store = database.createObjectStore(ANIME_STORE, { keyPath: 'root_mal_id' });
        store.createIndex('title_english', 'title_english', { unique: false });
        store.createIndex('updated_date', 'updated_date', { unique: false });
      }

      // If upgrading from v1 — leave old store, migration happens at runtime
    };

    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

export async function getAllAnime() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(ANIME_STORE, 'readonly');
    const req = tx.objectStore(ANIME_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function getAnimeByRootId(rootMalId) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(ANIME_STORE, 'readonly');
    const req = tx.objectStore(ANIME_STORE).get(Number(rootMalId));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAnime(animeEntry) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(ANIME_STORE, 'readwrite');
    // Ensure root_mal_id is a number
    const entry = { ...animeEntry, root_mal_id: Number(animeEntry.root_mal_id) };
    const req = tx.objectStore(ANIME_STORE).put(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteAnime(rootMalId) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(ANIME_STORE, 'readwrite');
    const req = tx.objectStore(ANIME_STORE).delete(Number(rootMalId));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function saveAllAnime(animeList) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(ANIME_STORE, 'readwrite');
    const store = tx.objectStore(ANIME_STORE);
    animeList.forEach(a => {
      store.put({ ...a, root_mal_id: Number(a.root_mal_id) });
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllAnime() {
  try {
    const { storageQueue } = await import('./services/storageQueue.js');
    await storageQueue.forceFlush().catch(() => {});
    storageQueue.clear();
  } catch {
    // If the queue module is unavailable, continue with DB clear.
  }

  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(ANIME_STORE, 'readwrite');
    const req = tx.objectStore(ANIME_STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------- localStorage (settings) ----------

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
    // Try old key for migration
    const oldRaw = localStorage.getItem('mugellist_settings');
    if (oldRaw) return JSON.parse(oldRaw);
    return null;
  } catch { return null; }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ---------- Export / Import ----------

export async function exportLibrary() {
  const anime = await getAllAnime();
  const settings = loadSettings();
  const blob = new Blob(
    [JSON.stringify({ schema_version: 2, anime, settings, exported_at: new Date().toISOString() }, null, 2)],
    { type: 'application/json' }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mugellist-v2-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importLibrary(file, mode = 'replace') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        // Support bare array OR { anime: [...] } OR { schema_version: 2, anime: [...] }
        let animeList = Array.isArray(data) ? data : (data.anime || []);

        // Auto-migrate if old schema detected
        const { migrateOldSchema } = await import('./services/animeManager.js');
        animeList = animeList.map(item => {
          // Detect old schema: has .id string, has seasons as array
          if (typeof item.id === 'string' && Array.isArray(item.seasons)) {
            return migrateOldSchema(item);
          }
          return item;
        }).filter(Boolean);

        if (mode === 'replace') {
          await clearAllAnime();
          await saveAllAnime(animeList);
        } else {
          const existing = await getAllAnime();
          const existingIds = new Set(existing.map(a => a.root_mal_id));
          const toAdd = animeList.filter(a => !existingIds.has(Number(a.root_mal_id)));
          const merged = [...existing, ...toAdd];
          await saveAllAnime(merged);
        }

        if (data.settings) saveSettings(data.settings);
        resolve(animeList.length);
      } catch (err) { reject(err); }
    };
    reader.readAsText(file);
  });
}

// ---------- Seed from JSON ----------

export async function seedFromJSON(url) {
  try {
    console.log('📥 seedFromJSON: Fetching from', url);
    const res = await fetch(url);
    console.log('📥 seedFromJSON fetch status:', res.status);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    console.log('📥 seedFromJSON: Parsed JSON, array length:', Array.isArray(data) ? data.length : data.anime?.length || 0);
    const rawList = Array.isArray(data) ? data : data.anime || [];
    
    // Auto-migrate if old schema detected
    const { migrateOldSchema } = await import('./services/animeManager.js');
    const toSave = rawList.map(item => {
      if (typeof item.id === 'string' && Array.isArray(item.seasons)) {
        return migrateOldSchema(item);
      }
      return item;
    }).filter(Boolean);
    
    console.log('📥 seedFromJSON: Saving ' + toSave.length + ' items to IndexedDB');
    await saveAllAnime(toSave);
    console.log('✅ seedFromJSON: Success, saved ' + toSave.length + ' items');
    return toSave;
  } catch (e) {
    console.error('❌ Seed failed:', e.message, e);
    console.warn('⚠️  seedFromJSON fallback: returning empty array. This likely means fetch failed (file:// or CORS issue)');
    return [];
  }
}
