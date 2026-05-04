"""
local_file_resolver.py — Optimized local file discovery and parsing.
Focuses on precision episode extraction and noise removal.
"""
import os
import re
import logging
import subprocess
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

# Patterns to strip for cleaner title matching
NOISE = [
    r'\[.*?\]', r'\(.*?\)', r'1080p|720p|480p', r'x264|x265|h264|hevc',
    r'10bit|8bit', r'aac|flac|mp3', r'bluray|web-dl|webrip|hdtv',
    r'dual[\s-]?audio', r'multi-sub', r'sub[\s-]?ita'
]

# Non-episode content to exclude
EXCLUDE = r'OP|Opening|ED|Ending|Trailer|PV|Preview|OST|Soundtrack|Special|Extra|OVA|OAD'

class LocalFileResolver:
    def __init__(self):
        self.players = self._find_players()

    def _find_players(self) -> List[Dict[str, str]]:
        """Identify common high-performance video players on Windows."""
        paths = [
            r"C:\Program Files\DAUM\PotPlayer\PotPlayer64.exe",
            r"C:\Program Files\DAUM\PotPlayer\PotPlayerMini64.exe",
            r"C:\Program Files (x86)\DAUM\PotPlayer\PotPlayer.exe",
            r"C:\Program Files (x86)\DAUM\PotPlayer\PotPlayerMini.exe",
            r"C:\Program Files\PotPlayer\PotPlayerMini64.exe",
            r"C:\Program Files\PotPlayer\PotPlayer64.exe",
        ]
        found = []
        for p in paths:
            if os.path.exists(p):
                found.append({'id': 'potplayer', 'label': 'PotPlayer', 'path': os.path.abspath(p)})
        return found

    def scan_directory(self, path: str, mal_id: Optional[int] = None) -> List[Dict[str, Any]]:
        """Recursively scan a directory for valid anime episodes."""
        if not os.path.exists(path): return []
        
        results = []
        for root, _, files in os.walk(path):
            for f in files:
                # Filter by video extensions
                if f.lower().endswith(('.mkv', '.mp4', '.avi', '.mov', '.flv')):
                    # Skip noise/meta files
                    if re.search(EXCLUDE, f, re.I): continue
                    
                    parsed = self.parse_filename(f)
                    if parsed:
                        parsed['full_path'] = os.path.abspath(os.path.join(root, f))
                        results.append(parsed)
        
        # Sort by season then episode
        results.sort(key=lambda x: (x['season'], x['episode']))
        return results

    def parse_filename(self, filename: str) -> Optional[Dict[str, Any]]:
        """Extract title hint, season, and episode with high precision."""
        base = os.path.splitext(filename)[0]
        
        # Clean noise tags
        clean = base
        for p in NOISE: clean = re.sub(p, '', clean, flags=re.I)
        clean = clean.strip()
        
        # 1. Season detection
        season = 1
        s_match = re.search(r'S(\d+)|Season\s*(\d+)', clean, re.I)
        if s_match:
            season = int(s_match.group(1) or s_match.group(2))
            
        # 2. Episode detection (High Precision Ordering)
        ep = None
        # Pattern 1: S01E05 or just E05
        m = re.search(r'(?:S\d+)?E(\d+)\b', clean, re.I)
        # Pattern 2: Episode 05 or Ep 05
        if not m: m = re.search(r'(?:Episode|Ep)\s*(\d+)', clean, re.I)
        # Pattern 3: " - 05 " (Common fansub style)
        if not m: m = re.search(r'[\s\-_](\d{1,3})[\s\-_]', clean)
        # Pattern 4: Standalone number before extension (at the end)
        if not m: m = re.search(r'\b(\d{1,3})$', clean)
            
        if m:
            val = int(m.group(1))
            # Safety check: avoid matching years as episode numbers
            if val < 1900 or val > 2100:
                ep = val
        
        if ep is None: return None
        
        return {
            'filename': filename,
            'episode': ep,
            'season': season,
            'clean_title': clean.split('-')[0].strip()
        }

    def play_file(self, file_path: str, player: Optional[str] = None):
        """Launches the file in a detected player or system default."""
        if not os.path.exists(file_path): return
        
        player_bin = None
        if player == 'potplayer' and self.players:
            player_bin = self.players[0]['path']
            
        try:
            if player_bin:
                subprocess.Popen([player_bin, file_path], shell=False)
            else:
                # System default
                if os.name == 'nt':
                    os.startfile(file_path)
                else:
                    subprocess.Popen(['xdg-open', file_path])
        except Exception as e:
            logger.error(f"Playback error: {e}")

# Singleton
local_resolver = LocalFileResolver()
