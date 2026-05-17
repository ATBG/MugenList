/**
 * countdownManager.js — Platform-Aware Countdown Display System
 * 
 * Features:
 * - Desktop: Hover-activated countdown display
 * - Mobile: Persistent countdown visibility
 * - IntersectionObserver for performance (only active when visible)
 * - Tabular numbers to prevent layout shifts
 * - Smooth CSS transitions
 * - Live calculation from UTC timestamps
 */

import { formatDurationDDHHMMSS } from '../utils.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const DEBUG = true;

/** Update interval for active countdowns (ms) */
const UPDATE_INTERVAL = 1000;

/** IntersectionObserver threshold */
const VISIBLE_THRESHOLD = 0.1;

/** CSS class names */
const CLASSES = {
  countdown: 'card__countdown',
  countdownContent: 'card__countdown-content',
  countdownLabel: 'card__countdown-label',
  countdownValue: 'countdown-value',
  visible: 'countdown--visible',
  hover: 'countdown--hover',
  mobile: 'countdown--mobile',
  tabular: 'countdown--tabular',
};

// ─── State ───────────────────────────────────────────────────────────────────

/** @type {Map<number, CountdownInstance>} - Active countdown instances */
const activeCountdowns = new Map();

/** @type {IntersectionObserver | null} */
let visibilityObserver = null;

/** @type {boolean} - Is touch device */
let isTouchDevice = false;

/** @type {boolean} - Has been initialized */
let isInitialized = false;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CountdownInstance
 * @property {HTMLElement} element - Countdown DOM element
 * @property {HTMLElement} card - Parent card element
 * @property {number} targetTime - Target timestamp (ms)
 * @property {number} rootId - Anime root MAL ID
 * @property {string} seasonId - Season MAL ID
 * @property {number | null} intervalId - Update interval ID
 * @property {boolean} isVisible - Is card visible in viewport
 * @property {boolean} isHovered - Is card being hovered (desktop)
 * @property {HTMLElement} valueEl - Value display element
 * @property {boolean} hasAired - Has the episode aired
 */

// ─── Debug Logging ───────────────────────────────────────────────────────────

function log(type, message, data = null) {
  if (!DEBUG) return;
  const prefix = `[CountdownManager] ${type}:`;
  if (data) {
    console.log(prefix, message, data);
  } else {
    console.log(prefix, message);
  }
}

// ─── Device Detection ────────────────────────────────────────────────────────

/**
 * Detect if device is touch-based
 * @returns {boolean}
 */
function detectTouchDevice() {
  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    window.matchMedia('(pointer: coarse)').matches
  );
}

/**
 * Get device type for display behavior
 * @returns {'desktop' | 'mobile'}
 */
export function getDeviceType() {
  return isTouchDevice ? 'mobile' : 'desktop';
}

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the countdown manager
 */
export function initCountdownManager() {
  if (isInitialized) return;
  
  isTouchDevice = detectTouchDevice();
  log('Init', `Device type: ${getDeviceType()}`);
  
  // Create IntersectionObserver for visibility tracking
  visibilityObserver = new IntersectionObserver(
    handleVisibilityChange,
    {
      root: null,
      rootMargin: '50px',
      threshold: VISIBLE_THRESHOLD,
    }
  );
  
  // Listen for resize to detect device changes (optional)
  window.addEventListener('resize', debounce(handleResize, 250));
  
  isInitialized = true;
  log('Init', 'Countdown manager initialized');
}

/**
 * Handle visibility change from IntersectionObserver
 * @param {IntersectionObserverEntry[]} entries
 */
function handleVisibilityChange(entries) {
  for (const entry of entries) {
    const card = entry.target.closest('.anime-card');
    if (!card) continue;
    
    const rootId = Number(card.dataset.rootId);
    const instance = activeCountdowns.get(rootId);
    
    if (!instance) continue;
    
    instance.isVisible = entry.isIntersecting;
    
    if (entry.isIntersecting) {
      log('Visibility', `Card ${rootId} visible`);
      // On desktop, only activate if hovered; on mobile, activate immediately
      if (isTouchDevice || instance.isHovered) {
        activateCountdown(instance);
      }
    } else {
      log('Visibility', `Card ${rootId} hidden, pausing countdown`);
      pauseCountdown(instance);
    }
  }
}

/**
 * Handle window resize (may indicate device change)
 */
function handleResize() {
  const newIsTouch = detectTouchDevice();
  if (newIsTouch !== isTouchDevice) {
    isTouchDevice = newIsTouch;
    log('Resize', `Device type changed to: ${getDeviceType()}`);
    
    // Re-apply all countdowns with new device behavior
    for (const instance of activeCountdowns.values()) {
      applyDeviceBehavior(instance);
    }
  }
}

// ─── Countdown Lifecycle ─────────────────────────────────────────────────────

/**
 * Create or update a countdown for an anime card
 * @param {HTMLElement} card - Card DOM element
 * @param {number} targetTime - Target timestamp (ms)
 * @param {Object} options
 * @param {number} options.rootId - Anime root MAL ID
 * @param {string} options.seasonId - Season MAL ID
 */
export function attachCountdown(card, targetTime, options = {}) {
  if (!isInitialized) initCountdownManager();
  
  const { rootId, seasonId } = options;
  if (!rootId || !targetTime) return;
  
  // Check if countdown already exists
  let instance = activeCountdowns.get(rootId);
  
  if (instance) {
    // If the card has been destroyed and replaced by a new one (e.g. tab switch)
    if (instance.card !== card) {
      log('Attach', `Card reference changed for ${rootId}, re-attaching...`);
      // Cleanup old card listeners
      if (instance._enterHandler) {
        instance.card.removeEventListener('mouseenter', instance._enterHandler);
        instance.card.removeEventListener('mouseleave', instance._leaveHandler);
      }
      visibilityObserver?.unobserve(instance.card);
      
      // Update reference and re-inject element
      instance.card = card;
      const element = instance.element;
      
      if (isTouchDevice) {
        const content = card.querySelector('.card__content');
        const title = card.querySelector('.card__title');
        if (content && title) content.insertBefore(element, title.nextSibling);
      } else {
        const poster = card.querySelector('.card__poster');
        if (poster) poster.appendChild(element);
        
        card.addEventListener('mouseenter', instance._enterHandler);
        card.addEventListener('mouseleave', instance._leaveHandler);
      }
      visibilityObserver.observe(card);
    }
    
    // Update existing countdown target
    updateCountdownTarget(instance, targetTime);
    return;
  }
  
  // Create new countdown
  instance = createCountdownInstance(card, targetTime, options);
  activeCountdowns.set(rootId, instance);
  
  // Observe visibility
  visibilityObserver.observe(card);
  
  log('Attach', `Countdown attached for ${rootId}`, {
    targetTime: new Date(targetTime).toISOString(),
    device: getDeviceType(),
  });
}

/**
 * Create a new countdown instance
 * @param {HTMLElement} card
 * @param {number} targetTime
 * @param {Object} options
 * @returns {CountdownInstance}
 */
function createCountdownInstance(card, targetTime, options) {
  const { rootId, seasonId } = options;
  
  // Find or create countdown element
  let countdownEl = card.querySelector(`.${CLASSES.countdown}`);
  
  if (!countdownEl) {
    countdownEl = document.createElement('div');
    countdownEl.className = CLASSES.countdown;
    countdownEl.innerHTML = `
      <div class="${CLASSES.countdownContent}">
        <div class="${CLASSES.countdownLabel}">NEXT EPISODE</div>
        <span class="${CLASSES.countdownValue} ${CLASSES.tabular}"></span>
      </div>
    `;
    
    const poster = card.querySelector('.card__poster');
    if (poster) {
      poster.appendChild(countdownEl);
    }
  }
  
  const valueEl = countdownEl.querySelector(`.${CLASSES.countdownValue}`);
  
  const instance = {
    element: countdownEl,
    card,
    targetTime,
    rootId,
    seasonId,
    intervalId: null,
    isVisible: false,
    isHovered: false,
    valueEl,
    hasAired: false,
  };
  
  // Apply device-specific behavior
  applyDeviceBehavior(instance);
  
  return instance;
}

/**
 * Apply device-specific behavior to countdown
 * @param {CountdownInstance} instance
 */
function applyDeviceBehavior(instance) {
  const { element, card } = instance;
  
  // Remove existing listeners
  if (instance._enterHandler) {
    card.removeEventListener('mouseenter', instance._enterHandler);
    card.removeEventListener('mouseleave', instance._leaveHandler);
  }
  
  if (isTouchDevice) {
    // Mobile: Always visible when airing, placed under the title
    element.classList.add(CLASSES.mobile);
    element.classList.add(CLASSES.visible);
    instance.isHovered = true; // Treat as always hovered on mobile
    
    const content = card.querySelector('.card__content');
    const title = card.querySelector('.card__title');
    if (content && title && element.parentNode !== content) {
      content.insertBefore(element, title.nextSibling);
    }
    
    log('Behavior', `Mobile mode: countdown always visible for ${instance.rootId}`);
  } else {
    // Desktop: Hover-activated, placed over the poster
    element.classList.remove(CLASSES.mobile);
    element.classList.remove(CLASSES.visible);
    
    const poster = card.querySelector('.card__poster');
    if (poster && element.parentNode !== poster) {
      poster.appendChild(element);
    }
    
    instance._enterHandler = () => handleMouseEnter(instance);
    instance._leaveHandler = () => handleMouseLeave(instance);
    
    card.addEventListener('mouseenter', instance._enterHandler);
    card.addEventListener('mouseleave', instance._leaveHandler);
    
    log('Behavior', `Desktop mode: hover-activated countdown for ${instance.rootId}`);
  }
}

/**
 * Handle mouse enter (desktop)
 * @param {CountdownInstance} instance
 */
function handleMouseEnter(instance) {
  instance.isHovered = true;
  instance.element.classList.add(CLASSES.visible);
  instance.element.classList.add(CLASSES.hover);
  
  if (instance.isVisible) {
    activateCountdown(instance);
  }
  
  log('Hover', `Mouse enter on ${instance.rootId}`);
}

/**
 * Handle mouse leave (desktop)
 * @param {CountdownInstance} instance
 */
function handleMouseLeave(instance) {
  instance.isHovered = false;
  instance.element.classList.remove(CLASSES.visible);
  instance.element.classList.remove(CLASSES.hover);
  
  pauseCountdown(instance);
  
  log('Hover', `Mouse leave on ${instance.rootId}`);
}

/**
 * Activate countdown updates
 * @param {CountdownInstance} instance
 */
function activateCountdown(instance) {
  if (instance.intervalId) return; // Already active
  
  // Immediate update
  updateCountdownDisplay(instance);
  
  // Start interval
  instance.intervalId = window.setInterval(() => {
    updateCountdownDisplay(instance);
  }, UPDATE_INTERVAL);
  
  log('Activate', `Countdown active for ${instance.rootId}`);
}

/**
 * Pause countdown updates
 * @param {CountdownInstance} instance
 */
function pauseCountdown(instance) {
  if (!instance.intervalId) return;
  
  window.clearInterval(instance.intervalId);
  instance.intervalId = null;
  
  log('Pause', `Countdown paused for ${instance.rootId}`);
}

/**
 * Update countdown display
 * @param {CountdownInstance} instance
 */
function updateCountdownDisplay(instance) {
  const { valueEl, targetTime, element } = instance;
  if (!valueEl) return;
  
  const now = Date.now();
  const diff = targetTime - now;
  
  if (diff <= 0) {
    // Episode has aired
    valueEl.textContent = 'AIRING NOW';
    
    if (!instance.hasAired) {
      instance.hasAired = true;
      element.classList.add('countdown--aired');
      log('Aired', `Episode aired for ${instance.rootId}`);
      
      // Trigger card refresh after short delay
      setTimeout(() => {
        refreshCardAfterAiring(instance);
      }, 5000);
    }
    return;
  }
  
  // Format with tabular numbers
  valueEl.textContent = formatDurationDDHHMMSS(diff);
}

/**
 * Update countdown target time
 * @param {CountdownInstance} instance
 * @param {number} newTargetTime
 */
function updateCountdownTarget(instance, newTargetTime) {
  if (instance.targetTime === newTargetTime) return;
  
  log('Update', `Target time updated for ${instance.rootId}`, {
    old: new Date(instance.targetTime).toISOString(),
    new: new Date(newTargetTime).toISOString(),
  });
  
  instance.targetTime = newTargetTime;
  instance.hasAired = false;
  instance.element.classList.remove('countdown--aired');
  
  // Immediate update
  if (instance.isVisible && (instance.isHovered || isTouchDevice)) {
    updateCountdownDisplay(instance);
  }
}

/**
 * Refresh card after episode airs
 * @param {CountdownInstance} instance
 */
function refreshCardAfterAiring(instance) {
  const { card } = instance;
  
  // Dispatch custom event for card refresh
  card.dispatchEvent(new CustomEvent('episodeAired', {
    detail: {
      rootId: instance.rootId,
      seasonId: instance.seasonId,
    },
    bubbles: true,
  }));
  
  // Remove countdown after airing
  setTimeout(() => {
    detachCountdown(instance.rootId);
  }, 30000); // Remove after 30 seconds
}

/**
 * Detach and cleanup a countdown
 * @param {number} rootId
 */
export function detachCountdown(rootId) {
  const instance = activeCountdowns.get(rootId);
  if (!instance) return;
  
  // Cleanup
  pauseCountdown(instance);
  
  if (instance._enterHandler) {
    instance.card.removeEventListener('mouseenter', instance._enterHandler);
    instance.card.removeEventListener('mouseleave', instance._leaveHandler);
  }
  
  visibilityObserver?.unobserve(instance.card);
  
  // Remove element
  if (instance.element?.parentNode) {
    instance.element.remove();
  }
  
  activeCountdowns.delete(rootId);
  
  log('Detach', `Countdown detached for ${rootId}`);
}

/**
 * Update countdown target from external source
 * @param {number} rootId - Anime root MAL ID
 * @param {number} newTargetTime - New target timestamp
 */
export function updateCountdown(rootId, newTargetTime) {
  const instance = activeCountdowns.get(rootId);
  if (!instance) return false;
  
  updateCountdownTarget(instance, newTargetTime);
  return true;
}

/**
 * Check if countdown exists for anime
 * @param {number} rootId
 * @returns {boolean}
 */
export function hasCountdown(rootId) {
  return activeCountdowns.has(rootId);
}

/**
 * Get countdown info for debugging
 * @param {number} rootId
 * @returns {Object | null}
 */
export function getCountdownInfo(rootId) {
  const instance = activeCountdowns.get(rootId);
  if (!instance) return null;
  
  return {
    rootId: instance.rootId,
    targetTime: instance.targetTime,
    isVisible: instance.isVisible,
    isHovered: instance.isHovered,
    hasAired: instance.hasAired,
    isActive: !!instance.intervalId,
    timeRemaining: instance.targetTime - Date.now(),
  };
}

/**
 * Get all active countdowns info
 * @returns {Array<Object>}
 */
export function getAllCountdownsInfo() {
  return Array.from(activeCountdowns.keys()).map(getCountdownInfo);
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Debounce helper
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
function debounce(fn, ms) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Destroy all countdowns and cleanup
 */
export function destroyAllCountdowns() {
  for (const rootId of activeCountdowns.keys()) {
    detachCountdown(rootId);
  }
  
  visibilityObserver?.disconnect();
  visibilityObserver = null;
  isInitialized = false;
  
  log('Destroy', 'All countdowns destroyed');
}

// ─── Exports ─────────────────────────────────────────────────────────────────
// Note: Functions already exported as declarations above.
// Only exporting internal state for advanced use/testing.

export {
  activeCountdowns,
  isTouchDevice,
  CLASSES,
};
