"""
Caching Utilities

Provides in-memory and file-based caching for API responses.
"""

import json
import pickle
import hashlib
import asyncio
from typing import Optional, Any, Dict
from datetime import datetime, timedelta
from pathlib import Path
from dataclasses import dataclass
import logging

logger = logging.getLogger(__name__)


@dataclass
class CacheEntry:
    """Cache entry with metadata."""
    data: Any
    timestamp: datetime
    ttl_seconds: int
    source: str
    
    def is_expired(self) -> bool:
        """Check if cache entry is expired."""
        age = (datetime.utcnow() - self.timestamp).total_seconds()
        return age > self.ttl_seconds
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for serialization."""
        return {
            "data": self.data,
            "timestamp": self.timestamp.isoformat(),
            "ttl_seconds": self.ttl_seconds,
            "source": self.source
        }


class InMemoryCache:
    """Thread-safe in-memory cache with TTL."""
    
    def __init__(self, default_ttl: int = 3600):
        """
        Initialize cache.
        
        Args:
            default_ttl: Default TTL in seconds (1 hour)
        """
        self._cache: Dict[str, CacheEntry] = {}
        self._default_ttl = default_ttl
        self._lock = asyncio.Lock()
        self._cleanup_task: Optional[asyncio.Task] = None
    
    async def start(self):
        """Start background cleanup task."""
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
    
    async def stop(self):
        """Stop background cleanup task."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None
    
    async def get(self, key: str) -> Optional[Any]:
        """Get value from cache if not expired."""
        async with self._lock:
            entry = self._cache.get(key)
            if not entry:
                return None
            
            if entry.is_expired():
                del self._cache[key]
                return None
            
            return entry.data
    
    async def set(
        self, 
        key: str, 
        value: Any, 
        ttl: Optional[int] = None,
        source: str = "unknown"
    ):
        """Set value in cache."""
        async with self._lock:
            self._cache[key] = CacheEntry(
                data=value,
                timestamp=datetime.utcnow(),
                ttl_seconds=ttl or self._default_ttl,
                source=source
            )
    
    async def delete(self, key: str) -> bool:
        """Delete key from cache."""
        async with self._lock:
            if key in self._cache:
                del self._cache[key]
                return True
            return False
    
    async def clear(self):
        """Clear all cache entries."""
        async with self._lock:
            self._cache.clear()
    
    async def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        async with self._lock:
            total = len(self._cache)
            expired = sum(1 for e in self._cache.values() if e.is_expired())
            return {
                "total_entries": total,
                "expired_entries": expired,
                "active_entries": total - expired
            }
    
    async def _cleanup_loop(self):
        """Background task to clean expired entries."""
        while True:
            try:
                await asyncio.sleep(300)  # Run every 5 minutes
                await self._cleanup_expired()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Cache cleanup error: {e}")
    
    async def _cleanup_expired(self):
        """Remove expired entries."""
        async with self._lock:
            expired_keys = [
                k for k, v in self._cache.items() 
                if v.is_expired()
            ]
            for key in expired_keys:
                del self._cache[key]
            
            if expired_keys:
                logger.debug(f"Cleaned {len(expired_keys)} expired cache entries")


class FileCache:
    """File-based persistent cache."""
    
    def __init__(self, cache_dir: str = "cache"):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
    
    def _get_cache_path(self, key: str) -> Path:
        """Get file path for cache key."""
        # Hash the key to create a safe filename
        hashed = hashlib.md5(key.encode()).hexdigest()
        return self.cache_dir / f"{hashed}.cache"
    
    async def get(self, key: str) -> Optional[Any]:
        """Get value from file cache."""
        async with self._lock:
            path = self._get_cache_path(key)
            if not path.exists():
                return None
            
            try:
                with open(path, 'rb') as f:
                    entry = pickle.load(f)
                
                if entry.is_expired():
                    path.unlink(missing_ok=True)
                    return None
                
                return entry.data
            except Exception as e:
                logger.warning(f"Failed to read cache file: {e}")
                path.unlink(missing_ok=True)
                return None
    
    async def set(
        self, 
        key: str, 
        value: Any, 
        ttl: int = 3600,
        source: str = "unknown"
    ):
        """Set value in file cache."""
        async with self._lock:
            path = self._get_cache_path(key)
            entry = CacheEntry(
                data=value,
                timestamp=datetime.utcnow(),
                ttl_seconds=ttl,
                source=source
            )
            
            try:
                with open(path, 'wb') as f:
                    pickle.dump(entry, f)
            except Exception as e:
                logger.error(f"Failed to write cache file: {e}")
    
    async def delete(self, key: str) -> bool:
        """Delete key from file cache."""
        async with self._lock:
            path = self._get_cache_path(key)
            if path.exists():
                path.unlink()
                return True
            return False
    
    async def clear(self):
        """Clear all file cache entries."""
        async with self._lock:
            for path in self.cache_dir.glob("*.cache"):
                path.unlink(missing_ok=True)


class HybridCache:
    """Combined in-memory and file cache."""
    
    def __init__(
        self, 
        memory_ttl: int = 300,  # 5 minutes
        file_ttl: int = 86400,  # 24 hours
        cache_dir: str = "cache"
    ):
        self.memory = InMemoryCache(default_ttl=memory_ttl)
        self.file = FileCache(cache_dir=cache_dir)
        self.memory_ttl = memory_ttl
        self.file_ttl = file_ttl
    
    async def start(self):
        """Start the cache."""
        await self.memory.start()
    
    async def stop(self):
        """Stop the cache."""
        await self.memory.stop()
    
    async def get(self, key: str) -> Optional[Any]:
        """
        Get from cache.
        
        Strategy:
        1. Check in-memory cache (fast)
        2. If miss, check file cache
        3. If file hit, promote to memory
        """
        # Try memory first
        value = await self.memory.get(key)
        if value is not None:
            return value
        
        # Try file cache
        value = await self.file.get(key)
        if value is not None:
            # Promote to memory
            await self.memory.set(key, value, ttl=self.memory_ttl, source="file_promotion")
            return value
        
        return None
    
    async def set(
        self, 
        key: str, 
        value: Any, 
        ttl: Optional[int] = None,
        source: str = "unknown",
        persist: bool = True
    ):
        """
        Set in cache.
        
        Args:
            key: Cache key
            value: Value to cache
            ttl: TTL in seconds (None uses defaults)
            source: Data source for tracking
            persist: Whether to persist to file cache
        """
        memory_ttl = ttl or self.memory_ttl
        file_ttl = ttl or self.file_ttl
        
        # Always set in memory
        await self.memory.set(key, value, ttl=memory_ttl, source=source)
        
        # Persist to file if requested
        if persist:
            await self.file.set(key, value, ttl=file_ttl, source=source)
    
    async def delete(self, key: str) -> bool:
        """Delete from both caches."""
        memory_deleted = await self.memory.delete(key)
        file_deleted = await self.file.delete(key)
        return memory_deleted or file_deleted
    
    async def clear(self):
        """Clear both caches."""
        await self.memory.clear()
        await self.file.clear()
    
    async def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        return {
            "memory": await self.memory.get_stats(),
            "cache_dir": str(self.file.cache_dir)
        }


def build_cache_key(prefix: str, **params) -> str:
    """
    Build a deterministic cache key.
    
    Args:
        prefix: Key prefix (e.g., "jikan_search", "anilist_anime")
        **params: Parameters to include in key
    """
    # Sort params for consistency
    param_str = json.dumps(params, sort_keys=True, default=str)
    return f"{prefix}:{hashlib.md5(param_str.encode()).hexdigest()}"
