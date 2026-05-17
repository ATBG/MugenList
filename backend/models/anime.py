"""
Normalized Anime Metadata Model

This module defines the unified internal data model for anime metadata
fetched from Jikan, AniList, and SIMKL APIs.
"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any
from datetime import datetime
from enum import Enum


class Source(str, Enum):
    """Source API enumeration."""
    JIKAN = "jikan"
    ANILIST = "anilist"
    SIMKL = "simkl"
    INTERNAL = "internal"


class AnimeStatus(str, Enum):
    """Normalized anime status."""
    CURRENTLY_AIRING = "currently_airing"
    FINISHED_AIRING = "finished_airing"
    NOT_YET_AIRED = "not_yet_aired"
    UNKNOWN = "unknown"


class RelationType(str, Enum):
    """Franchise relation types."""
    SEQUEL = "sequel"
    PREQUEL = "prequel"
    SIDE_STORY = "side_story"
    SPIN_OFF = "spin_off"
    PARENT = "parent"
    CHILD = "child"
    ALTERNATIVE_VERSION = "alternative_version"
    SUMMARY = "summary"
    OTHER = "other"


@dataclass
class SourceIds:
    """IDs from different sources."""
    mal_id: Optional[int] = None
    anilist_id: Optional[int] = None
    simkl_id: Optional[int] = None
    kitsu_id: Optional[int] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "mal_id": self.mal_id,
            "anilist_id": self.anilist_id,
            "simkl_id": self.simkl_id,
            "kitsu_id": self.kitsu_id
        }


@dataclass
class EpisodeInfo:
    """Episode information."""
    aired_episodes: int = 0
    total_episodes: int = 0
    next_episode_number: Optional[int] = None
    next_airing_at: Optional[datetime] = None
    episode_duration: Optional[int] = None  # in minutes
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "aired_episodes": self.aired_episodes,
            "total_episodes": self.total_episodes,
            "next_episode_number": self.next_episode_number,
            "next_airing_at": self.next_airing_at.isoformat() if self.next_airing_at else None,
            "episode_duration": self.episode_duration
        }


@dataclass
class TitleInfo:
    """Title information with variants."""
    english: Optional[str] = None
    japanese: Optional[str] = None
    romaji: Optional[str] = None
    synonyms: List[str] = field(default_factory=list)
    
    def get_primary(self) -> str:
        """Get primary title (English -> Romaji -> Japanese)."""
        return self.english or self.romaji or self.japanese or "Unknown"
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "english": self.english,
            "japanese": self.japanese,
            "romaji": self.romaji,
            "synonyms": self.synonyms,
            "primary": self.get_primary()
        }


@dataclass
class FranchiseRelation:
    """Franchise relation entry."""
    ids: SourceIds = field(default_factory=SourceIds)
    relation_type: RelationType = RelationType.OTHER
    title: TitleInfo = field(default_factory=TitleInfo)
    confidence: float = 0.0
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "ids": self.ids.to_dict(),
            "relation_type": self.relation_type.value,
            "title": self.title.to_dict(),
            "confidence": self.confidence
        }


@dataclass
class Provenance:
    """Source provenance for a field."""
    source: Source
    confidence: float = 1.0
    timestamp: Optional[datetime] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source.value,
            "confidence": self.confidence,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None
        }


@dataclass
class AnimeMetadata:
    """
    Unified anime metadata model.
    
    This is the internal representation used across the entire backend.
    All API-specific data is normalized into this format.
    """
    # Identifiers
    ids: SourceIds = field(default_factory=SourceIds)
    
    # Titles
    titles: TitleInfo = field(default_factory=TitleInfo)
    
    # Descriptive
    synopsis: Optional[str] = None
    genres: List[str] = field(default_factory=list)
    themes: List[str] = field(default_factory=list)
    
    # Scoring & Popularity
    score: Optional[float] = None
    popularity: Optional[int] = None
    rank: Optional[int] = None
    
    # Status & Airing
    status: AnimeStatus = AnimeStatus.UNKNOWN
    season: Optional[str] = None  # "winter", "spring", "summer", "fall"
    year: Optional[int] = None
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    
    # Episodes
    episodes: EpisodeInfo = field(default_factory=EpisodeInfo)
    
    # Visual
    poster_url: Optional[str] = None
    banner_url: Optional[str] = None
    trailer_url: Optional[str] = None
    
    # Studio & Production
    studios: List[str] = field(default_factory=list)
    producers: List[str] = field(default_factory=list)
    licensors: List[str] = field(default_factory=list)
    source_material: Optional[str] = None  # manga, light_novel, original, etc.
    
    # Rating & Duration
    age_rating: Optional[str] = None  # PG, R, etc.
    duration_per_episode: Optional[int] = None  # minutes
    
    # Franchise
    franchise_relations: List[FranchiseRelation] = field(default_factory=list)
    franchise_id: Optional[str] = None
    
    # Source provenance tracking
    provenance: Dict[str, Provenance] = field(default_factory=dict)
    
    # Metadata management
    last_updated: datetime = field(default_factory=datetime.utcnow)
    last_refreshed: Optional[datetime] = None
    refresh_count: int = 0
    error_count: int = 0
    last_error: Optional[str] = None
    
    # User data (preserved during refreshes)
    user_progress: Optional[int] = None
    user_status: Optional[str] = None  # watching, completed, etc.
    user_score: Optional[float] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "ids": self.ids.to_dict(),
            "titles": self.titles.to_dict(),
            "synopsis": self.synopsis,
            "genres": self.genres,
            "themes": self.themes,
            "score": self.score,
            "popularity": self.popularity,
            "rank": self.rank,
            "status": self.status.value,
            "season": self.season,
            "year": self.year,
            "start_date": self.start_date.isoformat() if self.start_date else None,
            "end_date": self.end_date.isoformat() if self.end_date else None,
            "episodes": self.episodes.to_dict(),
            "poster_url": self.poster_url,
            "banner_url": self.banner_url,
            "trailer_url": self.trailer_url,
            "studios": self.studios,
            "producers": self.producers,
            "licensors": self.licensors,
            "source_material": self.source_material,
            "age_rating": self.age_rating,
            "duration_per_episode": self.duration_per_episode,
            "franchise_relations": [r.to_dict() for r in self.franchise_relations],
            "franchise_id": self.franchise_id,
            "provenance": {k: v.to_dict() for k, v in self.provenance.items()},
            "last_updated": self.last_updated.isoformat(),
            "last_refreshed": self.last_refreshed.isoformat() if self.last_refreshed else None,
            "refresh_count": self.refresh_count,
            "error_count": self.error_count,
            "last_error": self.last_error,
            "user_progress": self.user_progress,
            "user_status": self.user_status,
            "user_score": self.user_score
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AnimeMetadata":
        """Create from dictionary."""
        return cls(
            ids=SourceIds(**data.get("ids", {})),
            titles=TitleInfo(**data.get("titles", {})),
            synopsis=data.get("synopsis"),
            genres=data.get("genres", []),
            themes=data.get("themes", []),
            score=data.get("score"),
            popularity=data.get("popularity"),
            rank=data.get("rank"),
            status=AnimeStatus(data.get("status", "unknown")),
            season=data.get("season"),
            year=data.get("year"),
            start_date=datetime.fromisoformat(data["start_date"]) if data.get("start_date") else None,
            end_date=datetime.fromisoformat(data["end_date"]) if data.get("end_date") else None,
            episodes=EpisodeInfo(**data.get("episodes", {})),
            poster_url=data.get("poster_url"),
            banner_url=data.get("banner_url"),
            trailer_url=data.get("trailer_url"),
            studios=data.get("studios", []),
            producers=data.get("producers", []),
            licensors=data.get("licensors", []),
            source_material=data.get("source_material"),
            age_rating=data.get("age_rating"),
            duration_per_episode=data.get("duration_per_episode"),
            franchise_relations=[
                FranchiseRelation(
                    ids=SourceIds(**r.get("ids", {})),
                    relation_type=RelationType(r.get("relation_type", "other")),
                    title=TitleInfo(**r.get("title", {})),
                    confidence=r.get("confidence", 0.0)
                ) for r in data.get("franchise_relations", [])
            ],
            franchise_id=data.get("franchise_id"),
            provenance={
                k: Provenance(
                    source=Source(v["source"]),
                    confidence=v.get("confidence", 1.0),
                    timestamp=datetime.fromisoformat(v["timestamp"]) if v.get("timestamp") else None
                ) for k, v in data.get("provenance", {}).items()
            },
            last_updated=datetime.fromisoformat(data["last_updated"]) if data.get("last_updated") else datetime.utcnow(),
            last_refreshed=datetime.fromisoformat(data["last_refreshed"]) if data.get("last_refreshed") else None,
            refresh_count=data.get("refresh_count", 0),
            error_count=data.get("error_count", 0),
            last_error=data.get("last_error"),
            user_progress=data.get("user_progress"),
            user_status=data.get("user_status"),
            user_score=data.get("user_score")
        )
