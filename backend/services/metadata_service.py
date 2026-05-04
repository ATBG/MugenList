"""
Main Metadata Service

Orchestrates fetching, caching, and reconciling anime metadata
from all three APIs (Jikan, AniList, SIMKL).
"""

import asyncio
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta
import logging

from api_wrappers.jikan import JikanClient
from api_wrappers.anilist import AniListClient
from api_wrappers.simkl import SIMKLClient
from utils.cache import HybridCache, build_cache_key
from utils.errors import MetadataFetchError, PartialDataError
from models.anime import AnimeMetadata, Source
from services.reconciliation import MetadataReconciler

logger = logging.getLogger(__name__)


class MetadataService:
    """
    Main service for fetching and managing anime metadata.
    
    This is the primary interface for the backend. All metadata
    operations should go through this service.
    """
    
    # Cache TTLs
    SEARCH_CACHE_TTL = 3600  # 1 hour
    DETAIL_CACHE_TTL = 7200  # 2 hours
    BATCH_CACHE_TTL = 1800  # 30 minutes
    
    def __init__(
        self,
        simkl_api_key: Optional[str] = None,
        enable_cache: bool = True
    ):
        self.jikan = JikanClient()
        self.anilist = AniListClient()
        self.simkl = SIMKLClient(api_key=simkl_api_key)
        self.reconciler = MetadataReconciler()
        self.cache = HybridCache() if enable_cache else None
        self.enable_cache = enable_cache
    
    async def __aenter__(self):
        """Initialize service and clients."""
        await self.jikan.__aenter__()
        await self.anilist.__aenter__()
        await self.simkl.__aenter__()
        
        if self.cache:
            await self.cache.start()
        
        logger.info("MetadataService initialized")
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Cleanup resources."""
        await self.simkl.__aexit__(exc_type, exc_val, exc_tb)
        await self.anilist.__aexit__(exc_type, exc_val, exc_tb)
        await self.jikan.__aexit__(exc_type, exc_val, exc_tb)
        
        if self.cache:
            await self.cache.stop()
        
        logger.info("MetadataService shutdown")
    
    async def search_anime(
        self, 
        query: str, 
        page: int = 1, 
        limit: int = 20,
        use_cache: bool = True
    ) -> List[AnimeMetadata]:
        """
        Search anime across all sources.
        
        Strategy:
        1. Check cache
        2. Search AniList (best for popularity sorting)
        3. Search Jikan as fallback
        4. Cache results
        5. Return merged results
        
        Args:
            query: Search query
            page: Page number
            limit: Results per page
            use_cache: Whether to use caching
        
        Returns:
            List of AnimeMetadata (may be empty)
        """
        if not query or not query.strip():
            return []
        
        cache_key = build_cache_key(
            "search",
            query=query.strip(),
            page=page,
            limit=limit
        )
        
        # Check cache
        if use_cache and self.cache:
            cached = await self.cache.get(cache_key)
            if cached:
                logger.debug(f"Cache hit for search: {query}")
                return [AnimeMetadata.from_dict(d) for d in cached]
        
        logger.info(f"Searching for: {query}")
        
        # Fetch from multiple sources in parallel
        results = {}
        errors = []
        
        tasks = [
            self._safe_search("anilist", query, page, limit),
            self._safe_search("jikan", query, page, limit)
        ]
        
        completed, pending = await asyncio.wait(tasks, return_when=asyncio.ALL_COMPLETED)
        
        for task in completed:
            try:
                source, data = task.result()
                if data:
                    results[source] = data
            except Exception as e:
                logger.warning(f"Search task failed: {e}")
                errors.append(e)
        
        if not results:
            if errors:
                raise MetadataFetchError(errors[0])
            return []
        
        # For search results, we return them separately (not merged)
        # as each source may have different ordering
        all_results = []
        seen_ids = set()
        
        # Prefer AniList results (better popularity sorting)
        if "anilist" in results:
            for metadata in results["anilist"]:
                if metadata.ids.mal_id not in seen_ids:
                    seen_ids.add(metadata.ids.mal_id)
                    all_results.append(metadata)
        
        # Add Jikan results for any missing IDs
        if "jikan" in results:
            for metadata in results["jikan"]:
                if metadata.ids.mal_id not in seen_ids:
                    seen_ids.add(metadata.ids.mal_id)
                    all_results.append(metadata)
        
        # Cache results
        if use_cache and self.cache and all_results:
            await self.cache.set(
                cache_key,
                [m.to_dict() for m in all_results],
                ttl=self.SEARCH_CACHE_TTL,
                source="search"
            )
        
        return all_results[:limit]
    
    async def get_anime_by_id(
        self,
        mal_id: Optional[int] = None,
        anilist_id: Optional[int] = None,
        simkl_id: Optional[int] = None,
        use_cache: bool = True,
        fetch_all_sources: bool = True
    ) -> Optional[AnimeMetadata]:
        """
        Get detailed anime metadata by ID.
        
        Strategy:
        1. Check cache
        2. Fetch from available sources
        3. Reconcile and merge data
        4. Cache and return
        
        Args:
            mal_id: MyAnimeList ID
            anilist_id: AniList ID
            simkl_id: SIMKL ID
            use_cache: Whether to use caching
            fetch_all_sources: Whether to fetch from all sources or stop at first hit
        
        Returns:
            AnimeMetadata or None if not found
        """
        # Determine primary ID for caching
        primary_id = mal_id or anilist_id or simkl_id
        if not primary_id:
            raise ValueError("At least one ID must be provided")
        
        cache_key = build_cache_key(
            "detail",
            mal_id=mal_id,
            anilist_id=anilist_id,
            simkl_id=simkl_id
        )
        
        # Check cache
        if use_cache and self.cache:
            cached = await self.cache.get(cache_key)
            if cached:
                logger.debug(f"Cache hit for ID: {primary_id}")
                return AnimeMetadata.from_dict(cached)
        
        logger.info(f"Fetching metadata for: MAL={mal_id}, AniList={anilist_id}")
        
        # Fetch from all sources in parallel
        jikan_data = None
        anilist_data = None
        simkl_data = None
        
        tasks = []
        
        if mal_id:
            tasks.append(self._safe_fetch("jikan_by_mal", mal_id))
            tasks.append(self._safe_fetch("anilist_by_mal", mal_id))
        elif anilist_id:
            tasks.append(self._safe_fetch("anilist_by_id", anilist_id))
        
        if simkl_id:
            tasks.append(self._safe_fetch("simkl_by_id", simkl_id))
        
        if mal_id and not fetch_all_sources:
            # Just fetch Jikan if not requiring all sources
            tasks = [self._safe_fetch("jikan_by_mal", mal_id)]
        
        completed, pending = await asyncio.wait(tasks, return_when=asyncio.ALL_COMPLETED)
        
        for task in completed:
            try:
                source, data = task.result()
                if source == "jikan_by_mal":
                    jikan_data = data
                elif source in ["anilist_by_mal", "anilist_by_id"]:
                    anilist_data = data
                elif source == "simkl_by_id":
                    simkl_data = data
            except Exception as e:
                logger.warning(f"Fetch task failed: {e}")
        
        # Check if we got any data
        if not jikan_data and not anilist_data and not simkl_data:
            logger.info(f"No data found for ID: {primary_id}")
            return None
        
        # Reconcile data from all sources
        try:
            merged = self.reconciler.reconcile(
                jikan_data=jikan_data,
                anilist_data=anilist_data,
                simkl_data=simkl_data
            )
        except Exception as e:
            logger.error(f"Reconciliation failed: {e}")
            # Return first available data as fallback
            merged = jikan_data or anilist_data or simkl_data
        
        # Cache result
        if use_cache and self.cache and merged:
            await self.cache.set(
                cache_key,
                merged.to_dict(),
                ttl=self.DETAIL_CACHE_TTL,
                source="detail"
            )
        
        return merged
    
    async def get_batch_anime(
        self,
        mal_ids: List[int],
        use_cache: bool = True
    ) -> Dict[int, AnimeMetadata]:
        """
        Get multiple anime in a batch operation.
        
        This is optimized for refreshing library entries.
        
        Args:
            mal_ids: List of MAL IDs to fetch
            use_cache: Whether to use caching
        
        Returns:
            Dict mapping MAL ID to AnimeMetadata
        """
        if not mal_ids:
            return {}
        
        logger.info(f"Batch fetching {len(mal_ids)} anime")
        
        results = {}
        
        # Check cache first
        ids_to_fetch = []
        if use_cache and self.cache:
            for mal_id in mal_ids:
                cache_key = build_cache_key("detail", mal_id=mal_id)
                cached = await self.cache.get(cache_key)
                if cached:
                    results[mal_id] = AnimeMetadata.from_dict(cached)
                else:
                    ids_to_fetch.append(mal_id)
        else:
            ids_to_fetch = mal_ids
        
        if not ids_to_fetch:
            return results
        
        logger.info(f"Fetching {len(ids_to_fetch)} from APIs (cached: {len(results)})")
        
        # Use AniList batch endpoint for efficiency
        try:
            anilist_results = await self.anilist.get_batch_anime(ids_to_fetch)
        except Exception as e:
            logger.warning(f"AniList batch failed: {e}")
            anilist_results = {}
        
        # Fetch from Jikan for any missing or to enrich data
        jikan_tasks = []
        for mal_id in ids_to_fetch:
            if mal_id not in anilist_results:
                jikan_tasks.append(self._safe_fetch("jikan_by_mal", mal_id))
        
        jikan_results = {}
        if jikan_tasks:
            completed, _ = await asyncio.wait(jikan_tasks)
            for task in completed:
                try:
                    _, data = task.result()
                    if data and data.ids.mal_id:
                        jikan_results[data.ids.mal_id] = data
                except Exception as e:
                    logger.warning(f"Jikan fetch failed: {e}")
        
        # Merge results
        for mal_id in ids_to_fetch:
            anilist_data = anilist_results.get(mal_id)
            jikan_data = jikan_results.get(mal_id)
            
            if anilist_data or jikan_data:
                try:
                    merged = self.reconciler.reconcile(
                        jikan_data=jikan_data,
                        anilist_data=anilist_data
                    )
                    results[mal_id] = merged
                    
                    # Cache individual result
                    if use_cache and self.cache:
                        cache_key = build_cache_key("detail", mal_id=mal_id)
                        await self.cache.set(
                            cache_key,
                            merged.to_dict(),
                            ttl=self.DETAIL_CACHE_TTL,
                            source="batch"
                        )
                except Exception as e:
                    logger.warning(f"Failed to reconcile {mal_id}: {e}")
                    # Use available data directly
                    fallback = anilist_data or jikan_data
                    if fallback:
                        results[mal_id] = fallback
        
        return results
    
    async def refresh_anime(
        self,
        mal_id: int,
        user_progress: Optional[int] = None,
        force: bool = False
    ) -> Optional[AnimeMetadata]:
        """
        Refresh metadata for a single anime.
        
        This is the method to call for updating airing data,
        episode counts, etc.
        
        Args:
            mal_id: MyAnimeList ID
            user_progress: User's current progress (for episode validation)
            force: Force refresh even if cache is fresh
        
        Returns:
            Updated AnimeMetadata or None
        """
        cache_key = build_cache_key("detail", mal_id=mal_id)
        
        # Check if refresh is needed (unless forced)
        if not force and self.cache:
            cached = await self.cache.get(cache_key)
            if cached:
                # Check age
                cached_time = datetime.fromisoformat(cached.get("last_refreshed", "2000-01-01"))
                age_hours = (datetime.utcnow() - cached_time).total_seconds() / 3600
                
                # If less than 1 hour old, skip
                if age_hours < 1:
                    logger.debug(f"Skipping refresh for {mal_id}, cache fresh ({age_hours:.1f}h)")
                    return AnimeMetadata.from_dict(cached)
        
        logger.info(f"Refreshing metadata for: {mal_id}")
        
        # Fetch fresh data from all sources
        try:
            metadata = await self.get_anime_by_id(
                mal_id=mal_id,
                use_cache=False,  # Don't use cache for refresh
                fetch_all_sources=True
            )
            
            if metadata:
                # Validate episodes against user progress
                if user_progress and user_progress > metadata.episodes.aired_episodes:
                    logger.warning(
                        f"Episode validation: user progress ({user_progress}) > "
                        f"aired ({metadata.episodes.aired_episodes}). Using user progress."
                    )
                    metadata.episodes.aired_episodes = user_progress
                
                # Update refresh count
                metadata.refresh_count += 1
                metadata.last_refreshed = datetime.utcnow()
                
                # Update cache
                if self.cache:
                    await self.cache.set(
                        cache_key,
                        metadata.to_dict(),
                        ttl=self.DETAIL_CACHE_TTL,
                        source="refresh"
                    )
            
            return metadata
            
        except Exception as e:
            logger.error(f"Refresh failed for {mal_id}: {e}")
            return None
    
    async def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        if not self.cache:
            return {"enabled": False}
        
        return {
            "enabled": True,
            **await self.cache.get_stats()
        }
    
    async def clear_cache(self):
        """Clear all cached data."""
        if self.cache:
            await self.cache.clear()
            logger.info("Cache cleared")
    
    # Private helper methods
    
    async def _safe_search(
        self, 
        source: str, 
        query: str, 
        page: int, 
        limit: int
    ) -> tuple:
        """Safely execute search with error handling."""
        try:
            if source == "anilist":
                data = await self.anilist.search_anime(query, page, limit)
                return ("anilist", data)
            elif source == "jikan":
                data = await self.jikan.search_anime(query, page, limit)
                return ("jikan", data)
            elif source == "simkl":
                data = await self.simkl.search_anime(query)
                return ("simkl", data)
        except Exception as e:
            logger.warning(f"{source} search failed: {e}")
            return (source, None)
        
        return (source, None)
    
    async def _safe_fetch(self, operation: str, id_value: int) -> tuple:
        """Safely fetch data with error handling."""
        try:
            if operation == "jikan_by_mal":
                data = await self.jikan.get_anime_by_id(id_value)
                return ("jikan_by_mal", data)
            elif operation == "anilist_by_mal":
                data = await self.anilist.get_anime_by_id(mal_id=id_value)
                return ("anilist_by_mal", data)
            elif operation == "anilist_by_id":
                data = await self.anilist.get_anime_by_id(anilist_id=id_value)
                return ("anilist_by_id", data)
            elif operation == "simkl_by_id":
                data = await self.simkl.get_anime_by_id(simkl_id=id_value)
                return ("simkl_by_id", data)
        except Exception as e:
            logger.warning(f"{operation} failed for {id_value}: {e}")
            return (operation, None)
        
        return (operation, None)


# Singleton instance
_metadata_service: Optional[MetadataService] = None


async def get_metadata_service(
    simkl_api_key: Optional[str] = None
) -> MetadataService:
    """Get or create the metadata service singleton."""
    global _metadata_service
    
    if _metadata_service is None:
        _metadata_service = MetadataService(simkl_api_key=simkl_api_key)
        await _metadata_service.__aenter__()
    
    return _metadata_service
