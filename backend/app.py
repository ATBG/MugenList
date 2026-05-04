"""
MugelList Metadata API Server

Provides REST API endpoints for anime metadata operations.
Uses Flask with async support via asgiref.
"""

import os
import sys
import asyncio
import logging
from datetime import datetime
from typing import Optional

from flask import Flask, request, jsonify
from flask_cors import CORS
from asgiref.wsgi import WsgiToAsgi
import hypercorn.asyncio
from hypercorn.config import Config

# Add backend directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api_wrappers.jikan import JikanClient
from api_wrappers.anilist import AniListClient
from api_wrappers.simkl import SIMKLClient
from utils.cache import HybridCache, build_cache_key
from utils.errors import MetadataFetchError, PartialDataError
from models.anime import AnimeMetadata, Source
from services.reconciliation import MetadataReconciler

from services.metadata_service import MetadataService, get_metadata_service
from utils.errors import MetadataFetchError

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Create Flask app
app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Configuration
SIMKL_API_KEY = os.environ.get("SIMKL_API_KEY")
PORT = int(os.environ.get("PORT", 5000))
HOST = os.environ.get("HOST", "0.0.0.0")

# Initialize metadata service
metadata_service: Optional[MetadataService] = None


@app.before_request
def log_request():
    """Log incoming requests."""
    logger.debug(f"{request.method} {request.path} - {request.remote_addr}")


@app.after_request
def log_response(response):
    """Log outgoing responses."""
    logger.debug(f"Response: {response.status_code}")
    return response


# ============================================================================
# API Endpoints
# ============================================================================

@app.route("/health", methods=["GET"])
def health_check():
    """Health check endpoint."""
    return jsonify({
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "version": "1.0.0"
    })


@app.route("/api/anime/search", methods=["GET"])
async def search_anime():
    """
    Search for anime by title.
    
    Query Parameters:
        - q: Search query (required)
        - page: Page number (default: 1)
        - limit: Results per page (default: 20, max: 50)
        - cache: Use cache (default: true)
    
    Returns:
        JSON array of anime metadata
    """
    try:
        query = request.args.get("q", "").strip()
        if not query:
            return jsonify({"error": "Query parameter 'q' is required"}), 400
        
        page = max(1, int(request.args.get("page", 1)))
        limit = max(1, min(50, int(request.args.get("limit", 20))))
        use_cache = request.args.get("cache", "true").lower() == "true"
        
        service = await get_metadata_service(SIMKL_API_KEY)
        results = await service.search_anime(query, page, limit, use_cache)
        
        return jsonify({
            "query": query,
            "page": page,
            "limit": limit,
            "total": len(results),
            "results": [r.to_dict() for r in results]
        })
        
    except ValueError as e:
        return jsonify({"error": f"Invalid parameter: {str(e)}"}), 400
    except MetadataFetchError as e:
        logger.error(f"Metadata fetch error: {e.api_error.message}")
        return jsonify({
            "error": "Failed to fetch metadata",
            "details": e.api_error.to_dict()
        }), 502
    except Exception as e:
        logger.exception("Search error")
        return jsonify({"error": f"Internal server error: {str(e)}"}), 500


@app.route("/api/anime/<int:mal_id>", methods=["GET"])
async def get_anime_by_mal_id(mal_id: int):
    """
    Get anime metadata by MyAnimeList ID.
    
    Query Parameters:
        - cache: Use cache (default: true)
    
    Returns:
        JSON anime metadata or 404 if not found
    """
    try:
        use_cache = request.args.get("cache", "true").lower() == "true"
        
        service = await get_metadata_service(SIMKL_API_KEY)
        result = await service.get_anime_by_id(
            mal_id=mal_id,
            use_cache=use_cache
        )
        
        if not result:
            return jsonify({"error": "Anime not found"}), 404
        
        return jsonify(result.to_dict())
        
    except MetadataFetchError as e:
        logger.error(f"Metadata fetch error: {e.api_error.message}")
        return jsonify({
            "error": "Failed to fetch metadata",
            "details": e.api_error.to_dict()
        }), 502
    except Exception as e:
        logger.exception(f"Fetch error for MAL ID {mal_id}")
        return jsonify({"error": f"Internal server error: {str(e)}"}), 500


@app.route("/api/anime/batch", methods=["POST"])
async def get_batch_anime():
    """
    Get multiple anime by MAL IDs in a batch request.
    
    Request Body:
        {
            "mal_ids": [1, 2, 3],
            "cache": true
        }
    
    Returns:
        JSON object mapping MAL IDs to anime metadata
    """
    try:
        data = request.get_json()
        if not data or "mal_ids" not in data:
            return jsonify({"error": "Request body must contain 'mal_ids' array"}), 400
        
        mal_ids = data["mal_ids"]
        if not isinstance(mal_ids, list) or not all(isinstance(i, int) for i in mal_ids):
            return jsonify({"error": "'mal_ids' must be an array of integers"}), 400
        
        if len(mal_ids) > 100:
            return jsonify({"error": "Maximum 100 IDs per batch request"}), 400
        
        use_cache = data.get("cache", True)
        
        service = await get_metadata_service(SIMKL_API_KEY)
        results = await service.get_batch_anime(mal_ids, use_cache)
        
        return jsonify({
            "requested": len(mal_ids),
            "found": len(results),
            "results": {
                str(k): v.to_dict() for k, v in results.items()
            }
        })
        
    except MetadataFetchError as e:
        logger.error(f"Metadata fetch error: {e.api_error.message}")
        return jsonify({
            "error": "Failed to fetch metadata",
            "details": e.api_error.to_dict()
        }), 502
    except Exception as e:
        logger.exception("Batch fetch error")
        return jsonify({"error": f"Internal server error: {str(e)}"}), 500


@app.route("/api/anime/<int:mal_id>/refresh", methods=["POST"])
async def refresh_anime(mal_id: int):
    """
    Refresh anime metadata from sources.
    
    Request Body (optional):
        {
            "user_progress": 12,  # Current episode watched
            "force": false        # Force refresh even if cache is fresh
        }
    
    Returns:
        JSON refreshed anime metadata
    """
    try:
        data = request.get_json() or {}
        user_progress = data.get("user_progress")
        force = data.get("force", False)
        
        service = await get_metadata_service(SIMKL_API_KEY)
        result = await service.refresh_anime(mal_id, user_progress, force)
        
        if not result:
            return jsonify({"error": "Anime not found"}), 404
        
        return jsonify({
            "refreshed": True,
            "mal_id": mal_id,
            "data": result.to_dict()
        })
        
    except MetadataFetchError as e:
        logger.error(f"Refresh error: {e.api_error.message}")
        return jsonify({
            "error": "Failed to refresh metadata",
            "details": e.api_error.to_dict()
        }), 502
    except Exception as e:
        logger.exception(f"Refresh error for MAL ID {mal_id}")
        return jsonify({"error": f"Internal server error: {str(e)}"}), 500


@app.route("/api/anime/<int:mal_id>/relations", methods=["GET"])
async def get_anime_relations(mal_id: int):
    """
    Get franchise relations for an anime.
    
    Returns:
        JSON array of franchise relations
    """
    try:
        service = await get_metadata_service(SIMKL_API_KEY)
        
        # Get anime metadata (which includes relations)
        result = await service.get_anime_by_id(mal_id=mal_id, use_cache=True)
        
        if not result:
            return jsonify({"error": "Anime not found"}), 404
        
        return jsonify({
            "mal_id": mal_id,
            "title": result.titles.get_primary(),
            "franchise_id": result.franchise_id,
            "relations": [r.to_dict() for r in result.franchise_relations]
        })
        
    except Exception as e:
        logger.exception(f"Relations error for MAL ID {mal_id}")
        return jsonify({"error": f"Internal server error: {str(e)}"}), 500


@app.route("/api/cache/stats", methods=["GET"])
async def get_cache_stats():
    """Get cache statistics."""
    try:
        service = await get_metadata_service(SIMKL_API_KEY)
        stats = await service.get_cache_stats()
        return jsonify(stats)
    except Exception as e:
        logger.exception("Cache stats error")
        return jsonify({"error": str(e)}), 500


@app.route("/api/cache/clear", methods=["POST"])
async def clear_cache():
    """Clear all cached data."""
    try:
        service = await get_metadata_service(SIMKL_API_KEY)
        await service.clear_cache()
        return jsonify({"cleared": True})
    except Exception as e:
        logger.exception("Cache clear error")
        return jsonify({"error": str(e)}), 500


# Error handlers

@app.errorhandler(404)
def not_found(error):
    return jsonify({"error": "Endpoint not found"}), 404


@app.errorhandler(405)
def method_not_allowed(error):
    return jsonify({"error": "Method not allowed"}), 405


@app.errorhandler(500)
def internal_error(error):
    logger.exception("Internal server error")
    return jsonify({"error": "Internal server error"}), 500


# ============================================================================
# Server Startup
# ============================================================================

async def startup():
    """Initialize the metadata service."""
    global metadata_service
    logger.info("Starting up MugelList Metadata API...")
    metadata_service = await get_metadata_service(SIMKL_API_KEY)
    logger.info("Metadata service initialized")


async def shutdown():
    """Cleanup resources."""
    global metadata_service
    if metadata_service:
        logger.info("Shutting down metadata service...")
        await metadata_service.__aexit__(None, None, None)
        metadata_service = None


async def main():
    """Run the server."""
    await startup()
    
    try:
        # Convert Flask app to ASGI
        asgi_app = WsgiToAsgi(app)
        
        # Configure Hypercorn
        config = Config()
        config.bind = [f"{HOST}:{PORT}"]
        config.use_reloader = False
        config.accesslog = "-"
        config.errorlog = "-"
        
        logger.info(f"Starting server on {HOST}:{PORT}")
        await hypercorn.asyncio.serve(asgi_app, config)
    finally:
        await shutdown()


if __name__ == "__main__":
    asyncio.run(main())
