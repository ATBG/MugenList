"""
add_anime_service.py — Backend service for the Add Anime flow.

Owns:
  1. Title search via Jikan (primary) with AniList enrichment.
  2. Franchise/relation discovery.
  3. Full metadata assembly for every selected entry.

The frontend only displays results and collects user choices.
"""
from __future__ import annotations

import logging
import time
import re
import concurrent.futures
from typing import List, Dict, Any, Optional

from metadata_service import metadata_svc
from metadata_engine import engine
from resolver_service import build_relation_cluster

logger = logging.getLogger(__name__)

# Thread-pool for concurrent metadata fetches
_pool = concurrent.futures.ThreadPoolExecutor(max_workers=6)

# ──────────────────────────────────────────────────────────────────
#  Title normalisation helpers
# ──────────────────────────────────────────────────────────────────

_STRIP_RE = re.compile(r'[^a-z0-9 ]')

def _normalise_title(title: str) -> str:
    """Lower-case, strip non-alphanum, collapse whitespace."""
    return _STRIP_RE.sub('', title.lower()).strip()


def _titles_match(a: str, b: str) -> bool:
    return _normalise_title(a) == _normalise_title(b)


# ──────────────────────────────────────────────────────────────────
#  1. Search
# ──────────────────────────────────────────────────────────────────

def search_anime(query: str, limit: int = 25) -> List[Dict[str, Any]]:
    """
    Search Jikan by the raw user title.

    Returns a clean list of results with enough info for the user to
    pick the correct entry.  Results are de-duplicated by mal_id.
    """
    if not query or not query.strip():
        return []

    raw_results = metadata_svc.search_jikan(query.strip())
    if not raw_results:
        return []

    seen: set = set()
    results: List[Dict[str, Any]] = []

    for item in raw_results[:limit]:
        mal_id = item.get('mal_id')
        if not mal_id or mal_id in seen:
            continue
        seen.add(mal_id)

        # Map to a compact search-result shape
        poster = (item.get('images') or {}).get('jpg', {}).get('large_image_url') or \
                 (item.get('images') or {}).get('jpg', {}).get('image_url') or ''

        genres = [g.get('name') for g in item.get('genres', []) if g.get('name')]
        studios = [s.get('name') for s in item.get('studios', []) if s.get('name')]

        results.append({
            'mal_id':    mal_id,
            'title':     item.get('title_english') or item.get('title') or 'Unknown',
            'title_jp':  item.get('title') or '',
            'poster':    poster,
            'type':      item.get('type') or 'TV',
            'episodes':  item.get('episodes') or 0,
            'status':    item.get('status') or 'Unknown',
            'score':     item.get('score') or 0,
            'year':      item.get('year'),
            'season':    item.get('season'),
            'synopsis':  (item.get('synopsis') or '')[:300],
            'genres':    genres,
            'studios':   studios,
            'airing':    bool(item.get('airing')),
            'rating':    item.get('rating') or '',
            'members':   item.get('members') or 0,
        })

    return results


# ──────────────────────────────────────────────────────────────────
#  2. Franchise / relation discovery
# ──────────────────────────────────────────────────────────────────

def get_franchise_relations(mal_id: int) -> Dict[str, Any]:
    """
    Given the user's selected MAL ID, build the full franchise graph
    and return a flat list of related entries the user can include.

    Returns {
      "main":      { ... compact entry ... },
      "relations": [ { ... entry + relationType ... }, ... ]
    }
    """
    mal_id = int(mal_id)

    # Fetch the main entry from Jikan
    main_data = metadata_svc.get_jikan_anime(mal_id)
    main_entry = _compact_entry(main_data, mal_id) if main_data else {'mal_id': mal_id, 'title': 'Unknown'}

    # Build the relation cluster via AniList
    try:
        cluster = build_relation_cluster(mal_id, max_depth=3)
    except Exception as e:
        logger.warning('Relation cluster failed for %d: %s', mal_id, e)
        # Fallback: Jikan relations only
        cluster = _jikan_fallback_cluster(mal_id)

    # Also add Jikan-side relations that AniList may miss
    _merge_jikan_relations(cluster, mal_id)

    # Build the flat relation list (exclude the main entry itself)
    relations: List[Dict[str, Any]] = []
    main_ids = {mal_id}

    nodes = cluster.get('nodes', {})
    edges = cluster.get('edges', {})

    for node_id, node in nodes.items():
        nid = int(node_id)
        if nid in main_ids:
            continue

        # Determine relation type from edges
        rel_type = 'RELATED'
        for edge_list in edges.values():
            for edge in (edge_list if isinstance(edge_list, list) else []):
                if int(edge.get('targetId', 0)) == nid:
                    rel_type = edge.get('relationType', 'RELATED')
                    break

        entry = _compact_node(node)
        entry['relationType'] = rel_type
        entry['prechecked'] = rel_type in ('SEQUEL', 'PREQUEL')
        relations.append(entry)

    # Sort: SEQUEL first, then PREQUEL, then others.  Within group by aired_at.
    _RELATION_ORDER = {'SEQUEL': 0, 'PREQUEL': 1, 'SIDE_STORY': 2,
                       'PARENT': 3, 'CHILD': 4, 'SPIN_OFF': 5}
    relations.sort(key=lambda r: (
        _RELATION_ORDER.get(r['relationType'], 99),
        r.get('aired_at') or 0,
        r.get('mal_id', 0)
    ))

    return {
        'main':      main_entry,
        'relations': relations,
    }


# ──────────────────────────────────────────────────────────────────
#  3. Save franchise bundle → full metadata
# ──────────────────────────────────────────────────────────────────

def save_franchise_bundle(
    main_mal_id: int,
    selected_mal_ids: List[int],
) -> Dict[str, Any]:
    """
    For each selected MAL ID (including the main), fetch the full
    gold-standard metadata (3-API reconciliation) and return the
    assembled franchise bundle ready for the frontend to store.

    Returns {
      "root_mal_id": ...,
      "title_english": ...,
      "title_japanese": ...,
      "poster_url": ...,
      "genres": [...],
      "seasons": { "<mal_id>": { ...season data... }, ... },
      "franchise_id": ...,
      "franchise_cluster_members": [...],
    }
    """
    all_ids = list(dict.fromkeys([int(main_mal_id)] + [int(x) for x in selected_mal_ids]))

    # Fetch gold records concurrently
    gold_records: Dict[int, Dict[str, Any]] = {}
    errors: Dict[int, str] = {}

    def _fetch(mid: int):
        try:
            return mid, engine.get_gold_record(mid), None
        except Exception as exc:
            return mid, None, str(exc)

    futures = {_pool.submit(_fetch, mid): mid for mid in all_ids}
    for fut in concurrent.futures.as_completed(futures):
        mid, record, err = fut.result()
        if record:
            gold_records[mid] = record
        if err:
            errors[mid] = err
            logger.warning('Gold record failed for %d: %s', mid, err)

    main_id = int(main_mal_id)
    main_gold = gold_records.get(main_id, {})

    # Build the seasons map
    seasons: Dict[str, Dict[str, Any]] = {}
    for mid in all_ids:
        gold = gold_records.get(mid, {})
        if not gold:
            continue
        seasons[str(mid)] = _build_season_from_gold(gold, mid)

    # Build the root-level entry
    entry = {
        'root_mal_id':            main_id,
        'selected_season_mal_id': main_id,
        'title_english':          main_gold.get('title', 'Unknown'),
        'title_japanese':         _get_japanese_title(main_gold),
        'genres':                 main_gold.get('genres', []) if isinstance(main_gold.get('genres'), list) else [],
        'poster_url':             main_gold.get('poster', ''),
        'banner_url':             main_gold.get('banner_url', ''),
        'user_poster':            None,
        'added_date':             _now_iso(),
        'updated_date':           _now_iso(),
        'last_jikan_update':      _now_iso(),
        'franchise_id':           f'mal-{main_id}',
        'franchise_cluster_members': all_ids,
        'is_sequel_confirmed':    False,
        'seasons':                seasons,
        'sync_status':            'synced',
        'franchise_meta_version': 3,
        'errors':                 errors if errors else None,
    }

    return entry


# ──────────────────────────────────────────────────────────────────
#  Private helpers
# ──────────────────────────────────────────────────────────────────

def _compact_entry(data: Dict[str, Any], fallback_id: int) -> Dict[str, Any]:
    """Convert raw Jikan /anime/:id/full response to compact shape."""
    poster = (data.get('images') or {}).get('jpg', {}).get('large_image_url', '')
    return {
        'mal_id':   data.get('mal_id') or fallback_id,
        'title':    data.get('title_english') or data.get('title') or 'Unknown',
        'title_jp': data.get('title') or '',
        'poster':   poster,
        'type':     data.get('type') or 'TV',
        'episodes': data.get('episodes') or 0,
        'status':   data.get('status') or 'Unknown',
        'score':    data.get('score') or 0,
        'year':     data.get('year'),
        'season':   data.get('season'),
        'airing':   bool(data.get('airing')),
    }


def _compact_node(node: Dict[str, Any]) -> Dict[str, Any]:
    """Convert an AniList-derived graph node to compact shape."""
    return {
        'mal_id':     node.get('mal_id') or 0,
        'anilist_id': node.get('anilist_id'),
        'title':      node.get('title') or 'Unknown',
        'native_title': node.get('native_title') or '',
        'format':     node.get('format') or 'TV',
        'status':     node.get('status') or 'UNKNOWN',
        'episodes':   node.get('episodes') or 0,
        'aired_at':   node.get('aired_at'),
        'is_airing':  bool(node.get('is_airing')),
        'is_movie':   bool(node.get('is_movie')),
        'is_ova':     bool(node.get('is_ova')),
        'is_special': bool(node.get('is_special')),
    }


def _jikan_fallback_cluster(mal_id: int) -> Dict[str, Any]:
    """Build a minimal cluster from Jikan relations when AniList fails."""
    nodes = {}
    edges = {}

    relations = metadata_svc.get_jikan_relations(mal_id)
    if not relations:
        return {'nodes': nodes, 'edges': edges}

    edges[mal_id] = []
    for group in relations:
        rel_type = (group.get('relation') or 'OTHER').upper().replace(' ', '_')
        for entry in group.get('entry', []):
            if entry.get('type') != 'anime':
                continue
            rid = entry.get('mal_id')
            if not rid:
                continue
            nodes[rid] = {
                'mal_id': rid,
                'title': entry.get('name') or 'Unknown',
                'format': 'TV',
                'status': 'UNKNOWN',
                'episodes': 0,
            }
            edges[mal_id].append({
                'targetId': rid,
                'relationType': rel_type,
            })

    return {'nodes': nodes, 'edges': edges}


def _merge_jikan_relations(cluster: Dict[str, Any], mal_id: int) -> None:
    """Merge Jikan relation data into an existing cluster."""
    try:
        relations = metadata_svc.get_jikan_relations(mal_id)
    except Exception:
        return

    nodes = cluster.setdefault('nodes', {})
    edges = cluster.setdefault('edges', {})

    if mal_id not in edges:
        edges[mal_id] = []

    existing_targets = {e.get('targetId') for e in edges.get(mal_id, [])}

    for group in (relations or []):
        rel_type = (group.get('relation') or 'OTHER').upper().replace(' ', '_')
        for entry in group.get('entry', []):
            if entry.get('type') != 'anime':
                continue
            rid = entry.get('mal_id')
            if not rid or rid in existing_targets:
                continue
            existing_targets.add(rid)
            if rid not in nodes:
                nodes[rid] = {
                    'mal_id': rid,
                    'title': entry.get('name') or 'Unknown',
                    'format': 'TV',
                    'status': 'UNKNOWN',
                    'episodes': 0,
                }
            edges[mal_id].append({
                'targetId': rid,
                'relationType': rel_type,
            })


def _build_season_from_gold(gold: Dict[str, Any], mal_id: int) -> Dict[str, Any]:
    """Build a season entry from a gold-standard record."""
    status = gold.get('status', 'Unknown')
    is_airing = status == 'Currently Airing'
    total = gold.get('total_episodes', 0)
    aired = gold.get('aired_episodes', 0)

    next_airing = gold.get('next_airing')
    next_airing_at = next_airing.get('time') if next_airing else None
    next_ep_num = next_airing.get('episode') if next_airing else None

    # Derive format from title / type hints
    fmt = 'TV'
    synonyms = gold.get('synonyms', [])
    title = gold.get('title', '')

    return {
        'mal_id':              mal_id,
        'title_english':       gold.get('title', 'Unknown'),
        'title_japanese':      _get_japanese_title(gold),
        'native_title':        _get_japanese_title(gold),
        'total_episodes':      total,
        'aired_episodes':      aired,
        'filler_episodes':     0,
        'non_filler_episodes': total,
        'episodes':            total,
        'genres':              gold.get('genres', []) if isinstance(gold.get('genres'), list) else [],
        'synopsis':            gold.get('synopsis', ''),
        'score':               gold.get('score', 0),
        'status':              status,
        'airing':              is_airing,
        'is_airing':           is_airing,
        'format':              fmt,
        'is_movie':            False,
        'is_ova':              False,
        'is_special':          False,
        'is_one_long_running_series': False,
        'season_label':        gold.get('season', ''),
        'season_year':         gold.get('year'),
        'poster_url':          gold.get('poster', ''),
        'banner_url':          gold.get('banner_url', ''),
        'user_poster':         None,
        'studios':             gold.get('studios', []),
        'producers':           gold.get('producers', []),
        'source_material':     gold.get('source_material', ''),
        'age_rating':          gold.get('age_rating', ''),
        'duration':            gold.get('duration_per_episode'),
        'popularity':          gold.get('popularity'),
        'rank':                gold.get('rank'),
        'trailer_url':         gold.get('trailer_url', ''),
        'source_ids':          {
            'mal_id':     mal_id,
            'anilist_id': gold.get('anilist_id'),
            'simkl_id':   gold.get('simkl_id'),
        },
        'provenance':          gold.get('provenance', {}),
        'source_confidence':   gold.get('source_confidence', 0),
        # Airing schedule
        'next_episode_airing_at': next_airing_at,
        'next_episode_number':    next_ep_num,
        'next_release_countdown': None,
        'has_new_episode':        False,
        # Franchise
        'franchise_id':           None,
        'franchise_root_id':      None,
        'franchise_order_index':  None,
        'franchise_rank_score':   0,
        # User fields (frontend populates these)
        'progress':               0,
        'watch_status':           'plan_to_watch',
        'watch_state':            'plan_to_watch',
        'weekly_schedule':        '',
        'relations':              [],
        'added_date':             _now_iso(),
        'updated_date':           _now_iso(),
        'last_relation_check':    _now_iso(),
        'started_watching_date':  None,
        'last_progress_update':   None,
        'last_watched_at':        None,
        'has_user_watched_previous': False,
        'last_notified_episode':  None,
        'sync_status':            'synced',
    }


def _get_japanese_title(gold: Dict[str, Any]) -> str:
    """Extract a Japanese title from a gold record."""
    # Prefer the dedicated native title field (from AniList)
    native = gold.get('title_native')
    if native:
        return native
    # Fallback to synonyms
    title = gold.get('title', '')
    for s in gold.get('synonyms', []):
        if s and s != title:
            return s
    return title


def _now_iso() -> str:
    import datetime as _dt
    return _dt.datetime.utcnow().isoformat() + 'Z'
