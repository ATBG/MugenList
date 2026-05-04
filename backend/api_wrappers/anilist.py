"""
AniList API Wrapper

Rate limit: 90 requests per minute (1.5 per second)
Uses GraphQL API
Documentation: https://anilist.github.io/ApiV2-GraphQL-Docs/
"""

import aiohttp
import asyncio
from typing import Optional, List, Dict, Any
from datetime import datetime
import logging

from utils.errors import with_retry, classify_error, safe_get
from models.anime import (
    AnimeMetadata, SourceIds, TitleInfo, EpisodeInfo,
    Source, AnimeStatus, FranchiseRelation, RelationType, Provenance
)

logger = logging.getLogger(__name__)

# Rate limiting: 90 requests per minute = 1 per 0.67 seconds
RATE_LIMIT = 1  # request per second (conservative)
_rate_limit_lock = asyncio.Lock()
_last_request_time = 0


class AniListClient:
    """AniList GraphQL API client with rate limiting."""
    
    GRAPHQL_URL = "https://graphql.anilist.co"
    
    def __init__(self, timeout: int = 30):
        self.timeout = timeout
        self._session: Optional[aiohttp.ClientSession] = None
    
    async def __aenter__(self):
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=self.timeout),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json"
            }
        )
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._session:
            await self._session.close()
            self._session = None
    
    async def _rate_limited_graphql(
        self, 
        query: str, 
        variables: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """Make a rate-limited GraphQL request."""
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
        
        payload = {
            "query": query,
            "variables": variables or {}
        }
        
        async with self._session.post(
            self.GRAPHQL_URL,
            json=payload
        ) as response:
            if response.status == 429:
                logger.warning("AniList rate limit hit, waiting 3s...")
                await asyncio.sleep(3)
                async with self._session.post(
                    self.GRAPHQL_URL,
                    json=payload
                ) as retry_response:
                    retry_response.raise_for_status()
                    return await retry_response.json()
            
            response.raise_for_status()
            return await response.json()
    
    async def search_anime(
        self,
        query: str,
        page: int = 1,
        per_page: int = 20
    ) -> List[AnimeMetadata]:
        """Search anime by title."""
        if not query or not query.strip():
            return []
        
        graphql_query = """
        query ($search: String, $page: Int, $perPage: Int) {
            Page(page: $page, perPage: $perPage) {
                media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
                    id
                    idMal
                    title {
                        romaji
                        english
                        native
                    }
                    description
                    episodes
                    status
                    season
                    seasonYear
                    averageScore
                    popularity
                    genres
                    coverImage {
                        large
                        medium
                    }
                    trailer {
                        id
                        site
                    }
                    studios {
                        nodes {
                            name
                        }
                    }
                    nextAiringEpisode {
                        episode
                        timeUntilAiring
                        airingAt
                    }
                }
            }
        }
        """
        
        try:
            data = await with_retry(
                self._rate_limited_graphql,
                graphql_query,
                {"search": query.strip(), "page": page, "perPage": per_page},
                max_retries=2,
                base_delay=1.0
            )
            
            results = []
            for media in data.get("data", {}).get("Page", {}).get("media", []):
                metadata = self._parse_media(media)
                if metadata:
                    results.append(metadata)
            
            return results
            
        except Exception as e:
            error = classify_error(e, "anilist")
            error.details = {"operation": "search_anime", "query": query}
            logger.error(f"AniList search failed: {error.message}")
            raise
    
    async def get_anime_by_id(
        self, 
        anilist_id: Optional[int] = None,
        mal_id: Optional[int] = None
    ) -> Optional[AnimeMetadata]:
        """Get anime by AniList ID or MAL ID."""
        if not anilist_id and not mal_id:
            raise ValueError("Either anilist_id or mal_id must be provided")
        
        # Build query based on which ID is provided
        if mal_id:
            id_filter = f"idMal: {mal_id}"
        else:
            id_filter = f"id: {anilist_id}"
        
        graphql_query = f"""
        query {{
            Media({id_filter}, type: ANIME) {{
                id
                idMal
                title {{
                    romaji
                    english
                    native
                }}
                description
                episodes
                status
                season
                seasonYear
                averageScore
                popularity
                rank
                genres
                tags {{
                    name
                }}
                coverImage {{
                    large
                    medium
                    color
                }}
                bannerImage
                trailer {{
                    id
                    site
                    thumbnail
                }}
                studios {{
                    nodes {{
                        name
                    }}
                }}
                producers {{
                    nodes {{
                        name
                    }}
                }}
                source
                duration
                rating
                nextAiringEpisode {{
                    episode
                    timeUntilAiring
                    airingAt
                }}
                airingSchedule {{
                    nodes {{
                        episode
                        airingAt
                    }}
                }}
                startDate {{
                    year
                    month
                    day
                }}
                endDate {{
                    year
                    month
                    day
                }}
                synonyms
                relations {{
                    edges {{
                        relationType(version: 2)
                        node {{
                            id
                            idMal
                            title {{
                                romaji
                                english
                            }}
                            type
                            status
                        }}
                    }}
                }}
            }}
        }}
        """
        
        try:
            data = await with_retry(
                self._rate_limited_graphql,
                graphql_query,
                {},
                max_retries=2,
                base_delay=1.0
            )
            
            media = data.get("data", {}).get("Media")
            if not media:
                return None
            
            return self._parse_media(media)
            
        except Exception as e:
            error = classify_error(e, "anilist")
            error.details = {
                "operation": "get_anime_by_id", 
                "anilist_id": anilist_id,
                "mal_id": mal_id
            }
            
            if error.category.value == "not_found":
                logger.info(f"Anime not found on AniList: {anilist_id or mal_id}")
                return None
            
            logger.error(f"AniList fetch failed: {error.message}")
            raise
    
    async def get_batch_anime(
        self, 
        mal_ids: List[int]
    ) -> Dict[int, AnimeMetadata]:
        """
        Get multiple anime by MAL IDs in a single request.
        Useful for batch refreshing.
        """
        if not mal_ids:
            return {}
        
        # Chunk into groups of 50 (API limit)
        chunk_size = 50
        chunks = [mal_ids[i:i + chunk_size] for i in range(0, len(mal_ids), chunk_size)]
        
        all_results = {}
        
        for chunk in chunks:
            graphql_query = """
            query ($idMals: [Int]) {
                Page {
                    media(idMal_in: $idMals, type: ANIME) {
                        id
                        idMal
                        title {
                            romaji
                            english
                            native
                        }
                        description
                        episodes
                        status
                        season
                        seasonYear
                        averageScore
                        popularity
                        genres
                        coverImage {
                            large
                        }
                        nextAiringEpisode {
                            episode
                            airingAt
                        }
                        studios {
                            nodes {
                                name
                            }
                        }
                    }
                }
            }
            """
            
            try:
                data = await with_retry(
                    self._rate_limited_graphql,
                    graphql_query,
                    {"idMals": chunk},
                    max_retries=2,
                    base_delay=1.0
                )
                
                for media in data.get("data", {}).get("Page", {}).get("media", []):
                    metadata = self._parse_media(media)
                    if metadata and metadata.ids.mal_id:
                        all_results[metadata.ids.mal_id] = metadata
                
            except Exception as e:
                logger.warning(f"Batch fetch failed for chunk: {e}")
                continue
        
        return all_results
    
    def _parse_media(self, media: Dict[str, Any]) -> Optional[AnimeMetadata]:
        """Parse AniList media data into normalized model."""
        if not media:
            return None
        
        anilist_id = media.get("id")
        mal_id = media.get("idMal")
        
        if not anilist_id and not mal_id:
            return None
        
        # Parse title info
        title_data = media.get("title", {})
        titles = TitleInfo(
            english=title_data.get("english"),
            japanese=title_data.get("native"),
            romaji=title_data.get("romaji"),
            synonyms=media.get("synonyms", [])
        )
        
        # Parse status
        status_map = {
            "FINISHED": AnimeStatus.FINISHED_AIRING,
            "RELEASING": AnimeStatus.CURRENTLY_AIRING,
            "NOT_YET_RELEASED": AnimeStatus.NOT_YET_AIRED,
            "CANCELLED": AnimeStatus.UNKNOWN,
            "HIATUS": AnimeStatus.CURRENTLY_AIRING
        }
        status = status_map.get(media.get("status"), AnimeStatus.UNKNOWN)
        
        # Parse dates
        start_date = self._parse_anilist_date(media.get("startDate"))
        end_date = self._parse_anilist_date(media.get("endDate"))
        
        # Parse episode info
        next_airing = media.get("nextAiringEpisode")
        episodes = EpisodeInfo(
            aired_episodes=media.get("episodes") or 0,
            total_episodes=media.get("episodes") or 0,
            next_episode_number=next_airing.get("episode") if next_airing else None,
            next_airing_at=datetime.utcfromtimestamp(next_airing["airingAt"]) if next_airing else None
        )
        
        # Parse images
        cover_images = media.get("coverImage", {})
        poster_url = cover_images.get("large") or cover_images.get("medium")
        
        # Parse trailer
        trailer = media.get("trailer", {})
        trailer_url = None
        if trailer.get("site") == "youtube":
            trailer_url = f"https://youtube.com/watch?v={trailer.get('id')}"
        
        # Parse studios
        studios = [
            node.get("name") 
            for node in media.get("studios", {}).get("nodes", [])
            if node.get("name")
        ]
        
        # Parse producers
        producers = [
            node.get("name")
            for node in media.get("producers", {}).get("nodes", [])
            if node.get("name")
        ]
        
        # Parse relations
        relations = []
        for edge in media.get("relations", {}).get("edges", []):
            node = edge.get("node", {})
            if node.get("type") == "ANIME":
                relation_type_str = edge.get("relationType", "").lower()
                relation_map = {
                    "sequel": RelationType.SEQUEL,
                    "prequel": RelationType.PREQUEL,
                    "side_story": RelationType.SIDE_STORY,
                    "spin_off": RelationType.SPIN_OFF,
                    "parent": RelationType.PARENT,
                    "child": RelationType.CHILD,
                    "alternative": RelationType.ALTERNATIVE_VERSION,
                    "summary": RelationType.SUMMARY,
                    "other": RelationType.OTHER
                }
                
                node_titles = node.get("title", {})
                relations.append(FranchiseRelation(
                    ids=SourceIds(
                        anilist_id=node.get("id"),
                        mal_id=node.get("idMal")
                    ),
                    relation_type=relation_map.get(relation_type_str, RelationType.OTHER),
                    title=TitleInfo(
                        english=node_titles.get("english"),
                        romaji=node_titles.get("romaji")
                    ),
                    confidence=0.95 if relation_type_str in ["sequel", "prequel"] else 0.8
                ))
        
        metadata = AnimeMetadata(
            ids=SourceIds(
                anilist_id=anilist_id,
                mal_id=mal_id
            ),
            titles=titles,
            synopsis=media.get("description"),
            genres=media.get("genres", []),
            themes=[t.get("name") for t in media.get("tags", []) if t.get("name")],
            score=media.get("averageScore"),
            popularity=media.get("popularity"),
            rank=media.get("rank"),
            status=status,
            season=media.get("season", "").lower() if media.get("season") else None,
            year=media.get("seasonYear"),
            start_date=start_date,
            end_date=end_date,
            episodes=episodes,
            poster_url=poster_url,
            banner_url=media.get("bannerImage"),
            trailer_url=trailer_url,
            studios=studios,
            producers=producers,
            source_material=media.get("source", "").lower() if media.get("source") else None,
            age_rating=media.get("rating"),
            duration_per_episode=media.get("duration"),
            franchise_relations=relations,
            provenance={
                "metadata": Provenance(
                    source=Source.ANILIST,
                    confidence=1.0,
                    timestamp=datetime.utcnow()
                )
            }
        )
        
        return metadata
    
    def _parse_anilist_date(self, date_dict: Optional[Dict]) -> Optional[datetime]:
        """Parse AniList date format (year, month, day)."""
        if not date_dict:
            return None
        
        year = date_dict.get("year")
        month = date_dict.get("month") or 1
        day = date_dict.get("day") or 1
        
        if not year:
            return None
        
        try:
            return datetime(year, month, day)
        except (ValueError, TypeError):
            return None
