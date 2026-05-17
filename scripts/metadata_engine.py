"""
metadata_engine.py — The "Gold-Standard" metadata aggregator for MugelList.
Reconciles Jikan, AniList, and SIMKL data into a single normalized record.

Enhanced to gather every useful metadata field reliably obtainable from the
three API sources.
"""
import logging
import concurrent.futures
from typing import Dict, Any, List, Optional
from datetime import datetime, timezone
from metadata_service import metadata_svc

logger = logging.getLogger(__name__)

class MetadataEngine:
    def __init__(self):
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=5)

    def get_gold_record(self, mal_id: int) -> Dict[str, Any]:
        """Fetch and reconcile data from all sources."""
        mal_id = int(mal_id)
        
        # Parallel fetch
        future_jikan = self.executor.submit(metadata_svc.get_jikan_anime, mal_id)
        future_anilist = self.executor.submit(metadata_svc.get_anilist_media, mal_id)
        future_simkl = self.executor.submit(metadata_svc.get_simkl_anime, mal_id)
        
        jikan = future_jikan.result()
        anilist = future_anilist.result()
        simkl = future_simkl.result()
        
        return self._reconcile(mal_id, jikan, anilist, simkl)

    def _reconcile(self, mal_id: int, jikan: Any, anilist: Any, simkl: Any) -> Dict[str, Any]:
        """Intelligent reconciliation logic — expanded field set."""
        
        record = {
            "mal_id": mal_id,
            "provenance": {},
            "validation_errors": []
        }

        confidence = 1.0
        if not jikan: confidence -= 0.1
        if not anilist: confidence -= 0.1
        if not simkl: confidence -= 0.1

        # ── 1. Titles & Synonyms ──────────────────────────────────
        titles = []
        if jikan:
            titles.append(jikan.get("title"))
            titles.append(jikan.get("title_english"))
        if anilist:
            titles.append(anilist.get("title", {}).get("english"))
            titles.append(anilist.get("title", {}).get("romaji"))
        if simkl:
            titles.append(simkl.get("title"))

        valid_titles = [t for t in titles if t]
        record["title"] = valid_titles[0] if valid_titles else "Unknown Title"
        record["synonyms"] = list(set(valid_titles))
        record["provenance"]["title"] = "jikan" if jikan else ("anilist" if anilist else "simkl")

        # Alternative / native titles
        record["title_english"] = (jikan or {}).get("title_english") or \
                                   (anilist or {}).get("title", {}).get("english") or \
                                   record["title"]
        record["title_romaji"] = (anilist or {}).get("title", {}).get("romaji") or \
                                  (jikan or {}).get("title") or record["title"]
        record["title_native"] = (anilist or {}).get("title", {}).get("native") or \
                                  (jikan or {}).get("title_japanese") or ""
        
        # Synonyms from Jikan
        jikan_synonyms = (jikan or {}).get("title_synonyms", [])
        if jikan_synonyms:
            record["synonyms"] = list(set(record["synonyms"] + jikan_synonyms))

        # ── 2. Synopsis ───────────────────────────────────────────
        synopsis_candidates = [
            (anilist or {}).get("description"),
            (jikan or {}).get("synopsis"),
            (simkl or {}).get("overview"),
        ]
        record["synopsis"] = next((s for s in synopsis_candidates if s), "")
        # Strip HTML from AniList descriptions
        if record["synopsis"] and "<" in record["synopsis"]:
            import re
            record["synopsis"] = re.sub(r'<[^>]+>', '', record["synopsis"]).strip()
        record["provenance"]["synopsis"] = "anilist" if synopsis_candidates[0] else \
                                           ("jikan" if synopsis_candidates[1] else "simkl")

        # ── 3. Genres & Themes ────────────────────────────────────
        genres_set = set()
        if jikan:
            for g in jikan.get("genres", []):
                if isinstance(g, dict): genres_set.add(g.get("name", ""))
                elif isinstance(g, str): genres_set.add(g)
        if anilist and isinstance(anilist.get("genres"), list):
            genres_set.update(anilist["genres"])
        if simkl and isinstance(simkl.get("genres"), list):
            for g in simkl["genres"]:
                if isinstance(g, str): genres_set.add(g)
        genres_set.discard("")
        record["genres"] = sorted(genres_set)

        themes_set = set()
        if jikan:
            for t in jikan.get("themes", []):
                if isinstance(t, dict): themes_set.add(t.get("name", ""))
                elif isinstance(t, str): themes_set.add(t)
        themes_set.discard("")
        record["themes"] = sorted(themes_set)

        # ── 4. Status ─────────────────────────────────────────────
        statuses = []
        if jikan and jikan.get("status"): statuses.append(self._normalize_status(jikan["status"]))
        if anilist and anilist.get("status"): statuses.append(self._normalize_status(anilist["status"]))
        if simkl and simkl.get("status"): statuses.append(self._normalize_status(simkl["status"]))
        
        if len(set(statuses)) > 1:
            confidence -= 0.1

        # Prefer AniList for status as it's often faster with updates
        status = "Unknown"
        if anilist and anilist.get("status"):
            status = self._normalize_status(anilist["status"])
            record["provenance"]["status"] = "anilist"
        elif jikan and jikan.get("status"):
            status = self._normalize_status(jikan["status"])
            record["provenance"]["status"] = "jikan"
        elif simkl and simkl.get("status"):
            status = self._normalize_status(simkl["status"])
            record["provenance"]["status"] = "simkl"
        record["status"] = status

        # ── 5. Episodes (Aired vs Total) ──────────────────────────
        ep_counts = []
        if jikan and jikan.get("episodes"): ep_counts.append(jikan["episodes"])
        if anilist and anilist.get("episodes"): ep_counts.append(anilist["episodes"])
        if simkl and simkl.get("total_episodes"): ep_counts.append(simkl["total_episodes"])
        
        if len(set(ep_counts)) > 1:
            confidence -= 0.2

        total = 0
        if jikan and jikan.get("episodes"):
            total = jikan["episodes"]
            record["provenance"]["total_episodes"] = "jikan"
        elif anilist and anilist.get("episodes"):
            total = anilist["episodes"]
            record["provenance"]["total_episodes"] = "anilist"
        elif simkl and simkl.get("total_episodes"):
            total = simkl["total_episodes"]
            record["provenance"]["total_episodes"] = "simkl"
        record["total_episodes"] = total

        # Aired episodes calculation
        aired = total if status == "Finished Airing" else 0
        if status == "Currently Airing":
            if anilist and anilist.get("nextAiringEpisode"):
                # If next is Ep 13, then 12 have aired
                aired = anilist["nextAiringEpisode"]["episode"] - 1
                record["provenance"]["aired_episodes"] = "anilist"
            elif simkl and simkl.get("last_episode"):
                aired = simkl["last_episode"]
                record["provenance"]["aired_episodes"] = "simkl"
        record["aired_episodes"] = aired

        # Ensure total_episodes is never less than aired (fixes One Piece returning 0)
        if status == "Currently Airing" and total <= aired:
            # If airing, we know there's at least one more episode coming (the next one)
            total = aired + 1 if anilist and anilist.get("nextAiringEpisode") else aired
            record["total_episodes"] = total
            record["provenance"]["total_episodes"] = "calculated"
        elif total < aired:
            total = aired
            record["total_episodes"] = total
            record["provenance"]["total_episodes"] = "calculated"

        # ── 6. Next Airing ────────────────────────────────────────
        record["next_airing"] = None
        if anilist and anilist.get("nextAiringEpisode"):
            record["next_airing"] = {
                "time": anilist["nextAiringEpisode"]["airingAt"] * 1000,
                "episode": anilist["nextAiringEpisode"]["episode"]
            }
            record["provenance"]["next_airing"] = "anilist"

        # ── 7. Score (aggregated) ─────────────────────────────────
        scores = []
        if jikan and jikan.get("score"): scores.append(jikan["score"])
        if anilist and anilist.get("averageScore"):
            scores.append(anilist["averageScore"] / 10.0)
        if simkl and isinstance(simkl.get("ratings"), dict):
            simkl_rating = simkl["ratings"].get("simkl", {}).get("rating")
            if simkl_rating: scores.append(simkl_rating)
        
        record["score"] = round(sum(scores) / len(scores), 2) if scores else 0
        record["provenance"]["score"] = "aggregated"

        # ── 8. Popularity & Rank ──────────────────────────────────
        record["popularity"] = (jikan or {}).get("popularity") or \
                                (anilist or {}).get("popularity")
        record["rank"] = (jikan or {}).get("rank") or \
                          (anilist or {}).get("rankings", [{}])[0].get("rank") if \
                          anilist and isinstance(anilist.get("rankings"), list) and anilist["rankings"] else \
                          (jikan or {}).get("rank")

        # ── 9. Season & Year ──────────────────────────────────────
        record["season"] = (jikan or {}).get("season") or \
                            ((anilist or {}).get("season") or "").lower() or None
        record["year"] = (jikan or {}).get("year") or (anilist or {}).get("seasonYear")

        # ── 10. Poster & Banner ───────────────────────────────────
        record["poster"] = (jikan or {}).get("images", {}).get("jpg", {}).get("large_image_url") or \
                            (anilist or {}).get("coverImage", {}).get("large") if \
                            anilist and isinstance(anilist.get("coverImage"), dict) else \
                            (jikan or {}).get("images", {}).get("jpg", {}).get("large_image_url") or ""
        
        record["banner_url"] = ""
        if anilist and anilist.get("bannerImage"):
            record["banner_url"] = anilist["bannerImage"]

        # ── 11. Studios & Producers ───────────────────────────────
        studios = []
        if jikan:
            for s in jikan.get("studios", []):
                name = s.get("name") if isinstance(s, dict) else s
                if name and name not in studios: studios.append(name)
        if anilist and isinstance(anilist.get("studios"), dict):
            for node in anilist["studios"].get("nodes", []):
                name = node.get("name") if isinstance(node, dict) else None
                if name and name not in studios: studios.append(name)
        record["studios"] = studios

        producers = []
        if jikan:
            for p in jikan.get("producers", []):
                name = p.get("name") if isinstance(p, dict) else p
                if name and name not in producers: producers.append(name)
        record["producers"] = producers

        # ── 12. Source Material ────────────────────────────────────
        record["source_material"] = (jikan or {}).get("source") or \
                                     (anilist or {}).get("source") or ""

        # ── 13. Age Rating ────────────────────────────────────────
        record["age_rating"] = (jikan or {}).get("rating") or ""

        # ── 14. Duration ──────────────────────────────────────────
        duration_str = (jikan or {}).get("duration") or ""
        duration_min = None
        if duration_str:
            import re
            m = re.search(r'(\d+)', duration_str)
            if m: duration_min = int(m.group(1))
        if not duration_min and anilist and anilist.get("duration"):
            duration_min = anilist["duration"]
        record["duration_per_episode"] = duration_min

        # ── 15. Trailer ───────────────────────────────────────────
        record["trailer_url"] = ""
        if jikan and jikan.get("trailer", {}).get("url"):
            record["trailer_url"] = jikan["trailer"]["url"]

        # ── 16. Broadcast info ────────────────────────────────────
        broadcast = {}
        if jikan and isinstance(jikan.get("broadcast"), dict):
            broadcast["day"] = jikan["broadcast"].get("day")
            broadcast["time"] = jikan["broadcast"].get("time")
            broadcast["timezone"] = jikan["broadcast"].get("timezone")
            broadcast["string"] = jikan["broadcast"].get("string")
        record["broadcast"] = broadcast if any(broadcast.values()) else None

        # ── 17. Dates ─────────────────────────────────────────────
        record["start_date"] = None
        record["end_date"] = None
        if jikan and jikan.get("aired"):
            record["start_date"] = jikan["aired"].get("from")
            record["end_date"] = jikan["aired"].get("to")

        # ── 18. Source IDs ────────────────────────────────────────
        record["anilist_id"] = (anilist or {}).get("id")
        record["simkl_id"] = None
        if simkl and isinstance(simkl.get("ids"), dict):
            record["simkl_id"] = simkl["ids"].get("simkl")

        # ── 19. Franchise relations (Jikan) ───────────────────────
        relations = []
        if jikan and isinstance(jikan.get("relations"), list):
            for group in jikan["relations"]:
                rel_type = group.get("relation", "Other")
                for entry in group.get("entry", []):
                    if entry.get("type") == "anime":
                        relations.append({
                            "mal_id": entry.get("mal_id"),
                            "name": entry.get("name"),
                            "relation": rel_type,
                        })
        record["franchise_relations"] = relations

        # ── 20. Source Confidence ─────────────────────────────────
        record["source_confidence"] = round(max(0.0, confidence), 2)

        # ── 21. Validation & Corrections ──────────────────────────
        if record["aired_episodes"] < 0:
            record["aired_episodes"] = 0
            record["validation_errors"].append("Aired episodes cannot be negative")

        if record["aired_episodes"] > record["total_episodes"] and record["total_episodes"] > 0:
            record["validation_errors"].append("Aired episodes exceed total episodes")
            if record["status"] == "Finished Airing":
                record["aired_episodes"] = record["total_episodes"]

        if record["aired_episodes"] > 0 and record["status"] == "Not Yet Aired":
            record["status"] = "Currently Airing"
            record["validation_errors"].append("Status corrected to 'Currently Airing' due to aired episodes > 0")

        if record["total_episodes"] > 0 and record["aired_episodes"] >= record["total_episodes"]:
            if record["status"] != "Finished Airing":
                record["status"] = "Finished Airing"
                record["next_airing"] = None
                record["validation_errors"].append("Status corrected to 'Finished Airing' due to aired >= total")

        if record["next_airing"] and record["next_airing"]["time"]:
            now_ms = datetime.now(timezone.utc).timestamp() * 1000
            if record["next_airing"]["time"] < now_ms:
                record["validation_errors"].append("Next airing time is in the past")

        return record

    def _normalize_status(self, status: str) -> str:
        s = status.upper()
        if s in ["RELEASING", "CURRENTLY AIRING", "AIRING"]: return "Currently Airing"
        if s in ["FINISHED", "COMPLETED", "FINISHED AIRING"]: return "Finished Airing"
        if s in ["NOT_YET_RELEASED", "NOT YET AIRED", "UPCOMING"]: return "Not Yet Aired"
        return "Unknown"

# Singleton
engine = MetadataEngine()
