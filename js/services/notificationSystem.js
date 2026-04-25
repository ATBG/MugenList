/**
 * notificationSystem.js — Centralized notification management
 * 
 * Responsibilities:
 * - Queue and display notifications
 * - Deduplicate based on content and timing
 * - Persist seen notifications to localStorage
 * - API for adding notifications from various sources
 */

import { setState, getState } from '../state.js';
import { generateId } from '../utils.js';
import { renderNotificationToast } from './notificationToast.js';

const NOTIFICATION_STORAGE_KEY = 'mugellist_notifications_v1';
const NOTIFICATION_TIMEOUT_MS = 5000; // auto-dismiss after 5 seconds
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory notification queue
let _notificationQueue = [];

// Track seen notifications to prevent duplicates
let _seenNotifications = {};

/**
 * Initialize notification system
 * Load seen notifications from localStorage
 */
export function initNotificationSystem() {
  try {
    const stored = localStorage.getItem(NOTIFICATION_STORAGE_KEY);
    if (stored) {
      _seenNotifications = JSON.parse(stored);
      console.log('📬 Loaded', Object.keys(_seenNotifications).length, 'seen notifications');
    }
  } catch (err) {
    console.warn('Failed to load seen notifications:', err);
  }

  setState('notifications', []);
}

/**
 * Add a notification to the queue
 * 
 * @param {string} type - Notification type: 'new_episode', 'status_changed', 'started_airing', etc.
 * @param {string} title - Main notification text
 * @param {object} anime - Anime entry object
 * @param {string} details - Secondary details/metadata
 * @returns {string} Notification ID
 */
export function addNotification(type, title, anime, details = '') {
  const settings = getState('settings') || {};
  if (settings.notifications_enabled === false) {
    return null;
  }

  if (!anime?.root_mal_id) {
    console.warn('Skipped notification with missing anime payload:', type, title);
    return null;
  }

  // Generate deduplication key
  const dedupKey = generateDedupKey(type, anime, details);
  
  // Check if we've seen this notification recently
  if (isDuplicate(dedupKey)) {
    console.log('🔕 Suppressed duplicate notification:', title);
    return null;
  }

  // Mark as seen
  _seenNotifications[dedupKey] = Date.now();
  persistSeenNotifications();

  // Create notification object
  const notif = {
    id: generateId('notif'),
    type,
    title,
    anime: {
      root_mal_id: anime.root_mal_id,
      title_english: anime.title_english,
      poster_url: anime.poster_url,
    },
    details,
    createdAt: Date.now(),
    read: false,
    dismissed: false,
  };

  // Add to queue
  _notificationQueue.push(notif);
  
  // Update state
  setState('notifications', _notificationQueue);

  // Render the toast
  renderNotificationToast(notif, NOTIFICATION_TIMEOUT_MS);

  console.log('🔔 Notification:', type, '-', title);

  return notif.id;
}

/**
 * Mark a notification as read
 */
export function markNotificationRead(notifId) {
  const idx = _notificationQueue.findIndex(n => n.id === notifId);
  if (idx < 0) return;

  _notificationQueue[idx].read = true;
  setState('notifications', _notificationQueue);
}

/**
 * Dismiss a specific notification
 */
export function dismissNotification(notifId) {
  _notificationQueue = _notificationQueue.filter(n => n.id !== notifId);
  setState('notifications', _notificationQueue);
}

/**
 * Clear all notifications
 */
export function clearAllNotifications() {
  _notificationQueue = [];
  setState('notifications', _notificationQueue);
}

/**
 * Get all active notifications
 */
export function getNotifications() {
  return [..._notificationQueue];
}

/**
 * Get unread notification count
 */
export function getUnreadCount() {
  return _notificationQueue.filter(n => !n.read && !n.dismissed).length;
}

/**
 * Generate a deduplication key based on notification content
 * This ensures we don't spam the same notification multiple times
 */
function generateDedupKey(type, anime, details) {
  const animeId = anime.root_mal_id;
  const contentHash = `${type}_${animeId}_${details}`.toLowerCase();
  return contentHash;
}

/**
 * Check if a notification is a duplicate (seen recently)
 */
function isDuplicate(dedupKey) {
  const lastSeen = _seenNotifications[dedupKey];
  if (!lastSeen) return false;

  // Don't show same notification twice within DEDUP_WINDOW
  const timeSinceLastSeen = Date.now() - lastSeen;
  return timeSinceLastSeen < DEDUP_WINDOW_MS;
}

/**
 * Persist seen notifications to localStorage
 */
function persistSeenNotifications() {
  try {
    // Only keep the last 1000 to avoid localStorage bloat
    const entries = Object.entries(_seenNotifications)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 1000);
    
    _seenNotifications = Object.fromEntries(entries);
    localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(_seenNotifications));
  } catch (err) {
    console.warn('Failed to persist seen notifications:', err);
  }
}

/**
 * Clean up old seen notifications (older than DEDUP_WINDOW)
 */
export function cleanupOldNotifications() {
  const now = Date.now();
  const cutoff = now - DEDUP_WINDOW_MS;

  for (const [key, timestamp] of Object.entries(_seenNotifications)) {
    if (timestamp < cutoff) {
      delete _seenNotifications[key];
    }
  }

  persistSeenNotifications();
  console.log('🧹 Cleaned up old notifications');
}

if (typeof window !== 'undefined') {
  // Cleanup old notifications on init
  setTimeout(cleanupOldNotifications, 5000);

  // Periodic cleanup every 6 hours
  setInterval(cleanupOldNotifications, 6 * 60 * 60 * 1000);
}
