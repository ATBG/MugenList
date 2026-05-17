"""
metadata_service.py — Unified metadata provider for MugelList.
Handles Jikan (MAL), AniList, and SIMKL requests with caching, retries,
and timeouts.  Thread-safe in-memory cache with configurable TTL.
"""
from __future__ import annotations
import os
import time
import logging
import threading
import requests
from typing import Optional, Dict, Any, List

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
JIKAN_BASE = "https://api.jikan.moe/v4"
ANILIST_BASE = "https://graphql.anilist.co"
SIMKL_BASE = "https://api.simkl.com"
DEFAULT_TIMEOUT = 15   # seconds
MAX_RETRIES = 3
CACHE_TTL = 3600       # 1 hour default


# ---------------------------------------------------------------------------
# Thread-safe TTL cache
# ---------------------------------------------------------------------------
class TTLCache:
    """Simple dict-backed cache with per-key expiry and a lock."""

    def __init__(self, default_ttl: int = CACHE_TTL):
        self._store: Dict[str, tuple] = {}   # key -> (value, expire_ts)
        self._lock = threading.Lock()
        self._ttl = default_ttl

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            value, expires = entry
            if time.time() > expires:
                del self._store[key]
                return None
            return value

    def set(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        with self._lock:
            self._store[key] = (value, time.time() + (ttl or self._ttl))

    def clear(self) -> None:
        with self._lock:
            self._store.clear()

    def stats(self) -> Dict[str, int]:
        with self._lock:
            now = time.time()
            live = sum(1 for _, (_, exp) in self._store.items() if exp > now)
            return {'total': len(self._store), 'live': live}


# ---------------------------------------------------------------------------
# MetadataService
# ---------------------------------------------------------------------------
class MetadataService:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "MugelList-Backend/2.0",
            "Accept": "application/json"
        })
        self._jikan_cache = TTLCache(default_ttl=CACHE_TTL)
        self._anilist_cache = TTLCache(default_ttl=CACHE_TTL)
        self._simkl_cache = TTLCache(default_ttl=CACHE_TTL)

    # ---- internal helpers ------------------------------------------------

    def _request(self, method: str, url: str, **kwargs) -> Optional[Dict[str, Any]]:
        """Internal helper for requests with retry + back-off logic."""
        for attempt in range(MAX_RETRIES):
            try:
                response = self.session.request(
                    method, url, timeout=DEFAULT_TIMEOUT, **kwargs
                )

                if response.status_code == 429:  # Rate Limit
                    wait = (attempt + 1) * 2
                    logger.warning("Rate limited by %s. Waiting %ds...", url, wait)
                    time.sleep(wait)
                    continue

                response.raise_for_status()
                return response.json()
            except requests.exceptions.RequestException as e:
                logger.error("Request failed: %s - %s", url, e)
                if attempt == MAX_RETRIES - 1:
                    return None
                time.sleep(1)
        return None

    # ---- Jikan -----------------------------------------------------------

    def get_jikan_anime(self, mal_id: int) -> Optional[Dict[str, Any]]:
        """Fetch full anime details from Jikan."""
        cache_key = f"anime_{mal_id}"
        cached = self._jikan_cache.get(cache_key)
        if cached is not None:
            return cached

        data = self._request("GET", f"{JIKAN_BASE}/anime/{mal_id}/full")
        if data and "data" in data:
            self._jikan_cache.set(cache_key, data["data"])
            return data["data"]
        return None

    def search_jikan(self, query: str, limit: int = 25) -> List[Dict[str, Any]]:
        """Search anime via Jikan with configurable result limit."""
        results = []
        try:
            data = self._request("GET", f"{JIKAN_BASE}/anime", params={
                "q": query, "limit": min(limit, 25)
            })
            if data and "data" in data and len(data["data"]) > 0:
                results = data["data"]
        except Exception as e:
            logger.warning("Jikan search encountered error: %s", e)
        
        # Fallback to AniList if Jikan failed or returned nothing
        if not results:
            results = self.search_anilist(query, limit)
            
        return results

    def search_anilist(self, query: str, limit: int = 25) -> List[Dict[str, Any]]:
        """Search anime via AniList and format results like Jikan."""
        graphql_query = """
        query ($search: String, $limit: Int) {
          Page(page: 1, perPage: $limit) {
            media(search: $search, type: ANIME) {
              id
              idMal
              format
              status
              episodes
              averageScore
              seasonYear
              season
              description
              genres
              title {
                romaji
                english
                native
              }
              coverImage {
                large
                medium
              }
              studios(isMain: true) {
                nodes {
                  name
                }
              }
            }
          }
        }
        """
        try:
            logger.info("Jikan timed out or failed. Falling back to AniList search for '%s'...", query)
            data = self._request(
                "POST", ANILIST_BASE,
                json={"query": graphql_query, "variables": {"search": query, "limit": min(limit, 25)}}
            )
            if data and "data" in data and data["data"].get("Page", {}).get("media"):
                media_list = data["data"]["Page"]["media"]
                results = []
                for item in media_list:
                    mal_id = item.get("idMal") or item.get("id")
                    if not mal_id:
                        continue
                    
                    genres = [{"name": g} for g in item.get("genres", [])]
                    studios = [{"name": s.get("name")} for s in item.get("studios", {}).get("nodes", []) if s.get("name")]
                    
                    results.append({
                        "mal_id": int(mal_id),
                        "title": item.get("title", {}).get("english") or item.get("title", {}).get("romaji") or item.get("title", {}).get("native") or "Unknown",
                        "title_english": item.get("title", {}).get("english") or item.get("title", {}).get("romaji") or "",
                        "title_jp": item.get("title", {}).get("native") or item.get("title", {}).get("romaji") or "",
                        "images": {
                            "jpg": {
                                "large_image_url": item.get("coverImage", {}).get("large") or item.get("coverImage", {}).get("medium") or ""
                            }
                        },
                        "type": item.get("format") or "TV",
                        "episodes": item.get("episodes") or 0,
                        "status": item.get("status") or "FINISHED",
                        "score": (item.get("averageScore") or 0) / 10.0 if item.get("averageScore") else None,
                        "year": item.get("seasonYear"),
                        "season": item.get("season"),
                        "synopsis": item.get("description") or "",
                        "genres": genres,
                        "studios": studios,
                        "airing": item.get("status") == "RELEASING",
                    })
                logger.info("AniList search successful, returned %d results.", len(results))
                return results
        except Exception as e:
            logger.error("AniList fallback search failed: %s", e)
        return []

    def get_jikan_relations(self, mal_id: int) -> List[Dict[str, Any]]:
        """Fetch relations for an anime via Jikan."""
        data = self._request("GET", f"{JIKAN_BASE}/anime/{mal_id}/relations")
        if data and "data" in data:
            return data["data"]
        return []

    # ---- AniList ---------------------------------------------------------

    def get_anilist_media(self, id_mal: int) -> Optional[Dict[str, Any]]:
        """Fetch comprehensive media details from AniList via MAL ID."""
        cache_key = f"mal_{id_mal}"
        cached = self._anilist_cache.get(cache_key)
        if cached is not None:
            return cached

        query = """
        query ($idMal: Int) {
          Media(idMal: $idMal, type: ANIME) {
            id
            idMal
            format
            status
            episodes
            duration
            season
            seasonYear
            averageScore
            popularity
            source
            description
            genres
            synonyms
            title { romaji english native }
            coverImage { large medium color }
            bannerImage
            studios { nodes { name } }
            trailer { id site thumbnail }
            startDate { year month day }
            endDate { year month day }
            nextAiringEpisode { airingAt episode timeUntilAiring }
            relations {
              edges {
                relationType(version: 2)
                node {
                  id idMal type format status
                  title { romaji english }
                }
              }
            }
          }
        }
        """
        data = self._request(
            "POST", ANILIST_BASE,
            json={"query": query, "variables": {"idMal": id_mal}}
        )
        if data and "data" in data and data["data"].get("Media"):
            res = data["data"]["Media"]
            self._anilist_cache.set(cache_key, res)
            return res
        return None

    # ---- SIMKL -----------------------------------------------------------

    def get_simkl_anime(self, id_mal: int) -> Optional[Dict[str, Any]]:
        """Fetch anime details from SIMKL via MAL ID."""
        cache_key = f"mal_{id_mal}"
        cached = self._simkl_cache.get(cache_key)
        if cached is not None:
            return cached

        url = f"{SIMKL_BASE}/anime/idmal/{id_mal}"
        client_id = os.environ.get(
            "SIMKL_CLIENT_ID",
            "180306337b3297e185f292989f7dc32249612463695e2cb913fa100b14569103"
        )
        headers = {"simkl-api-client": client_id}

        data = self._request("GET", url, headers=headers)
        if data:
            self._simkl_cache.set(cache_key, data)
            return data
        return None

    # ---- cache management ------------------------------------------------

    def cache_stats(self) -> Dict[str, Any]:
        return {
            'jikan': self._jikan_cache.stats(),
            'anilist': self._anilist_cache.stats(),
            'simkl': self._simkl_cache.stats(),
        }

    def clear_caches(self) -> None:
        self._jikan_cache.clear()
        self._anilist_cache.clear()
        self._simkl_cache.clear()
        logger.info("All metadata caches cleared.")


# Singleton instance
metadata_svc = MetadataService()
