# Quick Start: Testing Auto-Refresh & Notifications

## 1. Verify Installation ✅

Start the app normally. In the browser console, you should see:
```
🔄 Refresh service starting...
📬 Loaded X seen notifications
```

## 2. Check Settings

Go to **Settings** → **🔄 Auto-Refresh** section
- ✅ "Background Refresh" toggle should be **On** (default)
- ✅ "Notifications" toggle should be **On** (default)
- ✅ "Refresh Now" button should be visible

## 3. Manual Refresh (Fastest Test)

1. Go to **Settings** → **🔄 Auto-Refresh**
2. Click **"Refresh Now"** button
3. Wait 2-5 seconds
4. Look for notification toast at bottom-right

Expected toast:
```
🎬 New episodes: [Anime Name]
120 → 139 episodes
```

## 4. Automatic Refresh (Patient Test)

1. Leave the app open
2. Wait 60+ minutes
3. Console will show:
```
✨ Refreshed 3 anime from Jikan
```
4. Check for notifications
5. Check Library to see updated episode counts

## 5. One Piece Verification

1. Open Developer Tools (F12)
2. Go to **Console** tab
3. Filter by "One Piece"
4. If working:
```
📺 One Piece: Using AniList episode count (1115)
```

Or add One Piece to library and trigger refresh:
- Settings → "Refresh Now"
- Check that One Piece has correct episode count (not 0)

## 6. Notification Deduplication Test

1. Trigger refresh manually: Settings → "Refresh Now"
2. Note the anime that got notifications
3. Try to refresh again immediately
4. **Expected**: No duplicate notifications
5. **Verification**: Wait 24 hours, refresh again → notification shows up

## 7. LocalStorage Verification

Open DevTools → Application → Local Storage:

**Check for:**
- `mugellist_settings_v2` - Contains `refresh_service_enabled`
- `mugellist_notifications_v1` - Tracks seen notifications

```javascript
// In console, check notification cache:
localStorage.getItem('mugellist_notifications_v1')
// Should show seen notification IDs with timestamps
```

## 8. State Subscription Test

In browser console:
```javascript
// Check active notifications
__mugelState.getState('notifications')
// Should show array of notification objects

// Subscribe to changes
__mugelState.subscribe('notifications', (notifs) => {
  console.log('Notifications changed:', notifs);
});
```

## 9. CSS Test

Open DevTools → Elements:
1. Find element with class `notification-toasts`
2. Check that notifications are rendered there
3. Verify CSS classes like:
   - `notification-toast-new_episode`
   - `notification-icon`
   - `notification-dismiss-btn`

## 10. Browser Console Logs

Filter console for debug output:
```
🔄 Refresh service starting...
📂 getAllAnime() returned X items
✨ Refreshed X anime from Jikan
📝 Updated [Anime]: episode_increase, status_changed
🔔 Notification: new_episode - New episodes: [Anime]
🧹 Cleaned up old notifications
```

## Troubleshooting

### No Refresh Service Starting

**Check:**
```javascript
// In console
__mugelState.getState('settings').refresh_service_enabled
// Should be `true`
```

**Fix:** Go to Settings and toggle "Background Refresh" On

### Notifications Not Showing

**Check:**
```javascript
__mugelState.getState('settings').notifications_enabled
// Should be `true`
```

**Verify:**
```javascript
// Check notification system initialized
localStorage.getItem('mugellist_notifications_v1')
// Should exist
```

### One Piece Still Shows 0 Episodes

1. Add One Piece to library
2. Settings → "Refresh Now"
3. Check console for AniList fetch logs
4. Verify internet connection to graphql.anilist.co

### Notifications Appearing But Auto-Dismiss Broken

1. Open DevTools → Elements
2. Find `.notification-toast` element
3. Check CSS animations are loading
4. Verify `notifications.css?v=1` in HTML head

## Performance Check

In console:
```javascript
// Check refresh service interval
setInterval(() => {
  console.log('Refresh cycle would run...');
}, 60 * 60 * 1000); // Logs every hour
```

## Expected Behavior Timeline

| Time | Action | Result |
|------|--------|--------|
| T+0 | App loads | Refresh service starts |
| T+10s | Initial check | Scans for stale anime |
| T+60m | Periodic check | Refreshes 3 stale anime |
| T+60m + 500ms | API returns | Changes detected (if any) |
| T+60m + 550ms | State updates | Notifications emitted |
| T+60m + 555ms | Toast renders | User sees notification |
| T+65m | Auto-dismiss | Notification fades away |

## Next Steps

1. ✅ Verify notifications appear
2. ✅ Check One Piece episode count is correct
3. ✅ Toggle settings on/off and observe behavior
4. ✅ Leave app open for 60+ minutes to test auto-refresh
5. ✅ Check localStorage for persistent notification data
6. ✅ Read [REFRESH_SYSTEM.md](./REFRESH_SYSTEM.md) for detailed docs

## Questions or Issues?

Check the console logs:
- `🔄` = Refresh service messages
- `📬` = Notification system messages
- `🎬` = Anime-specific updates
- `📺` = One Piece special handling
- `⚠️` = Warnings/issues

All logs are prefixed with emoji for easy filtering.

---

**Happy refreshing!** 🎉
