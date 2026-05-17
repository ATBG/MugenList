"""
SIMKL API Wrapper

Rate limit: Not explicitly stated, but be reasonable
Documentation: https://api.simkl.com/
Note: Requires API key for some endpoints
"""

import aiohttp
import asyncio
from typing import Optional, List, Dict, Any
from datetime import datetime
import logging

from utils.errors import with_retry, classify_error
from models.anime import (
    AnimeMetadata, SourceIds, TitleInfo, EpisodeInfo,
    Source, AnimeStatus, Provenance
)

logger = logging.getLogger(__name__)

# Rate limiting (conservative)
RATE_LIMIT = 2  # requests per second
_rate_limit_lock = asyncio.Lock()
_last_request_time = 0


class SIMKLClient:
    """SIMKL API client with rate limiting."""
    
    BASE_URL = "https://api.simkl.com"
    
    def __init__(self, api_key: Optional[str] = None, timeout: int = 30):
        self.api_key = api_key
        self.timeout = timeout
        self._session: Optional[aiohttp.ClientSession] = None
    
    async def __aenter__(self):
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["simkl-api-key"] = self.api_key
        
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=self.timeout),
            headers=headers
        )
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._session:
            await self._session.close()
            self._session = None
    
    async def _rate_limited_request(self, endpoint: str) -> Dict[str, Any]:
        """Make a rate-limited request."""
        global _last_request_time
        
        async with _rate_limit_lock:
            current_time = asyncio.get_event_loop().time()
            time_since_last = current_time - _last_request_time
            min_delay = 1.0 / RATE_LIMIT
            
            if time_since_last < min_delay:
                await asyncio.sleep(min_delay - time_since_last)
            
            _last_request_time = asyncio.get_event_loop().time()
        
        if not self._session:
            raise RuntimeError("Client not entered as context manager")
        
        url = f"{self.BASE_URL}{endpoint}"
        
        async with self._session.get(url) as response:
            if response.status == 429:
                logger.warning("SIMKL rate limit hit, waiting 2s...")
                await asyncio.sleep(2)
                async with self._session.get(url) as retry_response:
                    retry_response.raise_for_status()
                    return await retry_response.json()
            
            response.raise_for_status()
            return await response.json()
    
    async def search_anime(self, query: str) -> List[AnimeMetadata]:
        """Search anime by title."""
        if not query or not query.strip():
            return []
        
        endpoint = f"/search/anime?q={query.strip()}"
        
        try:
            data = await with_retry(
                self._rate_limited_request,
                endpoint,
                max_retries=2,
                base_delay=1.0
            )
            
            results = []
            for item in data if isinstance(data, list) else []:
                metadata = self._parse_search_result(item)
                if metadata:
                    results.append(metadata)
            
            return results
            
        except Exception as e:
            error = classify_error(e, "simkl")
            error.details = {"operation": "search_anime", "query": query}
            logger.error(f"SIMKL search failed: {error.message}")
            raise
    
    async def get_anime_by_id(
        self, 
        simkl_id: Optional[int] = None,
        mal_id: Optional[int] = None
    ) -> Optional[AnimeMetadata]:
        """Get detailed anime info."""
        if simkl_id:
            endpoint = f"/anime/{simkl_id}"
        elif mal_id:
            endpoint = f"/anime/{mal_id}?mal=1"
        else:
            raise ValueError("Either simkl_id or mal_id must be provided")
        
        try:
            data = await with_retry(
                self._rate_limited_request,
                endpoint,
                max_retries=2,
                base_delay=1.0
            )
            
            return self._parse_anime_detail(data)
            
        except Exception as e:
            error = classify_error(e, "simkl")
            error.details = {
                "operation": "get_anime_by_id",
                "simkl_id": simkl_id,
                "mal_id": mal_id
            }
            
            if error.category.value == "not_found":
                return None
            
            logger.error(f"SIMKL fetch failed: {error.message}")
            raise
    
    async def get_best_matches(
        self, 
        mal_ids: List[int]
    ) -> Dict[int, Dict[str, Any]]:
        """
        Get SIMKL IDs for MAL IDs (useful for cross-referencing).
        Returns a map of MAL ID -> SIMKL data.
        """
        if not mal_ids:
            return {}
        
        # SIMKL can do batch lookups, but let's be conservative
        results = {}
        
        for mal_id in mal_ids[:50]:  # Limit to 50 per call
            try:
                data = await self.get_anime_by_id(mal_id=mal_id)
                if data and data.ids.simkl_id:
                    results[mal_id] = {
                        "simkl_id": data.ids.simkl_id,
                        "title": data.titles.get_primary(),
                        "poster": data.poster_url
                    }
            except Exception as e:
                logger.warning(f"Failed to get SIMKL match for MAL {mal_id}: {e}")
                continue
        
        return results
    
    def _parse_search_result(self, data: Dict[str, Any]) -> Optional[AnimeMetadata]:
        """Parse SIMKL search result."""
        if not data:
            return None
        
        simkl_id = data.get("ids", {}).get("simkl")
        mal_id = data.get("ids", {}).get("mal")
        
        if not simkl_id and not mal_id:
            return None
        
        poster_url = None
        if data.get("poster"):
            poster_url = f"https://simkl.in/ep/{data['poster']}_c.jpg"
        
        return AnimeMetadata(
            ids=SourceIds(
                simkl_id=simkl_id,
                mal_id=mal_id
            ),
            titles=TitleInfo(
                english=data.get("title"),
                japanese=data.get("alt_titles", {}).get("jp") if data.get("alt_titles") else None
            ),
            year=data.get("year"),
            poster_url=poster_url,
            provenance={
                "metadata": Provenance(
                    source=Source.SIMKL,
                    confidence=0.8,
                    timestamp=datetime.utcnow()
                )
            }
        )
    
    def _parse_anime_detail(self, data: Dict[str, Any]) -> Optional[AnimeMetadata]:
        """Parse detailed SIMKL anime data."""
        if not data:
            return None
        
        ids_data = data.get("ids", {})
        simkl_id = ids_data.get("simkl")
        mal_id = ids_data.get("mal")
        anilist_id = ids_data.get("anilist")
        
        # Parse title info
        titles_data = data.get("title", {})
        titles = TitleInfo(
            english=titles_data.get("english") if isinstance(titles_data, dict) else titles_data,
            japanese=data.get("alt_titles", {}).get("jp") if data.get("alt_titles") else None
        )
        
        # Parse dates
        start_date = None
        if data.get("first_aired"):
            try:
                start_date = datetime.strptime(data["first_aired"], "%Y-%m-%d")
            except ValueError:
                pass
        
        # Parse episode info
        episodes = EpisodeInfo(
            aired_episodes=data.get("total_episodes", 0),
            total_episodes=data.get("total_episodes", 0)
        )
        
        # Parse images
        poster_url = None
        if data.get("poster"):
            poster_url = f"https://simkl.in/ep/{data['poster']}_c.jpg"
        
        fanart_url = None
        if data.get("fanart"):
            fanart_url = f"https://simkl.in/fanart/{data['fanart']}_c.jpg"
        
        # Parse status
        status_map = {
            "ended": AnimeStatus.FINISHED_AIRING,
            "tba": AnimeStatus.NOT_YET_AIRED,
            "airing": AnimeStatus.CURRENTLY_AIRING
        }
        status = status_map.get(data.get("status", "").lower(), AnimeStatus.UNKNOWN)
        
        return AnimeMetadata(
            ids=SourceIds(
                simkl_id=simkl_id,
                mal_id=mal_id,
                anilist_id=anilist_id
            ),
            titles=titles,
            synopsis=data.get("overview"),
            genres=data.get("genres", []),
            score=data.get("ratings", {}).get("simkl", {}).get("rating") if data.get("ratings") else None,
            status=status,
            year=data.get("year"),
            start_date=start_date,
            episodes=episodes,
            poster_url=poster_url,
            banner_url=fanart_url,
            studios=[data.get("studio")] if data.get("studio") else [],
            provenance={
                "metadata": Provenance(
                    source=Source.SIMKL,
                    confidence=1.0,
                    timestamp=datetime.utcnow()
                )
            }
        )
