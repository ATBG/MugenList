"""
metadata_engine.py — The "Gold-Standard" metadata aggregator for MugelList.
Reconciles Jikan, AniList, and SIMKL data into a single normalized record.
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
        """Intelligent reconciliation logic."""
        
        record = {
            "mal_id": mal_id,
            "provenance": {},
            "validation_errors": []
        }

        confidence = 1.0
        if not jikan: confidence -= 0.1
        if not anilist: confidence -= 0.1
        if not simkl: confidence -= 0.1

        # 1. Titles & Synonyms
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

        # 2. Status
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

        # 3. Episodes (Aired vs Total)
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

        # 4. Next Airing
        record["next_airing"] = None
        if anilist and anilist.get("nextAiringEpisode"):
            record["next_airing"] = {
                "time": anilist["nextAiringEpisode"]["airingAt"] * 1000,
                "episode": anilist["nextAiringEpisode"]["episode"]
            }
            record["provenance"]["next_airing"] = "anilist"

        # 5. Visuals & Score
        record["poster"] = (jikan or {}).get("images", {}).get("jpg", {}).get("large_image_url")
        if not record["poster"] and anilist:
             pass
        
        scores = []
        if jikan and jikan.get("score"): scores.append(jikan["score"])
        if anilist and anilist.get("averageScore"): scores.append(anilist["averageScore"] / 10.0)
        if simkl and simkl.get("ratings", {}).get("simkl", {}).get("rating"): scores.append(simkl["ratings"]["simkl"]["rating"])
        
        record["score"] = sum(scores) / len(scores) if scores else 0
        record["provenance"]["score"] = "aggregated"

        # 6. Season & Year
        record["season"] = (jikan or {}).get("season") or (anilist or {}).get("season")
        record["year"] = (jikan or {}).get("year") or (anilist or {}).get("seasonYear")

        # 7. Source Confidence
        record["source_confidence"] = round(max(0.0, confidence), 2)

        # 8. Validation & Corrections
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
