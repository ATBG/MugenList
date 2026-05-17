"""
MugelList Python Backend API
Handles local file operations and online stream resolution
"""

import os
import re
import json
import subprocess
import sys
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import webbrowser
from typing import List, Dict, Optional, Tuple

# Configuration
ALLOWED_EXTENSIONS = {'.mp4', '.mkv', '.webm', '.avi', '.mov', '.wmv'}
POTPLAYER_PATHS = [
    r"C:\Program Files\PotPlayer\PotPlayerMini64.exe",
    r"C:\Program Files\PotPlayer\PotPlayer64.exe",
    r"C:\Program Files (x86)\PotPlayer\PotPlayerMini64.exe",
    r"C:\Program Files (x86)\PotPlayer\PotPlayer64.exe",
]

class MugelListAPIHandler(BaseHTTPRequestHandler):
    """HTTP request handler for MugelList API"""
    
    def _send_json_response(self, data: dict, status: int = 200):
        """Send JSON response"""
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))
    
    def _send_error(self, message: str, status: int = 400):
        """Send error response"""
        self._send_json_response({'error': message}, status)
    
    def _get_request_data(self):
        """Parse JSON request body"""
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(content_length).decode('utf-8'))
        except Exception as e:
            return None
    
    def do_OPTIONS(self):
        """Handle CORS preflight requests"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def do_GET(self):
        """Handle GET requests"""
        parsed_path = urlparse(self.path)
        path = parsed_path.path
        
        if path == '/api/local/detect_player':
            self._detect_player()
        else:
            self._send_error('Endpoint not found', 404)
    
    def do_POST(self):
        """Handle POST requests"""
        parsed_path = urlparse(self.path)
        path = parsed_path.path
        data = self._get_request_data()
        
        if data is None:
            self._send_error('Invalid JSON body')
            return
        
        if path == '/api/local/pick':
            self._pick_directory(data)
        elif path == '/api/local/scan':
            self._scan_directory(data)
        elif path == '/api/local/play':
            self._play_local_file(data)
        elif path == '/api/anikai/resolve':
            self._resolve_anikai(data)
        else:
            self._send_error('Endpoint not found', 404)
    
    def _detect_player(self):
        """Detect installed video players (PotPlayer)"""
        players = []
        
        for path in POTPLAYER_PATHS:
            if os.path.exists(path):
                players.append({
                    'id': 'potplayer',
                    'name': 'PotPlayer',
                    'path': path
                })
                break  # Found one, no need to check others
        
        self._send_json_response({'players': players})
    
    def _pick_directory(self, data: dict):
        """
        Pick a directory using native file dialog
        Note: This requires tkinter which is standard in Python
        """
        try:
            import tkinter as tk
            from tkinter import filedialog
            
            # Create hidden root window
            root = tk.Tk()
            root.withdraw()
            
            # Ask for directory
            selected_path = filedialog.askdirectory(
                title='Select Anime Folder',
                initialdir=data.get('initialPath', os.path.expanduser('~'))
            )
            
            root.destroy()
            
            if selected_path:
                self._send_json_response({'path': selected_path})
            else:
                self._send_json_response({'path': None})
        except ImportError:
            self._send_error('tkinter not available - cannot open directory picker')
        except Exception as e:
            self._send_error(f'Directory picker failed: {str(e)}')
    
    def _scan_directory(self, data: dict):
        """Scan directory for video files and match episodes"""
        path = data.get('path')
        if not path or not os.path.exists(path):
            self._send_error('Invalid or non-existent path')
            return
        
        try:
            files = self._find_video_files(path)
            self._send_json_response({'files': files})
        except Exception as e:
            self._send_error(f'Scan failed: {str(e)}')
    
    def _find_video_files(self, directory: str) -> List[Dict]:
        """Recursively find video files and extract episode numbers"""
        files = []
        dir_path = Path(directory)
        
        for file_path in dir_path.rglob('*'):
            if file_path.is_file() and file_path.suffix.lower() in ALLOWED_EXTENSIONS:
                episode_info = self._extract_episode_info(file_path.name)
                files.append({
                    'filename': file_path.name,
                    'full_path': str(file_path.absolute()),
                    'episode': episode_info['episode'],
                    'season': episode_info['season'],
                    'confidence': episode_info['confidence']
                })
        
        # Sort by episode number
        files.sort(key=lambda x: (x['episode'] or 999999, x['filename']))
        return files
    
    def _extract_episode_info(self, filename: str) -> Dict:
        """
        Extract episode and season info from filename
        Handles patterns like:
        - S01E01, S1E1
        - Episode 01, Ep 01
        - 01, 1
        - Plain numbers in filename
        """
        episode = None
        season = 1
        confidence = 0
        
        # Normalize filename
        name = filename.lower()
        
        # Pattern 1: S01E01 or S1E1
        match = re.search(r'[sS](\d+)[eE](\d+)', name)
        if match:
            season = int(match.group(1))
            episode = int(match.group(2))
            confidence = 100
            return {'episode': episode, 'season': season, 'confidence': confidence}
        
        # Pattern 2: Episode 01, Ep 01, E01
        match = re.search(r'(?:episode|ep|e)[\s_-]*(\d+)', name)
        if match:
            episode = int(match.group(1))
            confidence = 90
            return {'episode': episode, 'season': season, 'confidence': confidence}
        
        # Pattern 3: Standalone number (e.g., "01 - Title.mkv")
        match = re.search(r'^(\d+)', name)
        if match:
            episode = int(match.group(1))
            confidence = 60
            return {'episode': episode, 'season': season, 'confidence': confidence}
        
        # Pattern 4: Number anywhere in filename (last resort)
        match = re.search(r'(\d+)', name)
        if match:
            num = int(match.group(1))
            # Only consider it an episode if it's reasonable (1-999)
            if 1 <= num <= 999:
                episode = num
                confidence = 40
        
        return {'episode': episode, 'season': season, 'confidence': confidence}
    
    def _play_local_file(self, data: dict):
        """Play a local file using system default or PotPlayer"""
        path = data.get('path')
        player = data.get('player')  # 'potplayer' or None for default
        
        if not path or not os.path.exists(path):
            self._send_error('File not found')
            return
        
        try:
            if player == 'potplayer':
                # Find PotPlayer executable
                potplayer_path = None
                for p in POTPLAYER_PATHS:
                    if os.path.exists(p):
                        potplayer_path = p
                        break
                
                if potplayer_path:
                    subprocess.Popen([potplayer_path, path], shell=True)
                    self._send_json_response({'success': True, 'player': 'potplayer'})
                else:
                    # Fall back to default
                    self._play_with_default(path)
                    self._send_json_response({'success': True, 'player': 'default', 'note': 'PotPlayer not found, used default'})
            else:
                self._play_with_default(path)
                self._send_json_response({'success': True, 'player': 'default'})
        except Exception as e:
            self._send_error(f'Playback failed: {str(e)}')
    
    def _play_with_default(self, path: str):
        """Play file with system default application"""
        if sys.platform == 'win32':
            os.startfile(path)
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', path])
        else:
            subprocess.Popen(['xdg-open', path])
    
    def _resolve_anikai(self, data: dict):
        """
        Resolve AniKai watch URL for given title and episode
        This is a simplified resolver - in production you'd want more sophisticated matching
        """
        title = data.get('title', '')
        episode = data.get('episode')
        
        if not title:
            self._send_error('Title is required')
            return
        
        try:
            # Normalize title for URL
            normalized = self._normalize_title(title)
            
            # Construct AniKai URL
            if episode:
                url = f"https://anikai.to/watch/{normalized}#ep={episode}"
            else:
                url = f"https://anikai.to/watch/{normalized}"
            
            self._send_json_response({
                'url': url,
                'confidence': 85,  # Base confidence for normalized match
                'provider': 'anikai'
            })
        except Exception as e:
            self._send_error(f'Resolution failed: {str(e)}')
    
    def _normalize_title(self, title: str) -> str:
        """Normalize title for URL construction"""
        # Remove special characters, replace spaces with hyphens
        normalized = re.sub(r'[^\w\s-]', '', title.lower())
        normalized = re.sub(r'\s+', '-', normalized).strip('-')
        return normalized
    
    def log_message(self, format, *args):
        """Suppress default logging"""
        pass


def run_server(port: int = 8765):
    """Start the API server"""
    server_address = ('', port)
    httpd = HTTPServer(server_address, MugelListAPIHandler)
    print(f"MugelList API server running on port {port}")
    print(f"Access at http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped")
        httpd.shutdown()


if __name__ == '__main__':
    run_server()
