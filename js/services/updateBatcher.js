/**
 * updateBatcher.js — RAF-batched updates for heavy operations
 * Groups multiple DOM/state updates into single animation frame to prevent layout thrashing
 */

class UpdateBatcher {
  constructor() {
    this.pending = [];
    this.scheduled = false;
  }

  /**
   * Schedule a callback to run in the next animation frame
   * Multiple calls batch together into a single RAF
   */
  batch(callback, priority = 0) {
    this.pending.push({ callback, priority });
    this.pending.sort((a, b) => b.priority - a.priority);

    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  /**
   * Execute all pending callbacks
   */
  flush() {
    const callbacks = this.pending.splice(0);
    this.scheduled = false;

    // Run all callbacks in order
    for (const { callback } of callbacks) {
      try {
        callback();
      } catch (e) {
        console.error('Batched update error:', e);
      }
    }
  }

  /**
   * Clear all pending updates
   */
  clear() {
    this.pending = [];
    this.scheduled = false;
  }

  /**
   * Get count of pending updates
   */
  count() {
    return this.pending.length;
  }
}

export const globalBatcher = new UpdateBatcher();

/**
 * Convenience function: batch a DOM update
 * Example: batchDOM(() => { el.textContent = 'foo'; })
 */
export function batchDOM(callback) {
  globalBatcher.batch(callback, 1);
}

/**
 * Convenience function: batch a state update (lower priority than DOM)
 * Example: batchState(() => { setState('key', value); })
 */
export function batchState(callback) {
  globalBatcher.batch(callback, 0);
}

/**
 * Convenience function: batch a heavy operation (lowest priority)
 * Example: batchHeavy(() => { expensiveComputation(); })
 */
export function batchHeavy(callback) {
  globalBatcher.batch(callback, -1);
}

/**
 * Batch multiple DOM updates together
 * Example: batchMultipleDOM([
 *   () => el1.style.color = 'red',
 *   () => el2.textContent = 'updated'
 * ])
 */
export function batchMultipleDOM(callbacks) {
  callbacks.forEach(cb => batchDOM(cb));
}
