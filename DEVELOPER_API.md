# Developer Quick Reference: Refresh & Notifications API

## Imports

```javascript
// Refresh Service
import { 
  startRefreshService,
  stopRefreshService,
  refreshAnimeNow,
  getTimeUntilNextRefresh,
  getRefreshStatus 
} from '../services/refreshService.js';

// Notification System
import { 
  initNotificationSystem,
  addNotification,
  dismissNotification,
  clearAllNotifications,
  getNotifications,
  getUnreadCount,
  markNotificationRead,
  cleanupOldNotifications
} from '../services/notificationSystem.js';

// Refresh Utilities
import { 
  getRefreshStatusText,
  getLastRefreshTime,
  isDueForRefresh,
  isStale,
  getStaleCount,
  manualRefreshAnime,
  refreshAllStale
} from '../services/refreshUtils.js';

// Notification UI
import { 
  renderNotificationToast,
  clearAllToasts
} from '../services/notificationToast.js';
```

## Core APIs

### Refresh Service

```javascript
// Start background refresh service (auto-runs on init)
startRefreshService();

// Stop background refresh service
stopRefreshService();

// Manually refresh a specific anime
await refreshAnimeNow(rootMalId);

// Get time (ms) until next auto-refresh
const timeMs = getTimeUntilNextRefresh(anime);
// Returns: null | 0 | positive milliseconds

// Get human-readable refresh status
const status = getRefreshStatus(anime);
// Returns: 'never' | 'ready' | '12h' | '6h' etc.
```

### Notification System

```javascript
// Initialize on app startup (app.js does this)
initNotificationSystem();

// Add a notification
addNotification(
  type,        // 'new_episode', 'status_changed', 'started_airing', etc.
  title,       // "New episodes: Attack on Titan"
  anime,       // { root_mal_id, title_english, poster_url, ... }
  details      // "120 → 139 episodes" (optional)
);

// Dismiss specific notification
dismissNotification(notifId);

// Clear all notifications
clearAllNotifications();

// Get active notifications
const notifs = getNotifications();
// Returns: [{ id, type, title, anime, details, createdAt, read, dismissed }, ...]

// Get unread count
const count = getUnreadCount();

// Mark as read
markNotificationRead(notifId);

// Clean up old seen notifications (auto-runs, but can be manual)
cleanupOldNotifications();
```

### Refresh Utilities (UI Helpers)

```javascript
// Get human-readable refresh status
const text = getRefreshStatusText(anime);
// Returns: "Just refreshed" | "Ready to refresh" | "Refreshes in 12h" | "Never refreshed"

// Get last refresh time as string
const when = getLastRefreshTime(anime);
// Returns: "Just now" | "5 minutes ago" | "2 hours ago" | "1 day ago" | "Never"

// Check if anime is due for refresh NOW
const isDue = isDueForRefresh(anime);
// Returns: boolean

// Check if anime hasn't been refreshed recently
const stale = isStale(anime, 2); // Check 2-day threshold
// Returns: boolean

// Count how many anime are stale
const count = getStaleCount(1); // 1-day threshold
// Returns: number

// Manually trigger refresh for one anime
const result = await manualRefreshAnime(rootMalId);
// Returns: { success: true } | { success: false, error: "..." }

// Refresh all stale anime (max 5)
const result = await refreshAllStale();
// Returns: { count: 3 } (number refreshed)
```

## Common Patterns

### Display Refresh Status in UI

```javascript
import { getRefreshStatusText, getLastRefreshTime } from '../services/refreshUtils.js';

// In a component:
const anime = getState('library').find(a => a.root_mal_id === id);

const statusText = getRefreshStatusText(anime);
// "Just refreshed" | "Refreshes in 12h" etc.

const lastTime = getLastRefreshTime(anime);
// "5 minutes ago" | "2 hours ago" etc.

// Render in HTML:
document.innerHTML = `
  <div class="refresh-info">
    <span>${statusText}</span>
    <small>${lastTime}</small>
  </div>
`;
```

### Trigger Manual Refresh from Button

```javascript
import { manualRefreshAnime } from '../services/refreshUtils.js';
import { showToast } from '../utils.js';

document.getElementById('refresh-btn').addEventListener('click', async () => {
  showToast('Refreshing...', 'info');
  const result = await manualRefreshAnime(rootMalId);
  
  if (result.success) {
    showToast('✨ Refreshed!', 'success');
  } else {
    showToast('⚠️ ' + result.error, 'error');
  }
});
```

### Subscribe to Notifications

```javascript
import { getState, subscribe } from '../state.js';

// Watch for new notifications
subscribe('notifications', (notifs) => {
  console.log('Notifications changed:', notifs);
  
  notifs.forEach(notif => {
    if (!notif.read && !notif.dismissed) {
      console.log(`Unread: ${notif.title}`);
    }
  });
});

// Check current notifications
const notifs = getState('notifications');
const unread = notifs.filter(n => !n.read);
console.log(`You have ${unread.length} unread notifications`);
```

### Create Custom Notification

```javascript
import { addNotification } from '../services/notificationSystem.js';
import { getState } from '../state.js';

// From anywhere in your code:
const anime = getState('library').find(a => a.root_mal_id === 1);

addNotification(
  'new_episode',
  `New episodes: ${anime.title_english}`,
  anime,
  '120 → 139 episodes'
);
```

### Check if Refresh Service is Running

```javascript
import { getState } from '../state.js';

const settings = getState('settings');
if (settings.refresh_service_enabled) {
  console.log('✓ Refresh service is enabled');
} else {
  console.log('✗ Refresh service is disabled');
}
```

### Export Notification History

```javascript
const notifs = getState('notifications');
const json = JSON.stringify(notifs, null, 2);
// Use for debugging or user export
```

## Data Structures

### Anime Object (Minimal Relevant Fields)

```javascript
{
  root_mal_id: 1,
  title_english: "Attack on Titan",
  title_japanese: "進撃の巨人",
  poster_url: "https://...",
  last_jikan_update: "2024-04-21T14:30:00Z",
  seasons: {
    "1": {
      mal_id: 1,
      total_episodes: 25,
      progress: 12,
      status: "Currently Airing",
      // ... other fields
    },
    // ... more seasons
  }
}
```

### Notification Object

```javascript
{
  id: "notif_1713698400000_abc123",
  type: "new_episode",
  title: "New episodes: Attack on Titan",
  anime: {
    root_mal_id: 1,
    title_english: "Attack on Titan",
    poster_url: "https://..."
  },
  details: "120 → 139 episodes",
  createdAt: 1713698400000,  // timestamp
  read: false,
  dismissed: false
}
```

### Change Object (Internal)

```javascript
{
  type: "episode_increase" | "status_changed" | "started_airing",
  field: "total_episodes" | "status" | "airing",
  oldValue: 120,
  newValue: 139
}
```

## Settings

```javascript
// In app.js DEFAULT_SETTINGS:
{
  refresh_service_enabled: true,    // Enable/disable auto-refresh
  refresh_interval_hours: 24,       // How often to check (not configurable yet)
  refresh_on_app_start: true,       // Run check on app boot
  notifications_enabled: true,      // Enable/disable notifications
}
```

## Console Debug Output

```javascript
// All refresh/notification activity is logged to console with emoji prefixes:

🔄 Refresh service starting...
📬 Loaded 42 seen notifications
✨ Refreshed 3 anime from Jikan
📝 Updated Attack on Titan: episode_increase, status_changed
🔔 Notification: new_episode - New episodes: Attack on Titan
📺 One Piece: Using AniList episode count (1115)
🧹 Cleaned up old notifications
⚠️ Jikan sync failed: Network error
❌ CRITICAL: Library is empty after load
```

## Error Handling

```javascript
// Always wrap refresh calls in try/catch
try {
  await refreshAnimeNow(rootMalId);
} catch (err) {
  console.error('Refresh failed:', err);
  showToast('Refresh failed: ' + err.message, 'error');
}

// Notifications don't throw, they return silently
// Check localStorage for issue details:
const seen = localStorage.getItem('mugellist_notifications_v1');
console.log('Seen notifications:', JSON.parse(seen));
```

## Performance Tips

1. **Don't refresh too often** - 24-hour window prevents API spam
2. **Use `isDueForRefresh()`** - Check before showing UI
3. **Subscribe once** - Use `subscribeMany()` for multiple keys
4. **Batch operations** - `refreshAllStale()` is rate-limited

## Testing Helpers

```javascript
// In console, manually test refresh system:

// Force run a refresh cycle
import { refreshAnimeNow } from './services/refreshService.js';
await refreshAnimeNow(1); // Refresh anime with MAL ID 1

// View all active notifications
window.__mugelState.getState('notifications')

// Clear all notifications
import { clearAllNotifications } from './services/notificationSystem.js';
clearAllNotifications();

// Check if anime is stale
import { isStale } from './services/refreshUtils.js';
const lib = window.__mugelState.getState('library');
console.log(lib.filter(a => isStale(a, 1))); // Stale >1 day

// Manually add a test notification
import { addNotification } from './services/notificationSystem.js';
addNotification('new_episode', 'TEST', lib[0], 'Test details');
```

---

For complete documentation, see [REFRESH_SYSTEM.md](./REFRESH_SYSTEM.md)
