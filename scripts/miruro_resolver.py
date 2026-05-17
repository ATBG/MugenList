"""
miruro_resolver.py — High-precision Miruro Online watch link resolver.
Resolves AniList IDs and canonical slugs to build and validate Miruro TV links.
"""
import re
import html
import logging
import unicodedata
import difflib
from typing import Optional, Dict, Any, List
from urllib.parse import quote_plus
import requests

logger = logging.getLogger("MugelList-MiruroResolver")

ANILIST_URL = 'https://graphql.anilist.co'

# Simple in-memory caches to minimize external network requests
search_cache: Dict[str, List[Dict[str, Any]]] = {}
watch_url_cache: Dict[tuple, Dict[str, Any]] = {}

def get_db_cache(key: str) -> Optional[Any]:
    """Retrieve an item from the SQLite api_cache table if not expired."""
    import json
    import time
    from sqlite_store import get_connection
    try:
        conn = get_connection()
        try:
            cur = conn.execute("SELECT payload, expires_at FROM api_cache WHERE key = ?", (key,))
            row = cur.fetchone()
            if row:
                payload, expires_at = row
                if expires_at is None or expires_at > int(time.time()):
                    return json.loads(payload)
                else:
                    # Cache expired, remove it from the DB
                    conn.execute("DELETE FROM api_cache WHERE key = ?", (key,))
                    conn.commit()
            return None
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"Error reading DB api_cache for {key}: {e}")
        return None

def set_db_cache(key: str, payload: Any, ttl_seconds: Optional[int] = None) -> None:
    """Save an item persistently in the SQLite api_cache table."""
    import json
    import time
    from sqlite_store import get_connection
    try:
        conn = get_connection()
        try:
            expires_at = int(time.time() + ttl_seconds) if ttl_seconds else None
            val = json.dumps(payload)
            with conn:
                conn.execute(
                    "INSERT INTO api_cache(key, payload, expires_at, updated_at) VALUES(?, ?, ?, CURRENT_TIMESTAMP) "
                    "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at, updated_at=CURRENT_TIMESTAMP",
                    (key, val, expires_at)
                )
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"Error writing DB api_cache for {key}: {e}")

def clean_title(text: str) -> str:
    """Standardize title for comparison: lowercase, alphanumeric, no extra spaces."""
    if not text:
        return ""
    # Unescape HTML entities and normalize unicode
    s = html.unescape(str(text))
    s = unicodedata.normalize('NFKD', s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    
    # Normalize Roman Numerals for better season matching
    s = s.replace(' II', ' 2').replace(' III', ' 3').replace(' IV', ' 4').replace(' V', ' 5')
    
    # Replace non-alphanumeric with space
    s = re.sub(r"[^\w\s]", " ", s.lower())
    # Collapse multiple spaces
    return " ".join(s.split())

def slugify(title: str) -> str:
    """Generate a clean lowercase URL slug from the title, matching Miruro's patterns."""
    if not title:
        return ""
    # Remove apostrophes first (e.g. Can't -> cant)
    s = title.replace("'", "")
    # Remove non-alphanumeric, non-space, non-dash characters
    s = re.sub(r'[^a-zA-Z0-9\s-]', '', s)
    # Replace spaces and underscores with dashes
    s = re.sub(r'[\s_]+', '-', s)
    # Clean up consecutive dashes
    s = re.sub(r'-+', '-', s)
    return s.lower().strip('-')

def search_anilist_candidates(query: str, anilist_id: Optional[int] = None) -> List[Dict[str, Any]]:
    """Query AniList GraphQL API for candidate matches by title query or ID lookup with persistent cache."""
    cache_key = f"id_{anilist_id}" if anilist_id else f"query_{clean_title(query)}"
    db_key = f"miruro:search:{cache_key}"
    
    # Priority 1: In-memory cache
    if cache_key in search_cache:
        logger.info(f"Using cached in-memory AniList search results for key: {cache_key}")
        return search_cache[cache_key]

    # Priority 2: Persistent SQLite DB cache
    cached_val = get_db_cache(db_key)
    if cached_val is not None:
        logger.info(f"Using persistent SQLite DB cache for AniList search key: {cache_key}")
        search_cache[cache_key] = cached_val
        return cached_val

    graphql_query = """
    query ($id: Int, $search: String) {
      Page (page: 1, perPage: 10) {
        media (id: $id, search: $search, type: ANIME) {
          id
          title {
            romaji
            english
            native
          }
          synonyms
          episodes
          season
          seasonYear
          status
        }
      }
    }
    """
    
    variables = {}
    if anilist_id:
        variables['id'] = int(anilist_id)
    else:
        variables['search'] = query

    try:
        r = requests.post(ANILIST_URL, json={'query': graphql_query, 'variables': variables}, timeout=15)
        r.raise_for_status()
        res_data = r.json()
        medias = res_data.get('data', {}).get('Page', {}).get('media', [])
        
        # Cache the fetched candidates in both memory and DB (TTL = 7 days)
        search_cache[cache_key] = medias
        set_db_cache(db_key, medias, ttl_seconds=604800)
        return medias
    except Exception as e:
        logger.error(f"AniList GraphQL query failed for query='{query}', id={anilist_id}: {e}")
        return []

def score_candidate(
    candidate: Dict[str, Any],
    target_title: str,
    alt_titles: List[str],
    season: Optional[int] = None,
    episode: Optional[int] = None,
    total_episodes: Optional[int] = None
) -> Dict[str, Any]:
    """Score an AniList candidate match against targets, season, and episode constraints."""
    reasons = []
    score = 0

    c_titles = [
        candidate.get('title', {}).get('english'),
        candidate.get('title', {}).get('romaji'),
        candidate.get('title', {}).get('native')
    ]
    c_synonyms = candidate.get('synonyms', []) or []
    all_candidate_titles = [t for t in c_titles + c_synonyms if t]
    
    all_targets = [target_title] + alt_titles
    all_targets = [t for t in all_targets if t]

    # 1. Title Similarity (0 to 60 points)
    best_title_sim = 0.0
    matched_target = ""
    matched_cand = ""
    for target in all_targets:
        clean_target = clean_title(target)
        for cand in all_candidate_titles:
            clean_cand = clean_title(cand)
            if clean_target == clean_cand:
                sim = 1.0
            else:
                sim = difflib.SequenceMatcher(None, clean_target, clean_cand).ratio()
            
            if sim > best_title_sim:
                best_title_sim = sim
                matched_target = target
                matched_cand = cand

    title_points = int(best_title_sim * 60)
    score += title_points
    reasons.append(f"Title similarity: {title_points}/60 (Best match: '{matched_target}' vs '{matched_cand}')")

    # 2. Season Alignment (0 to 30 points)
    if season:
        target_s_str = f"season {season}"
        target_s_short = f"s{season}"
        target_s_ordinal = f"{season}nd" if season == 2 else f"{season}rd" if season == 3 else f"{season}st" if season == 1 else f"{season}th"
        target_s_ord_str = f"{target_s_ordinal} season"

        found_correct_season = False
        for cand in all_candidate_titles:
            cc = clean_title(cand)
            if target_s_str in cc or target_s_short in cc or target_s_ord_str in cc:
                found_correct_season = True
                break

        if found_correct_season:
            score += 30
            reasons.append(f"Season matches target season {season} in titles: +30")
        else:
            # Check for a different season number (mismatch)
            has_different_season = False
            detected_season = None
            for cand in all_candidate_titles:
                cc = clean_title(cand)
                m = re.search(r'season\s*(\d+)|\bs(\d+)\b|(\d+)(?:st|nd|rd|th)\s*season', cc, re.I)
                if m:
                    found_s = int(m.group(1) or m.group(2) or m.group(3))
                    if found_s != season:
                        has_different_season = True
                        detected_season = found_s
                        break
            
            if has_different_season:
                score -= 40
                reasons.append(f"Season mismatch: Found season {detected_season} in candidate title, expected {season}: -40")
            else:
                if season == 1:
                    score += 15
                    reasons.append("Implicit Season 1 assumed: +15")
                else:
                    reasons.append(f"Target is season {season} but no season info found in candidate titles: 0/30")

    # 3. Episode Range Alignment (0 to 10 points)
    cand_episodes = candidate.get('episodes')
    if episode and cand_episodes:
        if episode <= cand_episodes:
            score += 10
            reasons.append(f"Episode {episode} is within range of total episodes ({cand_episodes}): +10")
        else:
            status = candidate.get('status')
            if status == 'RELEASING' or status == 'NOT_YET_RELEASED':
                score += 5
                reasons.append(f"Episode {episode} exceeds candidate count ({cand_episodes}) but show is {status}: +5")
            else:
                score -= 30
                reasons.append(f"Episode {episode} exceeds completed candidate episodes ({cand_episodes}): -30")

    # 4. Total Episodes Similarity (0 to 10 points bonus)
    if total_episodes and cand_episodes:
        if total_episodes == cand_episodes:
            score += 10
            reasons.append(f"Total episodes matches candidate total ({cand_episodes}): +10")
        elif abs(total_episodes - cand_episodes) <= 2:
            score += 5
            reasons.append(f"Total episodes close to candidate total ({cand_episodes} vs {total_episodes}): +5")

    score = max(0, min(100, score))
    return {'score': score, 'reasons': reasons}

def validate_miruro_url(url: str) -> bool:
    """Validate if the watch URL is active and not a home page fallback/404."""
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        r = requests.get(url, headers=headers, timeout=8)
        if r.status_code != 200:
            return False
        
        # Parse <title> to differentiate standard watch page from fallback home page
        title_match = re.search(r'<title>(.*?)</title>', r.text, re.I)
        if title_match:
            page_title = title_match.group(1).strip()
            # Valid watch pages have titles starting with "Watch "
            if page_title.startswith("Watch "):
                return True
        return False
    except Exception as e:
        logger.error(f"Error validating Miruro URL {url}: {e}")
        return False

def resolve_miruro_link(
    title: str,
    episode: Optional[int] = None,
    season: Optional[int] = None,
    total_episodes: Optional[int] = None,
    alt_titles: List[str] = [],
    anilist_id: Optional[int] = None
) -> Dict[str, Any]:
    """The master online resolver for Miruro. Uses title search or primary key lookup with persistent cache."""
    cache_key = (title, season, episode, anilist_id)
    db_key = f"miruro:watch:{slugify(title)}:s{season or 1}:ep{episode or 1}:id{anilist_id or 0}"

    # Priority 1: In-memory cache
    if cache_key in watch_url_cache:
        logger.info(f"Using cached in-memory watch URL for: {cache_key}")
        return watch_url_cache[cache_key]

    # Priority 2: Persistent SQLite DB cache
    cached_val = get_db_cache(db_key)
    if cached_val is not None:
        logger.info(f"Using persistent SQLite DB cache for resolved watch URL of: {title}")
        watch_url_cache[cache_key] = cached_val
        return cached_val

    logger.info(f"Resolving Miruro for title='{title}', season={season}, episode={episode}, anilist_id={anilist_id}")
    
    candidates = []
    
    # 1. Primary key lookup using known AniList ID
    if anilist_id:
        logger.info(f"Performing primary key lookup for AniList ID: {anilist_id}")
        candidates = search_anilist_candidates("", anilist_id=anilist_id)
    
    # 2. Title lookup fallback
    if not candidates:
        logger.info(f"Performing title search on AniList for: {title}")
        candidates = search_anilist_candidates(title)
        
        if not candidates and alt_titles:
            for alt in alt_titles:
                if alt:
                    logger.info(f"Performing fallback title search for alt title: {alt}")
                    candidates = search_anilist_candidates(alt)
                    if candidates:
                        break

    if not candidates:
        return {
            'url': f"https://www.miruro.tv/search?query={quote_plus(title)}",
            'confidence': 0,
            'reasons': ["No candidates found on AniList matching titles or ID."],
            'error': "Anime not found on AniList"
        }

    # 3. Score and rank candidates
    scored_candidates = []
    for cand in candidates:
        analysis = score_candidate(
            candidate=cand,
            target_title=title,
            alt_titles=alt_titles,
            season=season,
            episode=episode,
            total_episodes=total_episodes
        )
        scored_candidates.append({
            'candidate': cand,
            'score': analysis['score'],
            'reasons': analysis['reasons']
        })

    scored_candidates.sort(key=lambda x: x['score'], reverse=True)
    best_match = scored_candidates[0]
    best_cand = best_match['candidate']
    confidence = best_match['score']
    reasons = best_match['reasons']

    # 4. Build and Validate Watch URL
    slug_base = best_cand.get('title', {}).get('romaji') or best_cand.get('title', {}).get('english') or title
    slug = slugify(slug_base)
    cand_id = best_cand['id']
    
    resolved_url = f"https://www.miruro.tv/watch/{cand_id}/{slug}"
    
    logger.info(f"Validating watch URL on Miruro: {resolved_url}")
    is_valid = validate_miruro_url(resolved_url)
    
    if is_valid:
        reasons.append("Watch URL validated successfully on Miruro.")
    else:
        # Fallback: Try slugified English title if it's different
        eng_title = best_cand.get('title', {}).get('english')
        if eng_title and eng_title != slug_base:
            alt_slug = slugify(eng_title)
            alt_url = f"https://www.miruro.tv/watch/{cand_id}/{alt_slug}"
            logger.info(f"Romaji slug failed, trying English slug validation: {alt_url}")
            if validate_miruro_url(alt_url):
                resolved_url = alt_url
                slug = alt_slug
                is_valid = True
                reasons.append("Watch URL validated using English title slug on Miruro.")
        
        if not is_valid:
            confidence = max(0, confidence - 30)
            reasons.append("Warning: Could not validate watch URL on Miruro TV. URL might still work, but confidence is degraded.")

    # 5. Append Episode Selector
    final_url = resolved_url
    if episode:
        final_url += f"?ep={episode}"

    result = {
        'url': final_url,
        'confidence': confidence,
        'anilist_id': cand_id,
        'slug': slug,
        'title': best_cand.get('title', {}).get('english') or best_cand.get('title', {}).get('romaji'),
        'reasons': reasons,
        'validated': is_valid
    }

    # Cache locally and persistently for 14 days on successful resolution
    if confidence >= 70:
        watch_url_cache[cache_key] = result
        set_db_cache(db_key, result, ttl_seconds=1209600)
        
    return result
