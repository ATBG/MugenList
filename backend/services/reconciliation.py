"""
Metadata Reconciliation Service

Merges and reconciles data from multiple sources (Jikan, AniList, SIMKL)
into a unified, normalized representation.
"""

from typing import List, Optional, Dict, Any, Tuple
from datetime import datetime
import logging

from models.anime import (
    AnimeMetadata, SourceIds, TitleInfo, EpisodeInfo,
    Source, AnimeStatus, FranchiseRelation, Provenance
)

logger = logging.getLogger(__name__)


class FieldPriority:
    """Field priority configuration."""
    
    # Which source to prefer for specific fields
    FIELD_SOURCES = {
        # Descriptive - prefer AniList for rich content
        "synopsis": [Source.ANILIST, Source.JIKAN, Source.SIMKL],
        "genres": [Source.ANILIST, Source.JIKAN, Source.SIMKL],
        "themes": [Source.ANILIST, Source.JIKAN],
        
        # Scoring - prefer AniList (most active community)
        "score": [Source.ANILIST, Source.JIKAN, Source.SIMKL],
        "popularity": [Source.ANILIST, Source.JIKAN, Source.SIMKL],
        "rank": [Source.ANILIST, Source.JIKAN],
        
        # Status - prefer AniList for airing data, Jikan for completion
        "status": [Source.ANILIST, Source.JIKAN, Source.SIMKL],
        "season": [Source.JIKAN, Source.ANILIST, Source.SIMKL],
        "year": [Source.JIKAN, Source.ANILIST, Source.SIMKL],
        
        # Episodes - critical field, prefer AniList for ongoing
        "episodes": [Source.ANILIST, Source.JIKAN, Source.SIMKL],
        "next_airing": [Source.ANILIST],  # Only AniList has this reliably
        
        # Visual - prefer larger images
        "poster_url": [Source.ANILIST, Source.JIKAN, Source.SIMKL],
        "banner_url": [Source.ANILIST, Source.SIMKL],
        
        # Production - prefer Jikan for accuracy
        "studios": [Source.JIKAN, Source.ANILIST, Source.SIMKL],
        "producers": [Source.JIKAN, Source.ANILIST],
        "source_material": [Source.JIKAN, Source.ANILIST],
        
        # Relations - prefer Jikan for completeness
        "franchise_relations": [Source.JIKAN, Source.ANILIST, Source.SIMKL]
    }


class MetadataReconciler:
    """
    Reconciles metadata from multiple sources.
    
    Implements a priority-based merge strategy where fields from
    different sources are selected based on confidence and source reliability.
    """
    
    def __init__(self):
        self.field_priority = FieldPriority()
    
    def reconcile(
        self,
        jikan_data: Optional[AnimeMetadata] = None,
        anilist_data: Optional[AnimeMetadata] = None,
        simkl_data: Optional[AnimeMetadata] = None,
        user_progress: Optional[int] = None,
        user_status: Optional[str] = None
    ) -> AnimeMetadata:
        """
        Reconcile data from all available sources.
        
        Args:
            jikan_data: Data from Jikan/MAL
            anilist_data: Data from AniList
            simkl_data: Data from SIMKL
            user_progress: User's watched episode count (preserved)
            user_status: User's watch status (preserved)
        
        Returns:
            Unified AnimeMetadata with source provenance
        """
        # Collect all available sources
        sources = {
            Source.JIKAN: jikan_data,
            Source.ANILIST: anilist_data,
            Source.SIMKL: simkl_data
        }
        sources = {k: v for k, v in sources.items() if v is not None}
        
        if not sources:
            raise ValueError("At least one data source must be provided")
        
        logger.info(f"Reconciling data from: {[s.value for s in sources.keys()]}")
        
        # Start building merged metadata
        merged = AnimeMetadata()
        provenance = {}
        
        # 1. Merge IDs (union of all IDs)
        merged.ids = self._merge_ids(sources)
        provenance["ids"] = self._build_provenance("ids", sources)
        
        # 2. Merge titles (combine all variants)
        merged.titles = self._merge_titles(sources)
        provenance["titles"] = self._build_provenance("titles", sources)
        
        # 3. Merge descriptive fields
        merged.synopsis = self._select_field("synopsis", sources)
        provenance["synopsis"] = self._build_provenance("synopsis", sources)
        
        merged.genres = self._merge_list_field("genres", sources)
        provenance["genres"] = self._build_provenance("genres", sources)
        
        merged.themes = self._merge_list_field("themes", sources)
        provenance["themes"] = self._build_provenance("themes", sources)
        
        # 4. Merge scoring
        merged.score = self._select_numeric_field("score", sources)
        provenance["score"] = self._build_provenance("score", sources)
        
        merged.popularity = self._select_numeric_field("popularity", sources)
        provenance["popularity"] = self._build_provenance("popularity", sources)
        
        merged.rank = self._select_numeric_field("rank", sources)
        provenance["rank"] = self._build_provenance("rank", sources)
        
        # 5. Merge status and dates
        merged.status = self._select_status(sources)
        provenance["status"] = self._build_provenance("status", sources)
        
        merged.season = self._select_field("season", sources)
        provenance["season"] = self._build_provenance("season", sources)
        
        merged.year = self._select_numeric_field("year", sources)
        provenance["year"] = self._build_provenance("year", sources)
        
        # 6. Merge dates (prefer most specific)
        merged.start_date = self._select_date_field("start_date", sources)
        provenance["start_date"] = self._build_provenance("start_date", sources)
        
        merged.end_date = self._select_date_field("end_date", sources)
        provenance["end_date"] = self._build_provenance("end_date", sources)
        
        # 7. Merge episode info (critical - prefer AniList for airing)
        merged.episodes = self._merge_episodes(sources, user_progress)
        provenance["episodes"] = self._build_provenance("episodes", sources)
        
        # 8. Merge visual
        merged.poster_url = self._select_field("poster_url", sources)
        provenance["poster_url"] = self._build_provenance("poster_url", sources)
        
        merged.banner_url = self._select_field("banner_url", sources)
        provenance["banner_url"] = self._build_provenance("banner_url", sources)
        
        merged.trailer_url = self._select_field("trailer_url", sources)
        provenance["trailer_url"] = self._build_provenance("trailer_url", sources)
        
        # 9. Merge production info
        merged.studios = self._merge_list_field("studios", sources)
        provenance["studios"] = self._build_provenance("studios", sources)
        
        merged.producers = self._merge_list_field("producers", sources)
        provenance["producers"] = self._build_provenance("producers", sources)
        
        merged.licensors = self._merge_list_field("licensors", sources)
        provenance["licensors"] = self._build_provenance("licensors", sources)
        
        merged.source_material = self._select_field("source_material", sources)
        provenance["source_material"] = self._build_provenance("source_material", sources)
        
        # 10. Merge ratings
        merged.age_rating = self._select_field("age_rating", sources)
        provenance["age_rating"] = self._build_provenance("age_rating", sources)
        
        merged.duration_per_episode = self._select_numeric_field(
            "duration_per_episode", sources
        )
        provenance["duration_per_episode"] = self._build_provenance(
            "duration_per_episode", sources
        )
        
        # 11. Merge franchise relations (prefer Jikan)
        merged.franchise_relations = self._merge_relations(sources)
        provenance["franchise_relations"] = self._build_provenance(
            "franchise_relations", sources
        )
        
        # 12. Generate franchise ID
        merged.franchise_id = self._generate_franchise_id(merged.ids)
        
        # 13. Preserve user data
        merged.user_progress = user_progress
        merged.user_status = user_status
        
        # 14. Set metadata
        merged.provenance = provenance
        merged.last_updated = datetime.utcnow()
        merged.last_refreshed = datetime.utcnow()
        
        logger.info(
            f"Reconciliation complete: {merged.titles.get_primary()} "
            f"(MAL: {merged.ids.mal_id}, AniList: {merged.ids.anilist_id})"
        )
        
        return merged
    
    def _merge_ids(self, sources: Dict[Source, AnimeMetadata]) -> SourceIds:
        """Merge IDs from all sources."""
        ids = SourceIds()
        for source, data in sources.items():
            if data.ids.mal_id:
                ids.mal_id = data.ids.mal_id
            if data.ids.anilist_id:
                ids.anilist_id = data.ids.anilist_id
            if data.ids.simkl_id:
                ids.simkl_id = data.ids.simkl_id
        return ids
    
    def _merge_titles(self, sources: Dict[Source, AnimeMetadata]) -> TitleInfo:
        """Merge titles from all sources."""
        all_english = set()
        all_japanese = set()
        all_romaji = set()
        all_synonyms = set()
        
        for data in sources.values():
            if data.titles.english:
                all_english.add(data.titles.english)
            if data.titles.japanese:
                all_japanese.add(data.titles.japanese)
            if data.titles.romaji:
                all_romaji.add(data.titles.romaji)
            all_synonyms.update(data.titles.synonyms)
        
        # Remove duplicates from synonyms
        all_synonyms -= all_english
        all_synonyms -= all_japanese
        all_synonyms -= all_romaji
        
        # Prefer longer, more complete titles
        english = max(all_english, key=len) if all_english else None
        japanese = max(all_japanese, key=len) if all_japanese else None
        romaji = max(all_romaji, key=len) if all_romaji else None
        
        return TitleInfo(
            english=english,
            japanese=japanese,
            romaji=romaji,
            synonyms=list(all_synonyms)[:10]  # Limit to 10 synonyms
        )
    
    def _select_field(
        self, 
        field_name: str, 
        sources: Dict[Source, AnimeMetadata]
    ) -> Optional[Any]:
        """Select a field based on priority."""
        priority = self.field_priority.FIELD_SOURCES.get(
            field_name, 
            [Source.ANILIST, Source.JIKAN, Source.SIMKL]
        )
        
        for source in priority:
            if source in sources:
                value = getattr(sources[source], field_name)
                if value is not None and value != "":
                    return value
        
        return None
    
    def _select_numeric_field(
        self, 
        field_name: str, 
        sources: Dict[Source, AnimeMetadata]
    ) -> Optional[int]:
        """Select a numeric field, preferring higher values for episodes."""
        priority = self.field_priority.FIELD_SOURCES.get(
            field_name,
            [Source.ANILIST, Source.JIKAN, Source.SIMKL]
        )
        
        values = []
        for source in priority:
            if source in sources:
                value = getattr(sources[source], field_name)
                if value is not None and value > 0:
                    values.append((source, value))
        
        if not values:
            return None
        
        # For episode counts, prefer maximum valid value
        # This helps with ongoing series
        if field_name in ["episodes", "total_episodes"]:
            return max(v for _, v in values)
        
        # For other fields, use priority order
        for source in priority:
            for src, val in values:
                if src == source:
                    return val
        
        return values[0][1]
    
    def _select_date_field(
        self, 
        field_name: str, 
        sources: Dict[Source, AnimeMetadata]
    ) -> Optional[datetime]:
        """Select a date field, preferring most specific."""
        priority = [Source.JIKAN, Source.ANILIST, Source.SIMKL]
        
        for source in priority:
            if source in sources:
                value = getattr(sources[source], field_name)
                if value:
                    return value
        
        return None
    
    def _select_status(
        self, 
        sources: Dict[Source, AnimeMetadata]
    ) -> AnimeStatus:
        """Select status, preferring AniList for ongoing accuracy."""
        # Priority: AniList (most up-to-date), then Jikan
        priority = [Source.ANILIST, Source.JIKAN, Source.SIMKL]
        
        for source in priority:
            if source in sources:
                status = sources[source].status
                if status and status != AnimeStatus.UNKNOWN:
                    return status
        
        return AnimeStatus.UNKNOWN
    
    def _merge_list_field(
        self, 
        field_name: str, 
        sources: Dict[Source, AnimeMetadata]
    ) -> List[str]:
        """Merge a list field, deduplicating."""
        seen = set()
        result = []
        
        priority = self.field_priority.FIELD_SOURCES.get(
            field_name,
            [Source.ANILIST, Source.JIKAN, Source.SIMKL]
        )
        
        for source in priority:
            if source in sources:
                items = getattr(sources[source], field_name) or []
                for item in items:
                    normalized = item.lower().strip()
                    if normalized and normalized not in seen:
                        seen.add(normalized)
                        result.append(item)
        
        return result
    
    def _merge_episodes(
        self, 
        sources: Dict[Source, AnimeMetadata],
        user_progress: Optional[int]
    ) -> EpisodeInfo:
        """Merge episode info with special handling for ongoing series."""
        episodes = EpisodeInfo()
        
        # Get episode data from all sources
        anilist_ep = sources.get(Source.ANILIST, AnimeMetadata()).episodes
        jikan_ep = sources.get(Source.JIKAN, AnimeMetadata()).episodes
        simkl_ep = sources.get(Source.SIMKL, AnimeMetadata()).episodes
        
        # Total episodes: prefer maximum valid count
        totals = [e for e in [
            anilist_ep.total_episodes,
            jikan_ep.total_episodes,
            simkl_ep.total_episodes
        ] if e and e > 0]
        
        if totals:
            episodes.total_episodes = max(totals)
        
        # Aired episodes: prefer AniList for ongoing accuracy
        # but ensure it never exceeds user progress
        aired = anilist_ep.aired_episodes or jikan_ep.aired_episodes or 0
        
        # If user has progress, ensure aired >= progress
        if user_progress and user_progress > 0:
            aired = max(aired, user_progress)
        
        episodes.aired_episodes = aired
        
        # Next episode: only AniList reliably provides this
        episodes.next_episode_number = anilist_ep.next_episode_number
        episodes.next_airing_at = anilist_ep.next_airing_at
        
        # Duration: prefer specific per-episode duration
        durations = [e for e in [
            anilist_ep.episode_duration,
            jikan_ep.episode_duration
        ] if e and e > 0]
        
        if durations:
            episodes.episode_duration = max(durations)  # Prefer full episode duration
        
        return episodes
    
    def _merge_relations(
        self, 
        sources: Dict[Source, AnimeMetadata]
    ) -> List[FranchiseRelation]:
        """Merge franchise relations, deduplicating by ID."""
        seen_ids = set()
        merged = []
        
        # Priority: Jikan (most complete), then AniList
        priority = [Source.JIKAN, Source.ANILIST, Source.SIMKL]
        
        for source in priority:
            if source not in sources:
                continue
            
            relations = sources[source].franchise_relations
            for relation in relations:
                # Create unique key
                id_key = (
                    relation.ids.mal_id or 
                    relation.ids.anilist_id or 
                    relation.ids.simkl_id
                )
                
                if id_key and id_key not in seen_ids:
                    seen_ids.add(id_key)
                    merged.append(relation)
        
        # Sort by confidence (high to low)
        merged.sort(key=lambda r: r.confidence, reverse=True)
        
        return merged
    
    def _build_provenance(
        self, 
        field_name: str, 
        sources: Dict[Source, AnimeMetadata]
    ) -> Provenance:
        """Build provenance info for a field."""
        priority = self.field_priority.FIELD_SOURCES.get(
            field_name,
            [Source.ANILIST, Source.JIKAN, Source.SIMKL]
        )
        
        # Find which source was actually used
        used_source = None
        for source in priority:
            if source in sources:
                used_source = source
                break
        
        if not used_source:
            used_source = list(sources.keys())[0]
        
        return Provenance(
            source=used_source,
            confidence=1.0 if used_source == priority[0] else 0.8,
            timestamp=datetime.utcnow()
        )
    
    def _generate_franchise_id(self, ids: SourceIds) -> Optional[str]:
        """Generate a franchise ID from available IDs."""
        # Use the first available ID as franchise identifier
        if ids.mal_id:
            return f"franchise_mal_{ids.mal_id}"
        if ids.anilist_id:
            return f"franchise_anilist_{ids.anilist_id}"
        if ids.simkl_id:
            return f"franchise_simkl_{ids.simkl_id}"
        return None
