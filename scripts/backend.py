"""
backend.py — Unified local server for MugelList.
Serves the frontend static files and provides the JSON API.

This is THE single entry point. No other server script is needed.
Start with: python scripts/backend.py
"""
import os
import sys
import json
import logging
import threading
from typing import Optional, Dict, Any

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import requests

# ---------------------------------------------------------------------------
# Path setup — allow importing sibling modules inside scripts/
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from resolver_service import build_relation_cluster
from anikai_resolver import resolve_anikai_watch
from metadata_service import metadata_svc
from metadata_engine import engine
from local_file_resolver import local_resolver
from miruro_resolver import resolve_miruro_link
from sqlite_store import init_db, backup_db, verify_integrity, attempt_repair
from add_anime_service import search_anime, get_franchise_relations, save_franchise_bundle
from refresh_backend_service import refresh_single, refresh_batch, auto_refresh

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("MugelList-Backend")

# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)
CORS(app)  # Permissive for local-first; unified serving avoids CORS anyway

# Project root is one directory above scripts/
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(ROOT_DIR, 'data')
SETTINGS_PATH = os.path.join(DATA_DIR, 'settings.json')

# ===================================================================
#  Static File Serving
# ===================================================================

@app.route('/')
def index():
    return send_from_directory(ROOT_DIR, 'index.html')


@app.route('/<path:path>')
def static_proxy(path):
    """Serve any file from the project root.
    Security note: send_from_directory already refuses paths that escape ROOT_DIR.
    """
    return send_from_directory(ROOT_DIR, path)

# ===================================================================
#  Health / Status
# ===================================================================

@app.route('/api/status', methods=['GET'])
def api_status():
    return jsonify({
        'status': 'ok',
        'version': '2.1.0',
        'service': 'MugelList Unified Backend',
        'port': PORT,
    })

# ===================================================================
#  Settings API
# ===================================================================

def _load_settings() -> Dict[str, Any]:
    """Read settings.json from disk."""
    if not os.path.exists(SETTINGS_PATH):
        return {}
    try:
        with open(SETTINGS_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.error('Failed to read settings: %s', e)
        return {}


def _save_settings(data: Dict[str, Any]) -> None:
    """Write settings.json to disk atomically."""
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = SETTINGS_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, SETTINGS_PATH)


@app.route('/api/settings', methods=['GET'])
def get_settings():
    return jsonify(_load_settings())


@app.route('/api/settings', methods=['PUT', 'PATCH'])
def update_settings():
    payload = request.get_json(force=True, silent=True) or {}
    current = _load_settings()
    current.update(payload)
    _save_settings(current)
    return jsonify(current)

# ===================================================================
#  Database Management
# ===================================================================

@app.route('/api/db/backup', methods=['POST'])
def api_db_backup():
    try:
        path = backup_db()
        return jsonify({'status': 'ok', 'path': path})
    except Exception as e:
        logger.error('Backup failed: %s', e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/db/integrity', methods=['GET'])
def api_db_integrity():
    try:
        ok = verify_integrity()
        return jsonify({'ok': ok})
    except Exception as e:
        logger.error('Integrity check failed: %s', e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/db/repair', methods=['POST'])
def api_db_repair():
    try:
        ok = attempt_repair()
        return jsonify({'repaired': ok})
    except Exception as e:
        logger.error('Repair failed: %s', e)
        return jsonify({'error': str(e)}), 500

# ===================================================================
#  Franchise / Relation Resolution
# ===================================================================

@app.route('/api/resolve', methods=['POST'])
def resolve_franchise():
    payload = request.get_json(force=True, silent=True) or {}
    id_mal = payload.get('idMal')
    if not id_mal:
        return jsonify({'error': 'idMal required'}), 400

    max_depth = int(payload.get('maxDepth', 4))
    try:
        cluster = build_relation_cluster(id_mal, max_depth)
        return jsonify(cluster)
    except Exception as e:
        logger.error('Franchise resolution failed: %s', e)
        return jsonify({'error': str(e)}), 500

# ===================================================================
#  AniKai Resolver
# ===================================================================

# ===================================================================
#  Miruro / Online Resolver
# ===================================================================

@app.route('/api/online/resolve', methods=['POST'])
@app.route('/api/anikai/resolve', methods=['POST'])
def resolve_online():
    payload = request.get_json(force=True, silent=True) or {}
    title = payload.get('title')
    episode = payload.get('episode')
    season = payload.get('season')
    total_episodes = payload.get('total_episodes')
    alt_titles = payload.get('alt_titles', [])
    anilist_id = payload.get('anilist_id')

    if not title:
        return jsonify({'error': 'title required'}), 400

    logger.info('Resolving online stream for: %s, season: %s, episode: %s, anilist_id: %s', 
                title, season, episode, anilist_id)

    try:
        import time
        start_time = time.time()
        result = resolve_miruro_link(
            title=title, 
            episode=episode, 
            season=season, 
            total_episodes=total_episodes, 
            alt_titles=alt_titles,
            anilist_id=anilist_id
        )
        duration = time.time() - start_time
        
        confidence = result.get('confidence', 0)
        logger.info('Miruro resolution: title="%s", conf=%s%%, time=%.2fs, url=%s', 
                    title, confidence, duration, result.get('url', 'N/A'))
        
        return jsonify(result)
    except requests.exceptions.Timeout:
        logger.error('Miruro resolution timed out')
        return jsonify({'error': 'Request timed out. Miruro/AniList may be slow or unavailable.'}), 504
    except requests.exceptions.ConnectionError:
        logger.error('Miruro resolution connection failed')
        return jsonify({'error': 'Connection failed. Check internet connection.'}), 503
    except Exception as e:
        logger.error('Miruro resolution failed: %s', e)
        return jsonify({'error': str(e)}), 500

# ===================================================================
#  Metadata API  (single anime)
# ===================================================================

@app.route('/api/metadata/anime/<int:mal_id>', methods=['GET'])
def get_metadata(mal_id):
    data = metadata_svc.get_jikan_anime(mal_id)
    if not data:
        return jsonify({'error': 'Metadata not found'}), 404
    return jsonify(data)


@app.route('/api/metadata/search', methods=['GET'])
def search_metadata():
    query = request.args.get('q')
    if not query:
        return jsonify({'error': 'query parameter q required'}), 400
    results = metadata_svc.search_jikan(query)
    return jsonify(results)


@app.route('/api/metadata/anime/<int:mal_id>/relations', methods=['GET'])
def get_relations(mal_id):
    results = metadata_svc.get_jikan_relations(mal_id)
    return jsonify(results)


@app.route('/api/metadata/airing/<int:id_mal>', methods=['GET'])
def get_airing_status(id_mal):
    data = metadata_svc.get_anilist_media(id_mal)
    if not data:
        return jsonify({'error': 'Airing status not found'}), 404
    return jsonify(data)


@app.route('/api/metadata/gold/<int:mal_id>', methods=['GET'])
def get_gold_metadata(mal_id):
    try:
        record = engine.get_gold_record(mal_id)
        return jsonify(record)
    except Exception as e:
        logger.error('Gold metadata aggregation failed for %d: %s', mal_id, e)
        return jsonify({'error': str(e)}), 500

# ===================================================================
#  Metadata API  (batch)
# ===================================================================

@app.route('/api/metadata/batch', methods=['POST'])
def get_batch_metadata():
    """Fetch gold-standard metadata for multiple MAL IDs concurrently.

    Request body:
        { "mal_ids": [21, 1535, ...], "cache": true }

    Returns:
        { "requested": N, "found": M, "results": { "21": {...}, ... }, "errors": {...} }
    """
    payload = request.get_json(force=True, silent=True) or {}
    mal_ids = payload.get('mal_ids', [])

    if not isinstance(mal_ids, list):
        return jsonify({'error': 'mal_ids must be a list'}), 400
    if len(mal_ids) > 100:
        return jsonify({'error': 'Maximum 100 IDs per batch request'}), 400

    results: Dict[str, Any] = {}
    errors: Dict[str, str] = {}

    import concurrent.futures
    def _fetch_one(mid: int):
        try:
            return mid, engine.get_gold_record(mid), None
        except Exception as exc:
            return mid, None, str(exc)

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(_fetch_one, int(mid)): mid for mid in mal_ids}
        for fut in concurrent.futures.as_completed(futures):
            mid, record, err = fut.result()
            if record:
                results[str(mid)] = record
            if err:
                errors[str(mid)] = err

    return jsonify({
        'requested': len(mal_ids),
        'found': len(results),
        'results': results,
        'errors': errors,
    })

# ===================================================================
#  Local File Endpoints
# ===================================================================

@app.route('/api/local/scan', methods=['POST'])
def scan_local():
    payload = request.get_json(force=True, silent=True) or {}
    path = payload.get('path')
    episode = payload.get('episode')
    season = payload.get('season')

    if not path:
        return jsonify({'error': 'path required'}), 400
    if not os.path.exists(path):
        logger.error('Directory not found: %s', path)
        return jsonify({'error': f'Directory not found: {path}'}), 404
    if not os.path.isdir(path):
        logger.error('Path is not a directory: %s', path)
        return jsonify({'error': f'Path is not a directory: {path}'}), 400

    try:
        files = local_resolver.scan_directory(path)
        
        # Match file dynamically in Python
        matched_file = None
        if episode is not None:
            target_season = int(season) if season is not None else 1
            for f in files:
                if f.get('episode') == int(episode):
                    f_season = f.get('season', 1)
                    if f_season == target_season or f_season == 1:
                        matched_file = f
                        break
                        
        logger.info('Scanned directory: %s, found %d files. Episode=%s, Season=%s, Matched=%s', 
                    path, len(files), episode, season, matched_file['filename'] if matched_file else 'None')
        return jsonify({
            'files': files, 
            'count': len(files), 
            'path': path,
            'matched_file': matched_file
        })
    except PermissionError as e:
        logger.error('Permission denied during scan: %s', e)
        return jsonify({'error': 'Permission denied. Check directory access rights.'}), 403
    except Exception as e:
        logger.error('Local scan failed: %s', e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/local/play', methods=['POST'])
def play_local():
    payload = request.get_json(force=True, silent=True) or {}
    file_path = payload.get('path')
    player = payload.get('player')

    if not file_path:
        return jsonify({'error': 'file path required'}), 400
    if not os.path.exists(file_path):
        logger.error('File not found: %s', file_path)
        return jsonify({'error': f'File not found: {file_path}'}), 404

    try:
        local_resolver.play_file(file_path, player=player)
        logger.info('Playing file: %s (player: %s)', file_path, player or 'auto')
        return jsonify({'status': 'playing', 'file': file_path})
    except FileNotFoundError as e:
        logger.error('File not found during playback: %s', e)
        return jsonify({'error': str(e)}), 404
    except PermissionError as e:
        logger.error('Permission denied during playback: %s', e)
        return jsonify({'error': 'Permission denied. Check file access rights.'}), 403
    except Exception as e:
        logger.error('Playback failed: %s', e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/local/pick', methods=['GET'])
def pick_local_directory():
    """Open a native directory picker on the host and return selected path.

    Note: This runs on the server side and therefore only works when the
    backend is running on the same machine as the browser (local dev).
    """
    try:
        # Import tkinter lazily to avoid import-time issues in headless environments
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        # Bring dialog to front on Windows
        try:
            root.attributes('-topmost', True)
        except Exception:
            pass
        path = filedialog.askdirectory()
        root.destroy()
        if not path:
            logger.info('User cancelled directory picker')
            return jsonify({'path': None, 'cancelled': True})
        logger.info('User selected directory: %s', path)
        return jsonify({'path': path})
    except ImportError as e:
        logger.error('Tkinter not available: %s', e)
        return jsonify({'error': 'Directory picker not available. Tkinter is required.'}), 500
    except Exception as e:
        logger.error('Directory picker failed: %s', e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/local/detect_player', methods=['GET'])
def detect_local_player():
    try:
        players = local_resolver.find_installed_players()
        logger.info('Detected players: %d found', len(players))
        return jsonify({'players': players, 'count': len(players)})
    except Exception as e:
        logger.error('Player detection failed: %s', e)
        return jsonify({'players': [], 'count': 0, 'error': str(e)})

# ===================================================================
#  Add Anime — Search Flow
# ===================================================================

@app.route('/api/search', methods=['POST'])
def api_search_anime():
    """Search anime by title.  Body: { "query": "...", "limit": 25 }"""
    payload = request.get_json(force=True, silent=True) or {}
    query = payload.get('query', '').strip()
    if not query:
        return jsonify({'error': 'query is required'}), 400
    limit = int(payload.get('limit', 25))
    try:
        results = search_anime(query, limit)
        return jsonify({'query': query, 'count': len(results), 'results': results})
    except Exception as e:
        logger.error('Search failed: %s', e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/franchise/relations/<int:mal_id>', methods=['GET'])
def api_franchise_relations(mal_id):
    """Get franchise relations for a selected anime."""
    try:
        data = get_franchise_relations(mal_id)
        return jsonify(data)
    except Exception as e:
        logger.error('Franchise relations failed for %d: %s', mal_id, e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/franchise/save', methods=['POST'])
def api_franchise_save():
    """Save a franchise bundle with full metadata.

    Body: { "main_mal_id": int, "selected_mal_ids": [int, ...] }
    Returns the fully-assembled entry ready for IndexedDB.
    """
    payload = request.get_json(force=True, silent=True) or {}
    main_id = payload.get('main_mal_id')
    selected = payload.get('selected_mal_ids', [])
    if not main_id:
        return jsonify({'error': 'main_mal_id required'}), 400
    try:
        entry = save_franchise_bundle(int(main_id), [int(x) for x in selected])
        return jsonify(entry)
    except Exception as e:
        logger.error('Franchise save failed: %s', e)
        return jsonify({'error': str(e)}), 500


# ===================================================================
#  Refresh — Single / Batch / Auto
# ===================================================================

@app.route('/api/refresh/single/<int:mal_id>', methods=['POST'])
def api_refresh_single(mal_id):
    """Refresh metadata for one anime.

    Body (optional): { "old_season": { ... } }
    Returns gold record + season patch + detected changes.
    """
    payload = request.get_json(force=True, silent=True) or {}
    old_season = payload.get('old_season')
    try:
        result = refresh_single(mal_id, old_season)
        return jsonify(result)
    except Exception as e:
        logger.error('Refresh single failed for %d: %s', mal_id, e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/refresh/batch', methods=['POST'])
def api_refresh_batch():
    """Refresh multiple anime concurrently.

    Body: { "entries": [ { "mal_id": int, "old_season": {...}|null }, ... ] }
    """
    payload = request.get_json(force=True, silent=True) or {}
    entries = payload.get('entries', [])
    if not isinstance(entries, list):
        return jsonify({'error': 'entries must be a list'}), 400
    if len(entries) > 100:
        return jsonify({'error': 'Maximum 100 entries per batch'}), 400
    try:
        result = refresh_batch(entries)
        return jsonify(result)
    except Exception as e:
        logger.error('Refresh batch failed: %s', e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/refresh/auto', methods=['POST'])
def api_refresh_auto():
    """Auto-refresh stale entries (24-hour threshold).

    Body: { "library": [ { "mal_id": int, "last_jikan_update": str|null, "old_season": {...}|null }, ... ] }
    """
    payload = request.get_json(force=True, silent=True) or {}
    library = payload.get('library', [])
    threshold = float(payload.get('threshold_hours', 24))
    max_items = int(payload.get('max_items', 5))
    try:
        result = auto_refresh(library, threshold, max_items)
        return jsonify(result)
    except Exception as e:
        logger.error('Auto refresh failed: %s', e)
        return jsonify({'error': str(e)}), 500


# ===================================================================
#  Error Handlers
# ===================================================================

@app.errorhandler(404)
def not_found(e):
    # API routes get JSON 404; everything else falls back to index.html (SPA)
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Not found'}), 404
    return send_from_directory(ROOT_DIR, 'index.html')

# ===================================================================
#  Startup & DB Initialization
# ===================================================================

# Determine port using standard PORT environment variable for platforms like Render, falling back to MUGELLIST_PORT or 8000
PORT = int(os.environ.get('PORT', os.environ.get('MUGELLIST_PORT', 8000)))

# Initialize SQLite Database at import/startup to support production servers like Gunicorn/Waitress
try:
    init_db()
    logger.info('Database initialised successfully.')
except Exception as e:
    logger.critical('CRITICAL: Database initialization failed: %s', e)

if __name__ == '__main__':
    logger.info('─' * 50)
    logger.info('  MugelList Unified Backend')
    logger.info('  http://localhost:%d', PORT)
    logger.info('─' * 50)

    # Run Flask with threading for concurrency on slow network endpoints
    app.run(
        host='0.0.0.0',
        port=PORT,
        debug=False,
        threaded=True,
    )
