"""
Background Refresh Scheduler

Manages continuous background refresh of anime metadata.
Runs as a separate worker process or thread.
"""

import asyncio
import logging
from typing import Dict, List, Optional, Set
from datetime import datetime, timedelta
from dataclasses import dataclass
import json

from services.metadata_service import MetadataService, get_metadata_service
from models.anime import AnimeMetadata

logger = logging.getLogger(__name__)


@dataclass
class RefreshJob:
    """Represents a refresh job."""
    mal_id: int
    user_progress: Optional[int]
    priority: int  # Higher = more important
    scheduled_at: datetime
    attempts: int = 0


class RefreshScheduler:
    """
    Continuous background refresh scheduler.
    
    Handles:
    - Periodic refresh of library entries
    - Priority-based scheduling
    - Rate limiting
    - Error tracking
    - Batch processing
    """
    
    # Configuration
    REFRESH_INTERVAL_MINUTES = 30  # Check for work every 30 minutes
    MAX_CONCURRENT_REFRESHES = 3   # Parallel refreshes
    MAX_RETRIES = 3
    STALE_THRESHOLD_HOURS = 24       # Refresh if older than 24 hours
    AIRING_REFRESH_HOURS = 2         # Refresh airing anime every 2 hours
    
    def __init__(self, simkl_api_key: Optional[str] = None):
        self.simkl_api_key = simkl_api_key
        self.service: Optional[MetadataService] = None
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._queue: asyncio.PriorityQueue = asyncio.PriorityQueue()
        self._in_progress: Set[int] = set()
        self._stats = {
            "total_refreshed": 0,
            "failed": 0,
            "skipped": 0,
            "last_run": None
        }
        self._lock = asyncio.Lock()
    
    async def start(self):
        """Start the scheduler."""
        if self._running:
            return
        
        self._running = True
        self.service = await get_metadata_service(self.simkl_api_key)
        
        # Start the main loop
        self._task = asyncio.create_task(self._main_loop())
        
        logger.info("Refresh scheduler started")
    
    async def stop(self):
        """Stop the scheduler."""
        if not self._running:
            return
        
        self._running = False
        
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        
        if self.service:
            await self.service.__aexit__(None, None, None)
        
        logger.info("Refresh scheduler stopped")
    
    async def queue_refresh(
        self, 
        mal_ids: List[int], 
        user_progresses: Optional[Dict[int, int]] = None,
        priority: int = 5
    ):
        """
        Queue anime for refresh.
        
        Args:
            mal_ids: List of MAL IDs to refresh
            user_progresses: Map of MAL ID to user's watched episodes
            priority: Priority (1-10, 10 = highest)
        """
        user_progresses = user_progresses or {}
        
        for mal_id in mal_ids:
            if mal_id not in self._in_progress:
                job = RefreshJob(
                    mal_id=mal_id,
                    user_progress=user_progresses.get(mal_id),
                    priority=priority,
                    scheduled_at=datetime.utcnow()
                )
                # PriorityQueue sorts by first element, so use negative priority
                await self._queue.put((-priority, job))
        
        logger.info(f"Queued {len(mal_ids)} anime for refresh (priority={priority})")
    
    async def refresh_now(
        self, 
        mal_id: int, 
        user_progress: Optional[int] = None
    ) -> Optional[AnimeMetadata]:
        """
        Immediately refresh a single anime.
        Bypasses the queue.
        
        Args:
            mal_id: MyAnimeList ID
            user_progress: User's current progress
        
        Returns:
            Updated metadata or None
        """
        if not self.service:
            raise RuntimeError("Scheduler not started")
        
        async with self._lock:
            if mal_id in self._in_progress:
                logger.debug(f"Refresh already in progress for {mal_id}")
                return None
            
            self._in_progress.add(mal_id)
        
        try:
            logger.info(f"Refreshing anime {mal_id} (immediate)")
            result = await self.service.refresh_anime(
                mal_id=mal_id,
                user_progress=user_progress,
                force=True
            )
            
            if result:
                async with self._lock:
                    self._stats["total_refreshed"] += 1
            
            return result
            
        except Exception as e:
            logger.error(f"Immediate refresh failed for {mal_id}: {e}")
            async with self._lock:
                self._stats["failed"] += 1
            return None
        finally:
            async with self._lock:
                self._in_progress.discard(mal_id)
    
    async def get_stats(self) -> Dict:
        """Get scheduler statistics."""
        async with self._lock:
            return {
                **self._stats,
                "running": self._running,
                "queue_size": self._queue.qsize(),
                "in_progress": len(self._in_progress),
                "in_progress_ids": list(self._in_progress)
            }
    
    async def _main_loop(self):
        """Main scheduler loop."""
        while self._running:
            try:
                # Process any queued jobs
                await self._process_queue()
                
                # Wait before next cycle
                await asyncio.sleep(self.REFRESH_INTERVAL_MINUTES * 60)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.exception("Scheduler loop error")
                await asyncio.sleep(60)  # Wait 1 minute on error
    
    async def _process_queue(self):
        """Process jobs from the queue."""
        if not self.service:
            return
        
        jobs_to_process = []
        
        # Get up to MAX_CONCURRENT_REFRESHES jobs
        for _ in range(self.MAX_CONCURRENT_REFRESHES):
            try:
                # Non-blocking get
                priority, job = self._queue.get_nowait()
                if job.mal_id not in self._in_progress:
                    jobs_to_process.append(job)
                else:
                    # Re-queue with lower priority
                    await self._queue.put((priority + 1, job))
            except asyncio.QueueEmpty:
                break
        
        if not jobs_to_process:
            return
        
        logger.info(f"Processing {len(jobs_to_process)} refresh jobs")
        
        # Process jobs concurrently
        tasks = [
            self._execute_refresh_job(job)
            for job in jobs_to_process
        ]
        
        await asyncio.gather(*tasks, return_exceptions=True)
        
        async with self._lock:
            self._stats["last_run"] = datetime.utcnow().isoformat()
    
    async def _execute_refresh_job(self, job: RefreshJob):
        """Execute a single refresh job."""
        async with self._lock:
            self._in_progress.add(job.mal_id)
        
        try:
            result = await self.service.refresh_anime(
                mal_id=job.mal_id,
                user_progress=job.user_progress,
                force=False  # Respect cache age
            )
            
            if result:
                logger.debug(f"Refreshed {job.mal_id}: {result.titles.get_primary()}")
                async with self._lock:
                    self._stats["total_refreshed"] += 1
            else:
                logger.warning(f"Refresh returned no data for {job.mal_id}")
                async with self._lock:
                    self._stats["skipped"] += 1
                    
        except Exception as e:
            logger.error(f"Refresh failed for {job.mal_id}: {e}")
            
            # Retry logic
            if job.attempts < self.MAX_RETRIES:
                job.attempts += 1
                # Re-queue with lower priority
                await self._queue.put((-(job.priority - 1), job))
                logger.info(f"Re-queued {job.mal_id} for retry (attempt {job.attempts})")
            else:
                async with self._lock:
                    self._stats["failed"] += 1
        finally:
            async with self._lock:
                self._in_progress.discard(job.mal_id)
    
    def calculate_refresh_priority(
        self, 
        anime: AnimeMetadata,
        hours_since_refresh: float
    ) -> int:
        """
        Calculate refresh priority for an anime.
        
        Priority factors:
        - Currently airing (highest)
        - Time since last refresh
        - User progress status
        
        Returns priority 1-10 (10 = highest)
        """
        priority = 5  # Base priority
        
        # Boost for airing anime
        if anime.status.value == "currently_airing":
            priority += 3
            
            # Extra boost if next episode is soon
            if anime.episodes.next_airing_at:
                hours_until = (anime.episodes.next_airing_at - datetime.utcnow()).total_seconds() / 3600
                if 0 < hours_until < 24:
                    priority += 2
        
        # Boost based on staleness
        if hours_since_refresh > 48:
            priority += 2
        elif hours_since_refresh > 24:
            priority += 1
        
        # Boost if user is actively watching
        if anime.user_status == "watching":
            priority += 1
        
        return min(priority, 10)


# Global scheduler instance
_scheduler: Optional[RefreshScheduler] = None


async def get_scheduler(simkl_api_key: Optional[str] = None) -> RefreshScheduler:
    """Get or create the global scheduler instance."""
    global _scheduler
    if _scheduler is None:
        _scheduler = RefreshScheduler(simkl_api_key)
        await _scheduler.start()
    return _scheduler


async def schedule_library_refresh(
    library_data: List[Dict],
    simkl_api_key: Optional[str] = None
) -> Dict:
    """
    Schedule refresh for a library.
    
    Args:
        library_data: List of dicts with 'mal_id', 'user_progress', 'last_refreshed'
        simkl_api_key: SIMKL API key
    
    Returns:
        Stats about scheduled jobs
    """
    scheduler = await get_scheduler(simkl_api_key)
    
    mal_ids = []
    user_progresses = {}
    priorities = {}
    
    for entry in library_data:
        mal_id = entry.get("mal_id")
        if not mal_id:
            continue
        
        mal_ids.append(mal_id)
        
        if entry.get("user_progress"):
            user_progresses[mal_id] = entry["user_progress"]
        
        # Calculate priority based on freshness
        last_refreshed = entry.get("last_refreshed")
        if last_refreshed:
            try:
                last = datetime.fromisoformat(last_refreshed)
                hours = (datetime.utcnow() - last).total_seconds() / 3600
                
                # Higher priority for stale entries
                if hours > 48:
                    priorities[mal_id] = 8
                elif hours > 24:
                    priorities[mal_id] = 6
                else:
                    priorities[mal_id] = 3
            except:
                priorities[mal_id] = 5
        else:
            priorities[mal_id] = 9  # Never refreshed = high priority
    
    # Queue each with its priority
    for mal_id in mal_ids:
        await scheduler.queue_refresh(
            [mal_id],
            {mal_id: user_progresses.get(mal_id)},
            priority=priorities.get(mal_id, 5)
        )
    
    return {
        "scheduled": len(mal_ids),
        "queue_size": scheduler._queue.qsize()
    }
