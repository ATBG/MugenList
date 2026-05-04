"""
Jikan API Wrapper (MyAnimeList)

Rate limit: 3 requests per second
Documentation: https://docs.api.jikan.moe/
"""

import aiohttp
import asyncio
from typing import Optional, List, Dict, Any
from datetime import datetime
import logging

from utils.errors import (
    with_retry, classify_error, APIError, 
    ErrorCategory, ErrorSeverity, safe_get
)
from models.anime import (
    AnimeMetadata, SourceIds, TitleInfo, EpisodeInfo,
    Source, AnimeStatus, FranchiseRelation, RelationType, Provenance
)

logger = logging.getLogger(__name__)

# Rate limiting
RATE_LIMIT = 3  # requests per second
_rate_limit_lock = asyncio.Lock()
_last_request_time = 0


class JikanClient:
    """Jikan API client with rate limiting and error handling."""
    
    BASE_URL = "https://api.jikan.moe/v4"
    
    def __init__(self, timeout: int = 30):
        self.timeout = timeout
        self._session: Optional[aiohttp.ClientSession] = None
    
    async def __aenter__(self):
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=self.timeout),
            headers={"Accept": "application/json"}
        )
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._session:
            await self._session.close()
            self._session = None
    
    async def _rate_limited_request(self, url: str) -> Dict[str, Any]:
        """Make a rate-limited request."""
        global _last_request_time
        
        async with _rate_limit_lock:
            # Ensure minimum delay between requests
            current_time = asyncio.get_event_loop().time()
            time_since_last = current_time - _last_request_time
            min_delay = 1.0 / RATE_LIMIT
            
            if time_since_last < min_delay:
                await asyncio.sleep(min_delay - time_since_last)
            
            _last_request_time = asyncio.get_event_loop().time()
        
        if not self._session:
            raise RuntimeError("Client not entered as context manager")
        
        async with self._session.get(url) as response:
            if response.status == 429:
                # Rate limited - wait and retry once
                logger.warning("Jikan rate limit hit, waiting 2s...")
                await asyncio.sleep(2)
                async with self._session.get(url) as retry_response:
                    retry_response.raise_for_status()
                    return await retry_response.json()
            
            response.raise_for_status()
            return await response.json()
    
    async def search_anime(
        self, 
        query: str, 
        page: int = 1, 
        limit: int = 20,
        order_by: str = "members",
        sort: str = "desc"
    ) -> List[AnimeMetadata]:
        """
        Search anime by title.
        
        Args:
            query: Search query
            page: Page number (1-indexed)
            limit: Results per page (max 25)
            order_by: Sort field
            sort: Sort direction
        """
        if not query or not query.strip():
            return []
        
        params = {
            "q": query.strip(),
            "page": max(1, page),
            "limit": max(1, min(25, limit)),
            "sfw": "false",
            "order_by": order_by,
            "sort": sort
        }
        
        query_string = "&".join(f"{k}={v}" for k, v in params.items())
        url = f"{self.BASE_URL}/anime?{query_string}"
        
        try:
            data = await with_retry(
                self._rate_limited_request,
                url,
                max_retries=2,
                base_delay=1.0
            )
            
            results = []
            for item in data.get("data", []):
                metadata = self._parse_anime(item)
                if metadata:
                    results.append(metadata)
            
            return results
            
        except Exception as e:
            error = classify_error(e, "jikan")
            error.details = {"operation": "search_anime", "query": query}
            logger.error(f"Jikan search failed: {error.message}")
            raise
    
    async def get_anime_by_id(self, mal_id: int, full: bool = True) -> Optional[AnimeMetadata]:
        """Get detailed anime info by MAL ID."""
        endpoint = "full" if full else ""
        url = f"{self.BASE_URL}/anime/{mal_id}"
        if endpoint:
            url += f"/{endpoint}"
        
        try:
            data = await with_retry(
                self._rate_limited_request,
                url,
                max_retries=2,
                base_delay=1.0
            )
            
            return self._parse_anime(data.get("data"))
            
        except Exception as e:
            error = classify_error(e, "jikan")
            error.details = {"operation": "get_anime_by_id", "mal_id": mal_id}
            
            if error.category == ErrorCategory.NOT_FOUND:
                logger.info(f"Anime {mal_id} not found on Jikan")
                return None
            
            logger.error(f"Jikan fetch failed for {mal_id}: {error.message}")
            raise
    
    async def get_anime_relations(self, mal_id: int) -> List[FranchiseRelation]:
        """Get franchise relations for an anime."""
        url = f"{self.BASE_URL}/anime/{mal_id}/relations"
        
        try:
            data = await with_retry(
                self._rate_limited_request,
                url,
                max_retries=2,
                base_delay=1.0
            )
            
            relations = []
            for relation_group in data.get("data", []):
                relation_type_str = relation_group.get("relation", "").lower().replace(" ", "_")
                
                # Map relation types
                relation_type_map = {
                    "sequel": RelationType.SEQUEL,
                    "prequel": RelationType.PREQUEL,
                    "side_story": RelationType.SIDE_STORY,
                    "spin-off": RelationType.SPIN_OFF,
                    "parent": RelationType.PARENT,
                    "child": RelationType.CHILD,
                    "alternative_version": RelationType.ALTERNATIVE_VERSION,
                    "summary": RelationType.SUMMARY,
                    "other": RelationType.OTHER
                }
                
                relation_type = relation_type_map.get(
                    relation_type_str, 
                    RelationType.OTHER
                )
                
                for entry in relation_group.get("entry", []):
                    if entry.get("type") == "anime":
                        relations.append(FranchiseRelation(
                            ids=SourceIds(mal_id=entry.get("mal_id")),
                            relation_type=relation_type,
                            title=TitleInfo(english=entry.get("name")),
                            confidence=0.9 if relation_type in [RelationType.SEQUEL, RelationType.PREQUEL] else 0.7
                        ))
            
            return relations
            
        except Exception as e:
            error = classify_error(e, "jikan")
            logger.warning(f"Failed to get relations for {mal_id}: {error.message}")
            return []
    
    async def get_seasonal_anime(
        self, 
        year: int, 
        season: str,  # winter, spring, summer, fall
        page: int = 1
    ) -> List[AnimeMetadata]:
        """Get anime from a specific season."""
        url = f"{self.BASE_URL}/seasons/{year}/{season}?page={page}"
        
        try:
            data = await with_retry(
                self._rate_limited_request,
                url,
                max_retries=2,
                base_delay=1.0
            )
            
            results = []
            for item in data.get("data", []):
                metadata = self._parse_anime(item)
                if metadata:
                    results.append(metadata)
            
            return results
            
        except Exception as e:
            error = classify_error(e, "jikan")
            logger.error(f"Failed to get seasonal anime: {error.message}")
            raise
    
    async def get_current_season(self, page: int = 1) -> List[AnimeMetadata]:
        """Get current season's anime."""
        url = f"{self.BASE_URL}/seasons/now?page={page}"
        
        try:
            data = await with_retry(
                self._rate_limited_request,
                url,
                max_retries=2,
                base_delay=1.0
            )
            
            results = []
            for item in data.get("data", []):
                metadata = self._parse_anime(item)
                if metadata:
                    results.append(metadata)
            
            return results
            
        except Exception as e:
            error = classify_error(e, "jikan")
            logger.error(f"Failed to get current season: {error.message}")
            raise
    
    def _parse_anime(self, data: Optional[Dict]) -> Optional[AnimeMetadata]:
        """Parse Jikan anime data into normalized model."""
        if not data:
            return None
        
        mal_id = data.get("mal_id")
        if not mal_id:
            return None
        
        # Extract AniList ID from external links if available
        anilist_id = None
        for link in data.get("external", []):
            if link.get("name", "").lower() == "anilist":
                url = link.get("url", "")
                if "/anime/" in url:
                    anilist_id = int(url.split("/anime/")[-1].split("/")[0])
                    break
        
        # Parse dates
        start_date = self._parse_date(safe_get(data, "aired", "from"))
        end_date = self._parse_date(safe_get(data, "aired", "to"))
        
        # Parse status
        status_map = {
            "finished airing": AnimeStatus.FINISHED_AIRING,
            "currently airing": AnimeStatus.CURRENTLY_AIRING,
            "not yet aired": AnimeStatus.NOT_YET_AIRED
        }
        status_str = data.get("status", "").lower()
        status = status_map.get(status_str, AnimeStatus.UNKNOWN)
        
        # Parse images
        images = data.get("images", {})
        jpg_images = images.get("jpg", {})
        poster_url = jpg_images.get("large_image_url") or jpg_images.get("image_url")
        
        # Extract trailer
        trailer = data.get("trailer", {})
        trailer_url = trailer.get("url")
        
        # Create metadata
        metadata = AnimeMetadata(
            ids=SourceIds(
                mal_id=mal_id,
                anilist_id=anilist_id
            ),
            titles=TitleInfo(
                english=data.get("title_english") or data.get("title"),
                japanese=data.get("title_japanese"),
                romaji=data.get("title"),
                synonyms=data.get("title_synonyms", [])
            ),
            synopsis=data.get("synopsis"),
            genres=[g.get("name") for g in data.get("genres", []) if g.get("name")],
            themes=[t.get("name") for t in data.get("themes", []) if t.get("name")],
            score=data.get("score"),
            popularity=data.get("popularity"),
            rank=data.get("rank"),
            status=status,
            season=data.get("season"),
            year=data.get("year"),
            start_date=start_date,
            end_date=end_date,
            episodes=EpisodeInfo(
                aired_episodes=data.get("episodes") or 0,
                total_episodes=data.get("episodes") or 0
            ),
            poster_url=poster_url,
            trailer_url=trailer_url,
            studios=[s.get("name") for s in data.get("studios", []) if s.get("name")],
            producers=[p.get("name") for p in data.get("producers", []) if p.get("name")],
            licensors=[l.get("name") for l in data.get("licensors", []) if l.get("name")],
            source_material=data.get("source"),
            age_rating=data.get("rating"),
            duration_per_episode=self._parse_duration(data.get("duration")),
            provenance={
                "metadata": Provenance(
                    source=Source.JIKAN,
                    confidence=1.0,
                    timestamp=datetime.utcnow()
                )
            }
        )
        
        return metadata
    
    def _parse_date(self, date_str: Optional[str]) -> Optional[datetime]:
        """Parse ISO date string."""
        if not date_str:
            return None
        try:
            return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            return None
    
    def _parse_duration(self, duration_str: Optional[str]) -> Optional[int]:
        """Parse duration string (e.g., '24 min per ep') into minutes."""
        if not duration_str:
            return None
        
        import re
        match = re.search(r'(\d+)', duration_str)
        if match:
            return int(match.group(1))
        return None


def safe_get(data: dict, *keys, default=None):
    """Safely navigate nested dictionaries."""
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
        if current is None:
            return default
    return current if current is not None else default
