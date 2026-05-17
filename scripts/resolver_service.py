"""
resolver_service.py — AniList relation graph resolver.
Builds clusters of related anime using AniList GraphQL.
"""
from __future__ import annotations
import time
import logging
import requests
from typing import Optional, Dict, Any, List, Set

logger = logging.getLogger(__name__)

ANILIST_URL = 'https://graphql.anilist.co'
DEFAULT_MAX_DEPTH = 4
REQUEST_DELAY = 0.4  # Polite delay between requests

MEDIA_QUERY = '''
query ($idMal: Int) {
  Media(idMal: $idMal, type: ANIME) {
    id
    idMal
    format
    status
    episodes
    season
    seasonYear
    title { romaji english native }
    startDate { year month day }
    nextAiringEpisode { airingAt episode }
    relations {
      edges {
        relationType
        node {
          id
          idMal
          type
          format
          status
          episodes
          season
          seasonYear
          title { romaji english native }
          startDate { year month day }
          nextAiringEpisode { airingAt episode }
        }
      }
    }
  }
}
'''

def _map_anilist_node(media: Dict[str, Any], relation_type: Optional[str] = None) -> Dict[str, Any]:
    """Helper to map AniList media object to a flat MugelList-compatible node."""
    if not media:
        return {}
        
    fmt = (media.get('format') or '').upper()
    
    # Map AniList startDate to ms
    start_date = media.get('startDate') or {}
    aired_at_ms = None
    if start_date.get('year'):
        try:
            import datetime
            y = int(start_date['year'])
            m = int(start_date.get('month') or 1)
            d = int(start_date.get('day') or 1)
            aired_at_ms = int(datetime.datetime(y, m, d).timestamp() * 1000)
        except:
            pass

    return {
        'anilist_id': media.get('id'),
        'mal_id': media.get('idMal'),
        'title': (media.get('title') or {}).get('english') or (media.get('title') or {}).get('romaji'),
        'native_title': (media.get('title') or {}).get('native'),
        'format': fmt,
        'status': media.get('status'),
        'episodes': media.get('episodes') or 0,
        'aired_at': aired_at_ms,
        'next_episode_airtime': (media.get('nextAiringEpisode') or {}).get('airingAt', 0) * 1000 or None,
        'next_episode_number': (media.get('nextAiringEpisode') or {}).get('episode'),
        'is_airing': bool(media.get('nextAiringEpisode')) or media.get('status') == 'RELEASING',
        'is_movie': fmt == 'MOVIE',
        'is_ova': fmt == 'OVA',
        'is_special': fmt in ('SPECIAL', 'TV_SPECIAL'),
        'relationType': relation_type
    }

def fetch_media_cluster_node(id_mal: int) -> Optional[Dict[str, Any]]:
    """Fetch a single node and its immediate relations."""
    try:
        r = requests.post(ANILIST_URL, json={'query': MEDIA_QUERY, 'variables': {'idMal': id_mal}}, timeout=20)
        r.raise_for_status()
        data = r.json()
        
        media = data.get('data', {}).get('Media')
        if not media:
            return None
            
        node = _map_anilist_node(media)
        relations = []
        for edge in (media.get('relations', {}).get('edges') or []):
            rel_node = edge.get('node')
            if rel_node and rel_node.get('type') == 'ANIME' and rel_node.get('idMal'):
                relations.append(_map_anilist_node(rel_node, edge.get('relationType')))
                
        return {'node': node, 'relations': relations}
    except Exception as e:
        logger.error(f"Failed to fetch AniList cluster node {id_mal}: {e}")
        return None

def build_relation_cluster(seed_mal_id: int, max_depth: int = DEFAULT_MAX_DEPTH) -> Dict[str, Any]:
    """BFS traversal to build a full relation graph."""
    nodes = {}
    edges = {}
    visited = set()
    queue = [(int(seed_mal_id), 0)]
    
    logger.info(f"Building relation cluster for MAL ID {seed_mal_id} (depth={max_depth})")

    while queue:
        mal_id, depth = queue.pop(0)
        if mal_id in visited or depth > max_depth:
            continue
            
        visited.add(mal_id)
        time.sleep(REQUEST_DELAY) # Polite delay
        
        payload = fetch_media_cluster_node(mal_id)
        if not payload:
            continue
            
        node = payload['node']
        if not node or not node.get('mal_id'):
            continue
            
        nodes[node['mal_id']] = node
        edges[node['mal_id']] = []
        
        for rel in payload['relations']:
            rel_id = rel['mal_id']
            nodes[rel_id] = nodes.get(rel_id, rel) # Don't overwrite if already fetched full
            edges[node['mal_id']].append({
                'targetId': rel_id,
                'relationType': rel.get('relationType')
            })
            
            if rel_id not in visited:
                queue.append((rel_id, depth + 1))
                
    return {'nodes': nodes, 'edges': edges}
