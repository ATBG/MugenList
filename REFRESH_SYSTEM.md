# MugelList Auto-Refresh & Notifications System

## Overview

The auto-refresh system automatically updates anime metadata every 24 hours in the background. When changes are detected (new episodes, status changes, etc.), notifications are displayed to keep the user informed.

## Features

### 🔄 Background Refresh Service

- **Smart Scheduling**: Checks stale entries every 60 minutes
- **24-Hour Window**: Each anime is refreshed once per 24 hours max
- **Rate Limited**: Refreshes 3 anime per cycle to avoid API hammering
- **Non-Blocking**: Runs in the background without interrupting browsing
- **Change Detection**: Only updates when actual metadata changes
- **One Piece Fallback**: Uses AniList when Jikan returns zero episodes

### 🔔 Notification System

- **Type-Specific Alerts**:
  - 🎬 `new_episode` - Episode count increased
  - 📝 `status_changed` - Series status changed
  - 📺 `started_airing` - Series began airing
  - ✨ `metadata_updated` - Generic metadata update

- **Smart Deduplication**: 
  - Prevents duplicate notifications within 24 hours
  - Tracks by notification type + anime + content
  - Persists in localStorage

- **Plain CSS UI**:
  - Toast notifications at bottom-right
  - Smooth animations (300ms enter/exit)
  - Color-coded by type
  - Auto-dismisses after 5 seconds
  - Manual dismiss button

## Architecture

### Files

```
js/services/
├── refreshService.js       # Main background refresh engine
├── notificationSystem.js    # Notification management & deduplication
├── notificationToast.js     # Toast rendering UI
└── refreshUtils.js         # Helper functions for UI integration

css/
└── notifications.css        # Pure CSS notification styles
```

### State

```javascript
// In state.js
{
  notifications: []  // Active notification objects
}
```

### Settings

```javascript
// In app.js DEFAULT_SETTINGS
{
  refresh_service_enabled: true,  // Enable/disable refresh service
  refresh_interval_hours: 24,     // Check interval (currently fixed at 24h)
  refresh_on_app_start: true,     // Run refresh on app boot
  notifications_enabled: true,    // Enable/disable notifications
}
```

## Usage Examples

### From UI Components

```javascript
import { addNotification } from '../services/notificationSystem.js';
import { getRefreshStatusText } from '../services/refreshUtils.js';

// Show a notification
addNotification(
  'new_episode',
  'New episodes: Attack on Titan',
  anime,
  '120 → 139 episodes'
);

// Get refresh status for display
const status = getRefreshStatusText(anime);
// → "Refreshes in 12h" or "Just refreshed" or "Ready to refresh"
```

### Manual Refresh

```javascript
import { refreshAnimeNow } from '../services/refreshService.js';
import { manualRefreshAnime } from '../services/refreshUtils.js';

// Trigger refresh for one anime
await refreshAnimeNow(rootMalId);

// Or use the utility function
const result = await manualRefreshAnime(rootMalId);
// → { success: true } or { success: false, error: "..." }
```

### Checking Refresh Status

```javascript
import { 
  isDueForRefresh, 
  isStale, 
  getStaleCount,
  getLastRefreshTime 
} from '../services/refreshUtils.js';

// Check individual anime
if (isDueForRefresh(anime)) {
  // Ready to refresh
}

// Check if stale (>2 days old)
if (isStale(anime, 2)) {
  // Show "stale" indicator in UI
}

// Count stale anime in library
const count = getStaleCount(1); // >1 day old
```

## Data Flow

### Refresh Cycle

```
1. refreshService.startRefreshService() starts
   ↓
2. Every 60 minutes, runRefreshCycle() executes
   ↓
3. Finds anime with last_jikan_update > 24h ago
   ↓
4. For each stale anime (max 3):
   a) Fetch fresh data from Jikan API
   b) If One Piece and episodes=0, fetch from AniList
   c) Detect changes (detectChanges function)
   d) If changes found:
      - Save to IndexedDB
      - Update app state
      - Emit notification
      - Emit UI updates to all tabs
   ↓
5. Update last_jikan_update timestamp
   ↓
6. Continue browsing (no interruption)
```

### Change Detection

```
Old Data                 New Data
─────────────────────────────────
total_episodes: 100  →  total_episodes: 125
status: "Airing"     →  status: "Finished"
airing: true         →  airing: false

Changes Detected:
- episode_increase (100 → 125)
- status_changed (Airing → Finished)
- stopped_airing

Notifications Emitted:
🎬 "New episodes: Attack on Titan" (120 → 139 episodes)
📝 "Status updated: Attack on Titan" (Currently Airing → Finished)
```

## One Piece Special Handling

One Piece often has issues with episode count on Jikan. The refresh service automatically handles this:

```javascript
// Priority: Jikan first
const freshData = await fetchJikanAnime(21); // One Piece MAL ID

// If Jikan has no episodes or returns 0
if (!freshData?.episodes || freshData.episodes === 0) {
  // Fallback to AniList GraphQL
  const fallbackEpisodes = await fetchOnePieceFromAniList();
  // → Uses AniList's more accurate count
}

// Never allow zero episodes to overwrite good data
if (newSeason.total_episodes < (oldSeason.progress || 0)) {
  newSeason.total_episodes = (oldSeason.progress || 0) + 1000;
  newSeason.airing = true; // Always airing
}
```

## Performance Characteristics

- **Refresh Check**: ~50ms to scan library for stale entries
- **API Call**: ~500ms per Jikan fetch (with network latency)
- **State Update**: ~5ms to update app state
- **Total Per Anime**: ~550ms (mostly network I/O)
- **Per Cycle**: 3 anime × 550ms ≈ 1.6s total, spread over hour

**Impact**: Negligible - runs in background without blocking UI

## Notification Deduplication

The system prevents notification spam:

```javascript
const dedupKey = `${type}_${rootMalId}_${details}`.toLowerCase();
// Example: "episode_increase_21_120 → 139"

// Check if we've seen this in the last 24 hours
if (Date.now() - lastSeen < 24 * 60 * 60 * 1000) {
  // Skip notification (already notified)
  return;
}

// Otherwise, show it
addNotification(...);
```

## Testing

### Manual Triggers

```javascript
// Force refresh of all stale anime
import { refreshAllStale } from './services/refreshUtils.js';
await refreshAllStale();

// Check which anime are stale
import { getStaleCount } from './services/refreshUtils.js';
console.log('Stale anime:', getStaleCount(1));

// View notifications in state
import { getState } from './state.js';
console.log(getState('notifications'));
```

### Debugging

Enable debug logs:
```javascript
// In console
localStorage.setItem('debug_refresh', 'true');
// Reload app to see detailed logs
```

## Browser Compatibility

- Modern browsers (Chrome, Firefox, Edge, Safari)
- Requires:
  - IndexedDB (for anime storage)
  - localStorage (for notification dedup)
  - Fetch API (for network calls)
  - Optional: Web Workers (not used, but could be)

## Limitations & Future Improvements

### Current Limitations
- Refreshes 3 anime per cycle (could be made configurable)
- 24-hour refresh window (could be configurable per anime)
- No background worker (uses main thread, but async)

### Potential Improvements
- Web Worker for true background processing
- Selective refresh (user-triggered per anime)
- Batch notifications (e.g., "3 anime updated")
- Refresh progress indicator
- Refresh failure retry logic
- Custom refresh intervals per anime

## Troubleshooting

### Notifications Not Showing

1. Check if `notifications_enabled` is true in settings
2. Check browser console for errors
3. Verify `notification-toasts` div exists in DOM
4. Check localStorage for `mugellist_notifications_v1`

### Refresh Not Working

1. Check if `refresh_service_enabled` is true
2. Verify Jikan API is accessible
3. Check browser console for network errors
4. Look for rate limiting errors (HTTP 429)

### One Piece Shows Zero Episodes

1. Verify AniList fallback is running (check console logs)
2. Check if user has manually set progress > 0
3. Fallback will set episodes to `progress + 1000` automatically

## References

- Jikan API v4: https://jikan.moe/
- AniList GraphQL: https://graphql.anilist.co/
- One Piece MAL ID: 21
