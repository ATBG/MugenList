# Anime Card Live Update & Countdown System Overhaul

## Overview
Complete overhaul of the MugelList Anime Card live update and synchronization system for maximum accuracy, stability, performance, and platform-aware user experience.

## Files Created

### 1. `js/services/animeCardLiveUpdate.js`
**Smart diff-based reconciliation pipeline**

#### Features:
- **Field-level diffing**: Compares old vs new values per field with validation
- **Source prioritization**: AniList (3) > MAL (2) > Jikan (1) > Internal (0)
- **Downgrade protection**: Never overwrites valid data with weaker sources
- **Protected fields**: User progress, watched episodes, ratings never auto-updated

#### Key Functions:
- `calculateSeasonDiff()` - Fine-grained season comparison
- `calculateAnimeDiff()` - Complete anime entry diff
- `reconcileUpdate()` - Main reconciliation engine
- `applyCardPatch()` - Targeted DOM patching
- `detectEpisodeRelease()` - Episode airing detection
- `processLiveUpdate()` - Main entry point
- `processBatchUpdates()` - Efficient batch processing

#### Debug Logging:
All updates logged with `[AnimeCard Update]` prefix showing:
- Source of update
- Changed fields (old → new)
- Reconciliation conflicts
- Update result (applied/rejected)

### 2. `js/services/countdownManager.js`
**Platform-aware countdown display system**

#### Features:
- **Desktop (hover-based)**: Countdown hidden by default, revealed on hover
- **Mobile (persistent)**: Countdown always visible on airing titles
- **IntersectionObserver**: Only active countdowns on visible cards (performance)
- **Tabular numbers**: `font-feature-settings: "tnum"` prevents layout shifts
- **Live calculation**: Always computed from `Date.now()` vs `nextEpisodeAiringAt`

#### Key Functions:
- `initCountdownManager()` - Initialize with device detection
- `attachCountdown()` - Create countdown for card
- `updateCountdown()` - Update target timestamp
- `detachCountdown()` - Cleanup countdown
- `detectTouchDevice()` - Platform detection

#### Device Detection:
```javascript
isTouchDevice = 'ontouchstart' in window || 
                navigator.maxTouchPoints > 0 ||
                window.matchMedia('(pointer: coarse)').matches
```

## Files Modified

### 3. `js/ui/animeCard.js`
**Integration with new systems**

#### Changes:
- Import countdownManager functions
- Replace inline countdown HTML with countdown container
- Replace manual countdown logic with `attachCountdown()` calls
- Update `updateCardFromAnime()` to use countdownManager

#### New Countdown Integration:
```javascript
if (isAiringAndWaiting && nextAiringAt) {
  attachCountdown(card, Number(nextAiringAt), {
    rootId: anime.root_mal_id,
    seasonId: String(seasonId),
  });
}
```

### 4. `css/components.css`
**Platform-aware countdown styles**

#### New CSS Classes:
- `.card__countdown-container` - Positioning wrapper
- `.card__countdown` - Base countdown overlay
- `.countdown--visible` - Visible state
- `.countdown--hover` - Desktop hover state
- `.countdown--mobile` - Mobile persistent state
- `.countdown--aired` - Episode aired state (green pulse)
- `.countdown--tabular` - Tabular number formatting

#### Media Queries:
```css
/* Mobile: always visible */
@media (hover: none) and (pointer: coarse) {
  .card__countdown { opacity: 1; }
}

/* Desktop: hover-activated */
@media (hover: hover) and (pointer: fine) {
  .anime-card:hover .card__countdown { opacity: 1; }
}
```

#### Accessibility Support:
- `prefers-reduced-motion` - Reduced animation
- `prefers-contrast: high` - High contrast mode

### 5. `js/app.js`
**Initialization integration**

#### Changes:
- Import `initCountdownManager`
- Initialize after other services

### 6. `js/services/episodeSyncService.js`
**Live update integration**

#### Changes:
- Import `processLiveUpdate`
- Trigger card updates after library sync
- Cards refresh instantly when episode data changes

## Technical Implementation Details

### 1. Diff-Based Reconciliation

```javascript
// Compare fields with validation
const changes = calculateSeasonDiff(oldSeason, newSeason, 'anilist');

// Apply only valid changes
if (changes.shouldUpdate) {
  await applyCardPatch(patch, rootMalId);
  updateCardFromAnime(updatedAnime); // DOM refresh
}
```

### 2. Countdown Update Flow

```
Card Created
    ↓
attachCountdown() → Create instance
    ↓
IntersectionObserver → Track visibility
    ↓
if visible + (hovering | mobile):
    start 1s interval
    update display
    ↓
Episode airs:
    Show "AIRING NOW"
    Green pulse animation
    Dispatch episodeAired event
    Remove countdown after 30s
```

### 3. Data Integrity Guards

| Field | Protection |
|-------|------------|
| total_episodes | Never downgrade |
| next_episode_number | Never decrease |
| next_episode_airing_at | Validate timestamp range |
| progress | Protected - never auto-update |
| user_status | Protected - manual only |

### 4. Source Confidence Levels

| Source | Confidence | Use Case |
|--------|------------|----------|
| AniList | 3 | Real-time airing data |
| MAL | 2 | Official metadata |
| Jikan | 1 | Cached backup |
| Internal | 0 | Local state |

## Platform Behavior

### Desktop (Mouse/Keyboard)
- Countdown hidden by default
- Appears on card hover
- Smooth fade + scale transition
- Updates stop when hover ends
- Ready to appear instantly on next hover

### Mobile (Touch)
- Countdown always visible on airing cards
- Prominent overlay display
- Does not block tap interactions
- Updates run continuously when visible
- Smaller font size for compact cards

## Performance Optimizations

1. **IntersectionObserver**: Countdown timers only run for visible cards
2. **Targeted DOM patching**: Single card updates without grid re-render
3. **Batch updates**: Multiple anime processed efficiently
4. **Memoization**: Expensive calculations cached
5. **Tabular numbers**: Prevent layout shift during countdown
6. **Debounced notifications**: Single notification per batch

## Debug Console Output

```
[AnimeCard Update] 2025-01-08T12:00:00.000Z
  Source: anilist
  Anime: 5114
  Changes: { total_episodes: { old: 24, new: 25, source: 'anilist' } }
  Result: applied (2.34ms, fieldsChanged: 1)

[CountdownManager] Attach: Countdown attached for 5114
  targetTime: 2025-01-08T15:30:00.000Z
  device: desktop

[CountdownManager] Activate: Countdown active for 5114
```

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| Cards update correctly from any source | ✅ Implemented |
| Countdown precise to second, jitter-free | ✅ Tabular numbers + 1s interval |
| Desktop: Countdown on hover | ✅ CSS + JS hover detection |
| Mobile: Countdown always visible | ✅ `pointer: coarse` media query |
| No stale data or duplicate updates | ✅ Diff-based reconciliation |
| User progress protected | ✅ PROTECTED_FIELDS set |
| Smooth, stable UI | ✅ Targeted DOM patching |
| Comprehensive debugging | ✅ Console logs with prefixes |

## Usage Example

```javascript
// Process single update
import { processLiveUpdate } from './services/animeCardLiveUpdate.js';

const result = await processLiveUpdate(currentAnime, newData, 'anilist');
// { updated: true, patch: {...}, episodeReleased: false }

// Access countdown info
import { getCountdownInfo, getDeviceType } from './services/countdownManager.js';

console.log(getDeviceType()); // 'desktop' | 'mobile'
console.log(getCountdownInfo(5114)); // Countdown state
```

## Migration Notes

- Old countdown HTML structure replaced with new container
- Old hover logic removed in favor of countdownManager
- No breaking changes to existing anime data structure
- User progress and manual overrides fully preserved
- Existing library grid/list views work unchanged
