# MugelList Python Backend - Implementation Summary

## Overview

This document describes the new Python-based metadata backend for MugelList. The backend owns all API operations, replacing the JavaScript frontend API calls with a centralized, robust Python service.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     FRONTEND (JavaScript)                    │
│         - Only displays data                                │
│         - Makes requests to Python backend                  │
│         - No direct API calls to Jikan/AniList/SIMKL        │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ HTTP/REST
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  PYTHON BACKEND (Flask)                      │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Jikan API   │  │ AniList API  │  │ SIMKL API        │   │
│  │ Wrapper     │  │ Wrapper      │  │ Wrapper          │   │
│  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                    │            │
│         └─────────────────┼────────────────────┘            │
│                           ▼                                │
│              ┌────────────────────────┐                     │
│              │ Metadata Service     │                     │
│              │ - Fetch from all 3   │                     │
│              │ - Reconcile data     │                     │
│              │ - Cache results      │                     │
│              └──────────┬───────────┘                     │
│                         │                                 │
│              ┌──────────┴───────────┐                      │
│              │ Reconciliation Engine │                      │
│              │ - Priority-based merge│                      │
│              │ - Provenance tracking │                      │
│              └──────────┬───────────┘                      │
│                         │                                 │
│              ┌──────────▼───────────┐                      │
│              │ Normalized Model     │                      │
│              │ (AnimeMetadata)      │                      │
│              └──────────┬───────────┘                      │
│                         │                                 │
│              ┌──────────▼───────────┐                      │
│              │ Hybrid Cache         │                      │
│              │ (Memory + File)       │                      │
│              └──────────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

## Files Created

### 1. Models (`backend/models/`)
- **`anime.py`** - Normalized data models
  - `AnimeMetadata` - Unified representation
  - `SourceIds` - ID mapping across sources
  - `TitleInfo` - Multi-language titles
  - `EpisodeInfo` - Episode counts and airing data
  - `FranchiseRelation` - Franchise linking
  - `Provenance` - Source tracking

### 2. API Wrappers (`backend/api_wrappers/`)
- **`jikan.py`** - MyAnimeList/Jikan v4 API
  - Rate limiting: 3 req/sec
  - Endpoints: search, details, relations, seasonal
  - Data parsing and normalization

- **`anilist.py`** - AniList GraphQL API
  - Rate limiting: 1 req/sec (conservative)
  - Batch queries for efficiency
  - Best for: airing data, popularity, rich metadata

- **`simkl.py`** - SIMKL API
  - Rate limiting: 2 req/sec
  - Cross-reference lookup
  - Best for: additional metadata, images

### 3. Services (`backend/services/`)
- **`reconciliation.py`** - Data merging logic
  - Priority-based field selection
  - Source provenance tracking
  - Episode count validation
  - Franchise ID generation

- **`metadata_service.py`** - Main orchestrator
  - Search operations
  - Single/batch fetching
  - Refresh operations
  - Cache management

### 4. Utilities (`backend/utils/`)
- **`errors.py`** - Error handling framework
  - Structured error classification
  - Automatic retry logic
  - Timeout handling
  - Graceful degradation

- **`cache.py`** - Caching system
  - In-memory cache (5 min default TTL)
  - File cache (24 hour default TTL)
  - Hybrid approach with promotion
  - Automatic cleanup

### 5. Scheduler (`backend/scheduler/`)
- **`refresh_worker.py`** - Background refresh
  - Priority-based job queue
  - Concurrent processing (3 workers)
  - Automatic retry with backoff
  - Statistics tracking

### 6. API Server (`backend/`)
- **`app.py`** - Flask/ASGI server
  - REST API endpoints
  - CORS enabled
  - Async request handling
  - Error handlers

## API Endpoints

### Search
```
GET /api/anime/search?q={query}&page=1&limit=20
```
Searches across all sources, returns merged results.

### Get by ID
```
GET /api/anime/{mal_id}
```
Fetches and reconciles data from all sources.

### Batch Fetch
```
POST /api/anime/batch
Body: {"mal_ids": [1, 2, 3], "cache": true}
```
Efficiently fetches multiple anime (up to 100).

### Refresh
```
POST /api/anime/{mal_id}/refresh
Body: {"user_progress": 12, "force": false}
```
Forces metadata refresh, validates episode counts.

### Relations
```
GET /api/anime/{mal_id}/relations
```
Returns franchise relations with confidence scores.

### Cache Management
```
GET /api/cache/stats
POST /api/cache/clear
```

## Reconciliation Strategy

### Field Priority Order

| Field | Primary Source | Fallback Order |
|-------|---------------|----------------|
| synopsis | AniList | Jikan, SIMKL |
| genres | AniList | Jikan, SIMKL |
| score | AniList | Jikan, SIMKL |
| status | AniList | Jikan, SIMKL |
| episodes | AniList | Jikan, SIMKL |
| next_airing | AniList | (none) |
| studios | Jikan | AniList, SIMKL |
| relations | Jikan | AniList, SIMKL |
| season/year | Jikan | AniList, SIMKL |

### Episode Count Logic
1. Prefer maximum valid count from any source
2. Ensure aired >= user progress (never reset user progress)
3. AniList preferred for ongoing series
4. Special handling for long-running series (One Piece)

## Error Handling

### Retry Strategy
- Max 3 retries with exponential backoff
- Rate limit errors: Wait 2s + (attempt × 1.5s)
- Network errors: Wait 1s × attempt
- Non-retryable: 404s, parse errors

### Error Classification
- Network/Timeout → Retry
- Rate Limit → Retry with delay
- Not Found → Return None
- Parse Error → Log and continue
- Server Error → Retry

## Caching Strategy

### Two-Level Cache
1. **In-Memory** (5 min TTL)
   - Fast access
   - Auto cleanup every 5 min
   - Per-process

2. **File Cache** (24 hour TTL)
   - Persistent across restarts
   - Pickle serialization
   - MD5 hashed keys

### Cache Keys
```python
search:{hash(query, page, limit)}
detail:{hash(mal_id)}
batch:{hash(mal_ids)}
```

## Running the Backend

### Installation
```bash
cd backend
pip install -r requirements.txt
```

### Development
```bash
python app.py
# Server runs on http://localhost:5000
```

### Production
```bash
# Using Hypercorn (ASGI)
hypercorn app:app -b 0.0.0.0:5000

# Or with gunicorn (if preferred)
gunicorn -w 4 -k uvicorn.workers.UvicornWorker app:app
```

### Environment Variables
```bash
export SIMKL_API_KEY="your_key_here"  # Optional
export PORT=5000
export HOST=0.0.0.0
```

## Frontend Integration

### Example: Search
```javascript
const searchAnime = async (query) => {
  const response = await fetch(
    `http://localhost:5000/api/anime/search?q=${encodeURIComponent(query)}`
  );
  const data = await response.json();
  return data.results;
};
```

### Example: Batch Refresh
```javascript
const refreshLibrary = async (library) => {
  const malIds = library.map(a => a.root_mal_id);
  const response = await fetch('http://localhost:5000/api/anime/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mal_ids: malIds })
  });
  return await response.json();
};
```

## Benefits Over JavaScript Frontend

1. **Rate Limiting**
   - Centralized control
   - No browser limitations
   - Can queue and retry properly

2. **Caching**
   - Persistent file cache
   - Shared across sessions
   - No browser storage limits

3. **Error Handling**
   - Structured retry logic
   - Better timeout control
   - Graceful degradation

4. **Data Quality**
   - Multi-source reconciliation
   - Provenance tracking
   - Consistent normalization

5. **Performance**
   - Batch operations
   - Parallel fetching
   - Background refresh

## Migration Guide

### Phase 1: Deploy Backend
1. Set up Python environment
2. Install dependencies
3. Start backend server
4. Verify endpoints with curl/Postman

### Phase 2: Update Frontend
Replace direct API calls:
```javascript
// OLD (JavaScript)
import { searchAnime } from './services/jikanClient.js';
const results = await searchAnime(query);

// NEW (Python Backend)
const response = await fetch(`/api/anime/search?q=${query}`);
const { results } = await response.json();
```

### Phase 3: Remove Old Code
- Delete `js/api.js`
- Delete `js/services/jikanClient.js`
- Delete `js/services/episodeSyncService.js`
- Update imports in `app.js`

## Testing

### Unit Tests (to be added)
```bash
pytest backend/tests/
```

### Integration Tests
```bash
# Start backend
python backend/app.py &

# Run tests
curl "http://localhost:5000/api/anime/search?q=attack%20on%20titan"
curl "http://localhost:5000/api/anime/16498"
```

## Future Enhancements

1. **WebSocket Support** - Real-time updates
2. **Database Backend** - SQLite/PostgreSQL for persistence
3. **Authentication** - API key management
4. **GraphQL API** - Flexible queries
5. **Analytics** - Usage tracking
6. **Admin Dashboard** - Cache management

## Architecture Compliance

✅ **PHASE 1: API Re-setup**
- Clean wrappers for all 3 APIs
- Correct endpoints and parameters
- Rate limiting implemented

✅ **PHASE 2: Python Metadata Engine**
- Search, fetch, cross-check, reconcile
- Response validation and normalization
- Error handling with retries

✅ **PHASE 3: Precision Metadata**
- All important fields gathered
- Source provenance tracked
- Reconciliation rules implemented

✅ **PHASE 4: Continuous Refresh**
- Background scheduler
- Priority-based queue
- Batch processing

✅ **PHASE 5: Error Handling**
- Timeout and retry strategies
- Graceful degradation
- Structured error logging

✅ **PHASE 6: Backend Design**
- Modular architecture
- Frontend only displays data
- Clear separation of concerns

✅ **PHASE 7: Data Model**
- Normalized internal model
- Source ID tracking
- Update timestamps

✅ **PHASE 8: Quality**
- Deterministic reconciliation
- Easy to debug and expand
- Resilient to API problems
