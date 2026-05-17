/**
 * storageQueue.js — Write queueing for IndexedDB operations
 * Batches writes to prevent excessive I/O and improve performance
 */

import { openDB } from '../storage.js';

const ANIME_STORE = 'anime_v2';
const FLUSH_INTERVAL = 1000; // ms
const MAX_QUEUE_SIZE = 50;

class StorageQueue {
  constructor() {
    this.queue = [];
    this.flushTimer = null;
    this.flushing = false;
    this.currentFlushPromise = null;
  }

  /**
   * Queue a single anime write
   */
  queueAnimeWrite(animeEntry) {
    this.queue.push({
      type: 'put',
      entry: { ...animeEntry, root_mal_id: Number(animeEntry.root_mal_id) }
    });

    // Auto-flush if queue gets too large
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Queue a batch of anime writes
   */
  queueBatchWrite(animeList) {
    animeList.forEach(a => {
      this.queue.push({
        type: 'put',
        entry: { ...a, root_mal_id: Number(a.root_mal_id) }
      });
    });

    // Auto-flush if queue gets too large
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Queue a delete operation
   */
  queueDelete(rootMalId) {
    this.queue.push({
      type: 'delete',
      rootMalId: Number(rootMalId)
    });

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Schedule a flush to happen after FLUSH_INTERVAL
   */
  scheduleFlush() {
    if (this.flushTimer) return; // Already scheduled
    
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, FLUSH_INTERVAL);
  }

  /**
   * Flush all queued operations immediately
   */
  async flush() {
    if (this.flushing) return this.currentFlushPromise;
    if (this.queue.length === 0) return Promise.resolve();

    this.flushing = true;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;

    const ops = this.queue.splice(0);
    const finalize = () => {
      this.flushing = false;
      this.currentFlushPromise = null;
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    };

    try {
      const database = await openDB();
      const tx = database.transaction(ANIME_STORE, 'readwrite');
      const store = tx.objectStore(ANIME_STORE);

      for (const op of ops) {
        if (op.type === 'put') {
          store.put(op.entry);
        } else if (op.type === 'delete') {
          store.delete(op.rootMalId);
        }
      }

      this.currentFlushPromise = new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          this.queue.unshift(...ops);
          finalize();
          reject(error || new Error('Storage queue transaction failed'));
        };

        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          finalize();
          resolve();
        };
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error || new Error('Storage queue transaction aborted'));
      });

      return this.currentFlushPromise;
    } catch (e) {
      this.queue.unshift(...ops);
      finalize();
      console.error('Storage queue flush error:', e);
      throw e;
    }
  }

  /**
   * Force immediate flush and wait for completion
   */
  async forceFlush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    return this.flush();
  }

  /**
   * Get queue size for debugging
   */
  size() {
    return this.queue.length;
  }

  /**
   * Clear all pending operations (danger!)
   */
  clear() {
    this.queue = [];
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

export const storageQueue = new StorageQueue();

/**
 * Flush queue on page unload to ensure nothing is lost
 */
if (typeof window !== 'undefined') {
  const flushPendingWrites = () => {
    if (storageQueue.size() > 0) {
      storageQueue.forceFlush().catch(e => console.error('Flush on lifecycle event failed:', e));
    }
  };

  window.addEventListener('beforeunload', () => {
    flushPendingWrites();
  });

  window.addEventListener('pagehide', flushPendingWrites);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPendingWrites();
    }
  });
}
