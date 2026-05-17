/**
 * notificationToast.js — Render notification toast elements
 * Uses plain CSS animations and styling (no Tailwind)
 */

import { dismissNotification } from './notificationSystem.js';

// Cache for toast containers to avoid creating multiple
let _toastContainer = null;

/**
 * Get or create the notification toast container
 */
function getToastContainer() {
  if (_toastContainer) return _toastContainer;

  // Try to find existing container
  _toastContainer = document.getElementById('notification-toasts');

  // Create if doesn't exist
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.id = 'notification-toasts';
    _toastContainer.className = 'notification-toasts';
    _toastContainer.setAttribute('role', 'region');
    _toastContainer.setAttribute('aria-label', 'Notifications');
    _toastContainer.setAttribute('aria-live', 'polite');
    _toastContainer.setAttribute('aria-atomic', 'false');
    document.body.appendChild(_toastContainer);
  }

  return _toastContainer;
}

/**
 * Render a notification toast
 */
export function renderNotificationToast(notif, autoDismissMs = 5000) {
  const container = getToastContainer();

  const toast = createToastElement(notif);
  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  // Auto-dismiss after timeout
  if (autoDismissMs > 0) {
    const timeoutId = setTimeout(() => {
      dismissToast(toast, notif.id);
    }, autoDismissMs);

    // Cancel timeout if user dismisses manually
    const dismissBtn = toast.querySelector('.notification-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => clearTimeout(timeoutId));
    }
  }
}

/**
 * Create the toast element
 */
function createToastElement(notif) {
  const typeConfig = getNotificationTypeConfig(notif.type);

  const toast = document.createElement('div');
  toast.className = `notification-toast notification-toast-${notif.type}`;
  toast.dataset.notifId = notif.id;
  toast.setAttribute('role', 'alert');

  // Build the toast content
  const icon = document.createElement('div');
  icon.className = 'notification-icon';
  icon.innerHTML = typeConfig.icon;

  const content = document.createElement('div');
  content.className = 'notification-content';

  const title = document.createElement('div');
  title.className = 'notification-title';
  title.textContent = notif.title;

  const details = document.createElement('div');
  details.className = 'notification-details';
  details.textContent = notif.details || '';

  content.appendChild(title);
  if (notif.details) {
    content.appendChild(details);
  }

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'notification-dismiss-btn';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.innerHTML = '×';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissToast(toast, notif.id);
  });

  toast.appendChild(icon);
  toast.appendChild(content);
  toast.appendChild(closeBtn);

  return toast;
}

/**
 * Dismiss a toast with animation
 */
function dismissToast(toast, notifId) {
  toast.classList.remove('visible');
  setTimeout(() => {
    toast.remove();
    dismissNotification(notifId);
  }, 300);
}

/**
 * Get visual configuration for notification types
 */
function getNotificationTypeConfig(type) {
  const configs = {
    new_episode: {
      icon: '🎬',
      color: 'var(--color-cyan)',
      label: 'New Episodes',
    },
    status_changed: {
      icon: '📝',
      color: 'var(--color-indigo)',
      label: 'Status Changed',
    },
    started_airing: {
      icon: '📺',
      color: 'var(--color-green)',
      label: 'Now Airing',
    },
    metadata_updated: {
      icon: '✨',
      color: 'var(--color-indigo)',
      label: 'Metadata Updated',
    },
    refresh_complete: {
      icon: '✓',
      color: 'var(--color-cyan)',
      label: 'Refresh Complete',
    },
    success: {
      icon: '✓',
      color: 'var(--color-green)',
      label: 'Success',
    },
    info: {
      icon: 'ℹ',
      color: 'var(--color-cyan)',
      label: 'Info',
    },
    warning: {
      icon: '⚠',
      color: 'var(--color-yellow)',
      label: 'Warning',
    },
    error: {
      icon: '✗',
      color: 'var(--color-red)',
      label: 'Error',
    },
  };

  return configs[type] || configs.info;
}

/**
 * Clear all notification toasts
 */
export function clearAllToasts() {
  const container = getToastContainer();
  container.querySelectorAll('.notification-toast').forEach(toast => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  });
}
