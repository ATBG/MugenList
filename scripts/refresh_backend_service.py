"""
refresh_backend_service.py — Backend-driven refresh system for MugelList.

Owns:
  1. Single anime refresh (manual "Refresh Now").
  2. Batch refresh (manual "Sync Library").
  3. Auto-refresh logic (24-hour stale threshold).

All three paths use the same gold-standard 3-API reconciliation.
User progress is NEVER overwritten — only metadata fields are updated.
"""
from __future__ import annotations

import logging
import time
import threading
import concurrent.futures
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, Tuple

from metadata_engine import engine
from metadata_service import metadata_svc

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────
#  Configuration
# ──────────────────────────────────────────────────────────────────
STALE_THRESHOLD_HOURS = 24
BATCH_CONCURRENCY     = 4
MAX_AUTO_PER_CYCLE    = 5

# Fields that belong to the user — never overwritten by refresh
_USER_FIELDS = frozenset({
    'progress', 'watch_status', 'watch_state',
    'started_watching_date', 'last_progress_update',
    'last_watched_at', 'user_poster', '_status_overridden',
    'has_user_watched_previous', 'last_notified_episode',
})

_pool = concurrent.futures.ThreadPoolExecutor(max_workers=BATCH_CONCURRENCY + 2)


# ──────────────────────────────────────────────────────────────────
#  1.  Single anime refresh
# ──────────────────────────────────────────────────────────────────

def refresh_single(
    mal_id: int,
    old_season: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Refresh metadata for one anime via 3-API gold record.

    Returns {
      "mal_id": ...,
      "gold": { ...full gold record... },
      "season_patch": { ...fields to merge into the season... },
      "changes": [ { "type": ..., "field": ..., "old": ..., "new": ... }, ... ],
      "refreshed_at": "...",
    }

    The frontend merges `season_patch` into its season object, preserving
    user fields.
    """
    mal_id = int(mal_id)
    logger.info('Refreshing single anime: %d', mal_id)

    try:
        gold = engine.get_gold_record(mal_id)
    except Exception as e:
        logger.error('Gold record fetch failed for %d: %s', mal_id, e)
        return {
            'mal_id': mal_id,
            'error': str(e),
            'refreshed_at': _now_iso(),
        }

    patch = _gold_to_season_patch(gold, mal_id)
    changes = _detect_changes(old_season or {}, patch) if old_season else []

    return {
        'mal_id':       mal_id,
        'gold':         gold,
        'season_patch': patch,
        'changes':      changes,
        'refreshed_at': _now_iso(),
    }


# ──────────────────────────────────────────────────────────────────
#  2.  Batch refresh  (manual "Sync Library")
# ──────────────────────────────────────────────────────────────────

def refresh_batch(
    entries: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Refresh many anime concurrently.

    `entries` is a list of { "mal_id": int, "old_season": {...} | null }.

    Returns {
      "requested": N,
      "completed": M,
      "results":   { "<mal_id>": { ...refresh_single result... }, ... },
      "errors":    { "<mal_id>": "error message", ... },
    }
    """
    results: Dict[str, Any] = {}
    errors: Dict[str, str] = {}

    def _work(entry: Dict[str, Any]):
        mid = int(entry.get('mal_id', 0))
        if not mid:
            return mid, None, 'missing mal_id'
        try:
            res = refresh_single(mid, entry.get('old_season'))
            return mid, res, None
        except Exception as exc:
            return mid, None, str(exc)

    futures = {_pool.submit(_work, e): e for e in entries}
    for fut in concurrent.futures.as_completed(futures):
        mid, res, err = fut.result()
        if res:
            results[str(mid)] = res
        if err:
            errors[str(mid)] = err

    return {
        'requested': len(entries),
        'completed': len(results),
        'results':   results,
        'errors':    errors,
    }


# ──────────────────────────────────────────────────────────────────
#  3.  Auto-refresh  (24-hour stale detection)
# ──────────────────────────────────────────────────────────────────

def auto_refresh(
    library_snapshot: List[Dict[str, Any]],
    threshold_hours: float = STALE_THRESHOLD_HOURS,
    max_items: int = MAX_AUTO_PER_CYCLE,
) -> Dict[str, Any]:
    """
    Identify stale entries from `library_snapshot` and refresh them.

    Each item in `library_snapshot` should have at minimum:
      { "mal_id": int, "last_jikan_update": str|null, "old_season": {...}|null }

    Returns the same shape as refresh_batch, plus `stale_count`.
    """
    now = time.time()
    threshold_sec = threshold_hours * 3600

    stale: List[Dict[str, Any]] = []

    for item in library_snapshot:
        last_update = item.get('last_jikan_update')
        if last_update:
            try:
                ts = datetime.fromisoformat(last_update.replace('Z', '+00:00')).timestamp()
            except Exception:
                ts = 0
        else:
            ts = 0

        if (now - ts) > threshold_sec:
            stale.append(item)

    # Sort oldest-first, cap
    stale.sort(key=lambda x: x.get('last_jikan_update') or '')
    candidates = stale[:max_items]

    if not candidates:
        return {
            'stale_count': 0,
            'requested':   0,
            'completed':   0,
            'results':     {},
            'errors':      {},
        }

    result = refresh_batch(candidates)
    result['stale_count'] = len(stale)
    return result


# ──────────────────────────────────────────────────────────────────
#  Background auto-refresh scheduler (optional thread)
# ──────────────────────────────────────────────────────────────────

_auto_timer: Optional[threading.Timer] = None
_auto_running = False
_auto_callback = None  # callable(result) — set by backend.py if needed

def start_auto_refresh(interval_seconds: float = 3600):
    """Start a background thread that calls auto_refresh periodically."""
    global _auto_running
    _auto_running = True
    _schedule_next(interval_seconds)
    logger.info('Auto-refresh scheduler started (interval=%ds)', interval_seconds)


def stop_auto_refresh():
    """Stop the background auto-refresh."""
    global _auto_running, _auto_timer
    _auto_running = False
    if _auto_timer:
        _auto_timer.cancel()
        _auto_timer = None
    logger.info('Auto-refresh scheduler stopped')


def _schedule_next(interval: float):
    global _auto_timer
    if not _auto_running:
        return
    _auto_timer = threading.Timer(interval, _auto_tick, args=(interval,))
    _auto_timer.daemon = True
    _auto_timer.start()


def _auto_tick(interval: float):
    """Executed by the background timer."""
    if not _auto_running:
        return
    logger.info('Auto-refresh tick')
    # The actual refresh requires a library snapshot. The backend endpoint
    # receives this from the frontend on each call.  The background timer
    # is a fallback that fires with an empty snapshot (no-op unless callback
    # is set).
    if _auto_callback:
        try:
            _auto_callback()
        except Exception as e:
            logger.error('Auto-refresh callback error: %s', e)
    _schedule_next(interval)


# ──────────────────────────────────────────────────────────────────
#  Internal helpers
# ──────────────────────────────────────────────────────────────────

def _gold_to_season_patch(gold: Dict[str, Any], mal_id: int) -> Dict[str, Any]:
    """
    Convert a gold record to a season-level patch dict.
    Only metadata fields — user fields are excluded.
    """
    status = gold.get('status', 'Unknown')
    is_airing = status == 'Currently Airing'
    next_airing = gold.get('next_airing')

    return {
        'mal_id':              mal_id,
        'title_english':       gold.get('title', 'Unknown'),
        'title_japanese':      _first_synonym(gold),
        'total_episodes':      gold.get('total_episodes', 0),
        'aired_episodes':      gold.get('aired_episodes', 0),
        'episodes':            gold.get('total_episodes', 0),
        'status':              status,
        'airing':              is_airing,
        'is_airing':           is_airing,
        'score':               gold.get('score', 0),
        'genres':              gold.get('genres', []) if isinstance(gold.get('genres'), list) else [],
        'synopsis':            gold.get('synopsis', ''),
        'poster_url':          gold.get('poster', ''),
        'banner_url':          gold.get('banner_url', ''),
        'studios':             gold.get('studios', []),
        'producers':           gold.get('producers', []),
        'source_material':     gold.get('source_material', ''),
        'age_rating':          gold.get('age_rating', ''),
        'duration':            gold.get('duration_per_episode'),
        'popularity':          gold.get('popularity'),
        'rank':                gold.get('rank'),
        'season_label':        gold.get('season', ''),
        'season_year':         gold.get('year'),
        'source_ids': {
            'mal_id':     mal_id,
            'anilist_id': gold.get('anilist_id'),
            'simkl_id':   gold.get('simkl_id'),
        },
        'provenance':          gold.get('provenance', {}),
        'source_confidence':   gold.get('source_confidence', 0),
        'next_episode_airing_at': next_airing.get('time') if next_airing else None,
        'next_episode_number':    next_airing.get('episode') if next_airing else None,
        'updated_date':        _now_iso(),
        'sync_status':         'synced',
    }


def _detect_changes(
    old: Dict[str, Any],
    new: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Compare old season data with new patch and return list of changes."""
    changes = []

    # Episode count increase
    old_total = old.get('total_episodes', 0) or 0
    new_total = new.get('total_episodes', 0) or 0
    if new_total > old_total and old_total > 0:
        changes.append({
            'type': 'episode_increase',
            'field': 'total_episodes',
            'old': old_total,
            'new': new_total,
        })

    # Aired episodes increase (new episode dropped)
    old_aired = old.get('aired_episodes', 0) or 0
    new_aired = new.get('aired_episodes', 0) or 0
    if new_aired > old_aired and old_aired > 0:
        changes.append({
            'type': 'new_episode_aired',
            'field': 'aired_episodes',
            'old': old_aired,
            'new': new_aired,
        })

    # Status changed
    old_status = old.get('status', '')
    new_status = new.get('status', '')
    if old_status and new_status and old_status != new_status:
        changes.append({
            'type': 'status_changed',
            'field': 'status',
            'old': old_status,
            'new': new_status,
        })

    # Started airing
    old_airing = old.get('airing', False)
    new_airing = new.get('airing', False)
    if not old_airing and new_airing:
        changes.append({
            'type': 'started_airing',
            'field': 'airing',
            'old': False,
            'new': True,
        })

    # Score changed significantly (> 0.5)
    old_score = old.get('score', 0) or 0
    new_score = new.get('score', 0) or 0
    if abs(new_score - old_score) >= 0.5 and old_score > 0:
        changes.append({
            'type': 'score_changed',
            'field': 'score',
            'old': old_score,
            'new': new_score,
        })

    return changes


def _first_synonym(gold: Dict[str, Any]) -> str:
    """Get the first non-primary synonym (often the Japanese title)."""
    title = gold.get('title', '')
    for s in gold.get('synonyms', []):
        if s and s != title:
            return s
    return title


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
