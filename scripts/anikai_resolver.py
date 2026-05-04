"""
anikai_resolver.py — High-precision AniKai streaming resolver (Prompt 26 Spec).
Features: block-level parsing, fuzzy matching, and season-aware tie-breakers.
"""
import re
import html
import logging
import unicodedata
import difflib
from typing import Optional, Dict, Any, List
from urllib.parse import urljoin, quote_plus
from functools import lru_cache

import requests

logger = logging.getLogger(__name__)

# Configuration
BASE_URL = 'https://anikai.to'
SEARCH_ENDPOINT = f"{BASE_URL}/browser?keyword="

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://anikai.to/',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
}

# Persistent session
session = requests.Session()
session.headers.update(HEADERS)

def is_cjk(text: str) -> bool:
    """Check if a string contains CJK characters."""
    for char in text:
        if 'CJK' in unicodedata.name(char, ''):
            return True
        if 'HIRAGANA' in unicodedata.name(char, ''):
            return True
        if 'KATAKANA' in unicodedata.name(char, ''):
            return True
    return False

def clean_title(text: str) -> str:
    """Standardize title for comparison: lowercase, alphanumeric, no extra spaces."""
    if not text: return ""
    # Unescape and normalize unicode
    s = html.unescape(str(text))
    s = unicodedata.normalize('NFKD', s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    
    # Normalize Roman Numerals for better season matching (e.g., II -> 2)
    s = s.replace(' II', ' 2').replace(' III', ' 3').replace(' IV', ' 4').replace(' V', ' 5')
    
    # Replace non-alphanumeric with space
    s = re.sub(r"[^\w\s]", " ", s.lower())
    # Collapse whitespace
    return " ".join(s.split())

def calculate_confidence(targets: List[str], candidate_title: str, candidate_slug: str, season: Optional[int] = None, target_episodes: Optional[int] = None, candidate_episodes: Optional[int] = None, candidate_data: Dict[str, Any] = {}) -> Dict[str, Any]:
    """Score a candidate against a list of target titles, season, and episode count."""
    
    best_score = 0
    best_reasons = []
    
    # Slugs are like 'one-piece-dk6r' or 'marriagetoxin-1264p'
    c_slug_base = re.sub(r'-[a-z0-9]{4,5}$', '', candidate_slug).replace('-', ' ')
    c1 = clean_title(candidate_title)
    c2 = clean_title(c_slug_base)

    for target in targets:
        if not target: continue
        t = clean_title(target)
        
        current_score = 0
        reasons = []

        # 1. Title matching (Check Title, Slug, and Japanese Title)
        c3 = clean_title(candidate_data.get('jp_title', ''))
        
        if t == c1 or t == c2 or (c3 and t == c3):
            current_score = 100
            reasons.append(f"Exact match with '{target}'")
        elif t in c1 or t in c2 or (c3 and t in c3):
            current_score = 95
            reasons.append(f"Strong overlap with '{target}'")
        else:
            r1 = difflib.SequenceMatcher(None, t, c1).ratio()
            r2 = difflib.SequenceMatcher(None, t, c2).ratio()
            r3 = difflib.SequenceMatcher(None, t, c3).ratio() if c3 else 0
            current_score = int(max(r1, r2, r3) * 100)
            reasons.append(f"Fuzzy match with '{target}' ({current_score}%)")

        if current_score > best_score:
            best_score = current_score
            best_reasons = reasons

    score = best_score
    reasons = best_reasons

    # 2. Episode count matching
    if target_episodes and candidate_episodes:
        if target_episodes == candidate_episodes:
            score = min(100, score + 10)
            reasons.append(f"Episode count matches ({target_episodes})")
        elif abs(target_episodes - candidate_episodes) <= 2:
             score = min(100, score + 5)
             reasons.append(f"Episode count close ({candidate_episodes})")
        else:
            # Only penalize if we are very sure it's a mismatch
            if abs(target_episodes - candidate_episodes) > 10:
                score = max(0, score - 20)
                reasons.append(f"Episode count mismatch: {candidate_episodes} vs {target_episodes}")

    # 3. Season tie-breaker
    if season and season > 1:
        s_str = f"season {season}"
        s_short = f"s{season}"
        if s_str in c1 or s_short in c1 or s_str in c2 or s_short in c2:
            score = min(100, score + 15)
            reasons.append(f"Confirmed Season {season}")
        else:
            m = re.search(r'season\s*(\d+)|s(\d+)', c1 + " " + c2)
            if m:
                try:
                    found_s = int(m.group(1) or m.group(2))
                    if found_s != season:
                        score = max(0, score - 50)
                        reasons.append(f"Season mismatch: Found {found_s} instead of {season}")
                except:
                    pass

    return {'score': score, 'reasons': reasons}

def extract_candidates(html_str: str) -> List[Dict[str, Any]]:
    """Extract anime candidates using robust block-level isolation."""
    candidates = []
    
    # Identify item blocks using the 'aitem' container.
    item_pattern = re.compile(r'class=["\']aitem["\']', re.I)
    matches = list(item_pattern.finditer(html_str))
    
    for i, match in enumerate(matches):
        start = match.end()
        end = matches[i+1].start() if i + 1 < len(matches) else start + 3000
        chunk = html_str[start:end]
        
        href_match = re.search(r'href=["\'](/watch/([^"\']+))["\']', chunk)
        if not href_match:
            continue
            
        href = href_match.group(1)
        slug = href_match.group(2)
        
        # 1. Title Extraction
        title_tag_match = re.search(r'class=["\']title["\'][^>]*data-jp=["\']([^"\']+)["\'][^>]*>(.*?)</a>', chunk, re.S | re.I)
        jp_title = ""
        name = ""
        
        if title_tag_match:
            jp_title = title_tag_match.group(1)
            name = html.unescape(re.sub(r'<[^>]+>', '', title_tag_match.group(2)).strip())
        else:
            # Simple fallback for title
            simple_title_match = re.search(r'class=["\']title["\'][^>]*>(.*?)</a>', chunk, re.S | re.I)
            if simple_title_match:
                name = html.unescape(re.sub(r'<[^>]+>', '', simple_title_match.group(1)).strip())

        if not name:
             name = slug.rsplit('-', 1)[0].replace('-', ' ').title()

        # 2. Episode Extraction
        eps = None
        # Look for the 'info' div which contains sub/dub counts
        info_match = re.search(r'class=["\']info["\'][^>]*>(.*?)</div>', chunk, re.S | re.I)
        if info_match:
            # Prefer 'sub' count, fallback to 'dub' or any number
            sub_match = re.search(r'class=["\']sub["\'][^>]*>(?:<[^>]+>)*(\d+)', info_match.group(1))
            if sub_match:
                eps = int(sub_match.group(1))
            else:
                any_num = re.search(r'(\d+)', info_match.group(1))
                if any_num:
                    eps = int(any_num.group(1))

        candidates.append({
            'href': href,
            'title': name,
            'jp_title': jp_title,
            'slug': slug,
            'episodes': eps
        })

    return candidates

@lru_cache(maxsize=128)
def fetch_anikai_results(query: str) -> str:
    """Fetch search results from AniKai with caching and basic retry."""
    for attempt in range(2):
        try:
            url = f"{SEARCH_ENDPOINT}{quote_plus(query)}"
            r = session.get(url, timeout=20)
            return r.text if r.status_code == 200 else ""
        except Exception as e:
            logger.warning(f"AniKai fetch attempt {attempt+1} failed: {e}")
    return ""

def resolve_anikai_watch(title: str, episode: Optional[int] = None, season: Optional[int] = None, total_episodes: Optional[int] = None, alt_titles: List[str] = []) -> Dict[str, Any]:
    """The master resolver: Takes a title/season and returns the perfect watch URL."""
    if not title:
        return {'url': f"{BASE_URL}/browser", 'confidence': 0, 'error': 'No title provided'}

    all_targets = [title] + alt_titles
    
    # 1. Fetch
    # Construct a high-precision search query
    # Preference: A non-CJK title is much better for URLs and site stability
    search_query = title
    for t in [title] + alt_titles:
        if not is_cjk(t):
            search_query = t
            break
            
    if season and season > 1:
        search_query += f" season {season}"
    
    html_data = fetch_anikai_results(search_query)
    if not html_data:
        # Try a second search if the first one was too specific
        if " season " in search_query:
            html_data = fetch_anikai_results(title)
        
        if not html_data:
            return {'url': f"{SEARCH_ENDPOINT}{quote_plus(search_query)}", 'confidence': 0, 'error': 'Failed to reach AniKai'}

    # 2. Parse and Score
    candidates = extract_candidates(html_data)
    scored = []
    for c in candidates:
        analysis = calculate_confidence(
            all_targets, 
            c['title'], 
            c['slug'], 
            season=season, 
            target_episodes=total_episodes,
            candidate_episodes=c.get('episodes'),
            candidate_data=c
        )
        scored.append({**c, 'confidence': analysis['score'], 'reasons': analysis['reasons']})
    
    scored.sort(key=lambda x: x['confidence'], reverse=True)

    # 3. Result selection
    if scored and scored[0]['confidence'] >= 70:
        best = scored[0]
        final_url = urljoin(BASE_URL, best['href'])
        if episode:
            final_url += f"#ep={episode}"
            
        return {
            'url': final_url,
            'confidence': best['confidence'],
            'slug': best['slug'],
            'matched': best,
            'metadata': {
                'reasons': best['reasons'],
                'season': season,
                'episode': episode,
                'total_episodes': total_episodes
            }
        }

    # 4. Fallback search
    # Use the non-CJK title for the fallback URL too
    fallback_title = title
    for t in [title] + alt_titles:
        if not is_cjk(t):
            fallback_title = t
            break
            
    fallback = f"{SEARCH_ENDPOINT}{quote_plus(fallback_title)}"
    if episode: fallback += f"#ep={episode}"
    return {
        'url': fallback,
        'confidence': scored[0]['confidence'] if scored else 0,
        'matched': scored[0] if scored else None,
        'error': 'Low confidence match'
    }
