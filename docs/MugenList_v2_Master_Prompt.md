Mugen List v2.0.23.26 — Comprehensive Build Prompt

Goal
Create an overhauled, production-ready version of MugelList called “Mugen List v2.0.23.26.” This prompt must serve as a complete specification for designers, frontend engineers, backend engineers, and ML-assisted generation tools to implement the app end-to-end: data model, API-first franchise resolution, exact season-aware sync/update logic, forced airing-priority ranking, UI/UX visual system (Tailwind-ready tokens and components), controlled sync worker pool with exponential backoff, per-season countdown logic (DD:HH:MM:SS), and full acceptance tests.

Project Summary & High-Level Requirements
- Name: Mugen List v2.0.23.26 (overhauled fork of MugelList).
- Primary non-negotiable constraints:
  - Seasons must never be treated as independent anime objects for core logic.
  - All library logic operates at franchise-root level with season-level precision for updates and UI binding.
  - Airing sequels (same franchise) must be forced to top of lists and rails when airing.
- Deliverables:
  - Data model & migration plan for IndexedDB (or chosen persistence).
  - Backend sync worker & queue code (JS service in-browser).
  - Precise UI component library (Tailwind tokens + classes) and Figma-ready component specs.
  - Integration tests, manual test plan, and acceptance criteria.
  - Final master prompt (this document) to be used by designers and engineering.

1) Definitive Data Model (MANDATORY)
Persist structure where the franchise/root is the primary record and seasons are nested objects.

Root model (JSON example):
```
{
  "root_id": "mal:1234" | "anilist:5678",
  "title_clean": "Re:Zero - Starting Life in Another World",
  "franchise_id": "franchise_000123",
  "primary_title": "Re:Zero - Starting Life in Another World",
  "aliases": ["Re:Zero", "Re:Zero kara Hajimeru Isekai Seikatsu"],
  "seasons": [
    {
      "season_id": "mal:61316",
      "season_number": 4,
      "season_name": "4th Season",
      "season_year": 2026,
      "is_airing": true,
      "total_episodes": 0,
      "aired_episodes": 3,
      "next_episode_airing_at": 1714000000000,
      "next_episode_number": 4,
      "external_sources": {
        "mal": { "id": 61316, "url": "..." },
        "anilist": { "id": 199547, "url": "..." }
      },
      "last_refreshed_at": 1714000000000,
      "season_meta": { }
    }
  ],
  "root_meta": {
    "genres": ["fantasy","drama"],
    "franchise_relations": ["mal:111","anilist:222"],
    "primary_poster": "data/posters/...",
    "last_refreshed_at": 1713990000000
  }
}
```

Rules and invariants
- Root is the franchise anchor. Use `root_id`/`franchise_id` for all grouping, stats, and recommendations.
- Seasons live inside the root. UI may expose seasons, but all business logic (scoring, stats, sync writes) operates on `root` plus targeted season updates.
- Per-season fields (next_episode_airing_at, aired_episodes, total_episodes) must be stored at the season level and updated individually.

2) Franchise Detection: API‑First & Deterministic
Design `resolveFranchise(rootCandidate)` function that uses a strict API-first resolution pipeline:

Priority order (must be followed):
1. AniList relations (primary) — use AniList GraphQL relations query and filter relation type.
2. MAL relations (secondary) — use MAL/Jikan relation structures if AniList missing.
3. Title pattern / heuristic (LAST RESORT only) — only used if both APIs fail; then record uncertainty flag.

AniList GraphQL relation query (example):
```
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    title { romaji, english, native }
    relations { edges { relationType, node { id, type, title { romaji } } } }
  }
}
```

resolveFranchise algorithm (pseudocode):
- Input: seasonCandidate {mal_id?, anilist_id?, title}
- If anilist_id:
  - fetch media relations via AniList GraphQL
  - filter edges for relationType in [SEQUEL, PREQUEL, SIDE_STORY, SUMMARIZE?]
  - traverse relations to build a franchise graph (breadth-first to depth N, default N=5)
  - normalize nodes to canonical `franchise_id` (hash of series root title + earliest release)
  - return `franchise_id`
- Else if mal_id:
  - query Jikan/MAL for relations and apply same traversal + normalization
- Else:
  - Run strict title normalization (strip S1/S2, year tokens, punctuation), then fuzzy-match to existing franchise roots (only if high-confidence threshold > 0.95). Log fallback events.

Relation type filtering: Allow & prefer SEQUEL, PREQUEL, SIDE_STORY; ignore weak relations (e.g., CHARACTER). Normalize node IDs by adding source prefix (anilist:NNN or mal:NNN).

Cache results:
- Cache resolved `franchise_id` keyed by external ids, TTL 2–4 hours (configurable).
- Provide manual invalidation on user action (e.g., "re-resolve franchise").

3) Airing Priority: Hard Tiering, Not Soft Boosting
Replace scoring boost with a hard priority-tier system and stable tie-breakers:

Priority tiers (descending):
1. AIRING SEQUEL: same-franchise season currently airing (force to top)
2. CONTINUE WATCHING: user progress continuation candidates
3. HIGH MATCH RECOMMENDATIONS: high match score from recommendation engine
4. NORMAL CONTENT: baseline content

Sorting algorithm:
- For any list (library grid, rails, recommendations), compute:
  - If any season of a root satisfies is_airing === true AND relation kind === SEQUEL (or same franchise), assign Tier 1 and sort all Tier 1 items before others. Within Tier 1, sort by next_episode_airing_at ascending (soonest first), then user watch progress descending.
  - Then Tier 2: continue watching, sort by progress descending.
  - Then other tiers by score/time.

Enforce pinning:
- If an airing sequel exists for a franchise, it must appear before all non-airing roots regardless of other scores. Make ordering deterministic: (tier, airingFlag, nextEpisodeTime, lastRefreshedAt, root_title).

4) Season Awareness: Exact Ordering + Relation Traversal
- Don't rely on seasonYear or "season string" alone.
- Add relation traversal depth to detect chain S1 → S2 → S3:
  - When resolving franchise graph, compute directed edges (S1 → S2) and produce absolute ordering by release date if available, else by sequence/season_number from API.
  - Tag the season with `sequence_index` (0-based), compute `latest_season` as max(sequence_index).
- Example: Rent-A-Girlfriend S1..S5
  - Detect and mark S5 as latest, set is_airing true for S5 if API indicates so, and pin S5 above all seasons of that franchise.

5) Sync/Refresh System: Per‑Season Updates, No Root Overwrites
Core rules:
- For each root in library:
  - For each season in root.seasons:
    - Fetch by season external id (season.mal_id or season.anilist_id)
    - Update ONLY that season object fields (aired_episodes, total_episodes, next_episode_airing_at, last_refreshed_at)
- Never fetch a "root" and overwrite all nested season entries in bulk.

Pseudo worker flow:
- manualLibrarySync({ roots, concurrency=3, onProgress }) {
  - Build per-season tasks queue (task = {root_id, season_id})
  - Worker pool executes up to concurrency tasks in parallel
  - For each task:
    - Call fetchSeasonData(seasonId)
    - If 429 or 5xx: exponentialBackoff(retries <= 3)
    - If success:
      - determine changedFields = diff(oldSeason, newSeason)
      - if changedFields.length > 0: saveSeasonPartial(rootId, seasonId, changedFields)
      - call onProgress({completed, total, current, changed: changedFields.length>0, error:null})
    - If error after retries: call onProgress({..., changed:false, error:err})
  - After all tasks: final summary onProgress(totalUpdated, totalFailed)
}

Important: `saveSeasonPartial` must update only season-specific fields (patch), not replace entire root object.

6) Countdown & Airing Bound to Season
- Store countdown per season: `season.next_episode_airing_at`.
- UI rules:
  - Card hover shows countdown only for the hovered season (if the card represents a season).
  - On views showing multiple seasons, always show countdown for the latest season by default.
- Countdown format: DD:HH:MM:SS, zero-padded with tabular digits.
- Implementation snippet (JS):
```
function formatDurationDDHHMMSS(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms/1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [days, hours, minutes, seconds].map(n => String(n).padStart(2,'0')).join(':');
}
```
- Update frequency:
  - Update every second while element in viewport or hovered.
  - Pause updates otherwise to save CPU.

7) UI: Poster‑First, Season‑Aware Components (Tailwind-ready)
Design goals:
- Poster-first: poster art primary anchor (2:3).
- Show latest season first for any franchise.
- Cards should expose season-level metadata, countdown overlay, and micro-actions.
- Avoid full-grid rerenders — provide `updateCardFromAnime(rootId, seasonId)` for in-place DOM patches.

Component spec (key items)
- Sidebar: collapsed 64px / expanded 220–280px.
- Topbar: 56–64px with search & sync indicator.
- Hero: 16:9 or poster accent area.
- Rails: horizontally scrollable, snap-to-item; season rails allowed.
- Library Grid: responsive 5–6 columns desktop, 3–4 tablet, 1 mobile.

Anime card anatomy:
- poster area (2:3) + footer with metadata & controls
- top-left status pill (watching/completed/planned)
- top-right new-ep / airing badge (small pulse optional)
- bottom: season chip, progress bar (3px rounded gradient), micro-controls
- hover: poster scale 1.06; center countdown overlay for `is_airing` season
- accessibility: `tabindex=0`, aria-label includes root title + season label + key stats.

Tailwind examples (copyable)
- Card container:
`class="rounded-2xl border border-white/6 bg-gradient-to-b from-[#161a2a]/90 to-[#0d1016] shadow-lg overflow-hidden transform transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)] hover:-translate-y-2"`
- Poster hover:
`class="w-full h-full object-cover transition-transform duration-600 ease-[cubic-bezier(.16,1,.3,1)] group-hover:scale-105"`
- Countdown overlay:
`class="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-200"`
- Progress fill (inline style):
`style="background:linear-gradient(90deg,#5D5FEF,#A5A6F6); box-shadow:0 0 8px rgba(93,95,239,0.45); height:3px; border-radius:9999px;"`

8) Recommendation Engine: Season‑Progress Awareness
New rules:
- Recommendation priorities must respect season progress:
  - If user watched S1 fully and is partway through S2, recommend S2 continuation first.
  - Do not recommend S3 or unrelated titles ahead of the user's current season progression.
- Implement `recommendationCandidateScore(root, userProgress)` with special logic:
  - If exists season where userProgress.season==season.number and userProgress.episode < season.total_episodes → treat as "continue" candidate and rank high.
- Use franchise-level grouping for collaborative filtering: treat franchise as anchor when computing similarity across seasons.

9) Stats: Franchise-aware Counting
- total_anime = COUNT(root entries)
- total_seasons = SUM(root.seasons.length)
- active_franchises = COUNT(root where any season.is_airing === true)
- UI stats tiles should expose both `roots` and `seasons` counts to prevent inflation.

10) Sync Scheduling & Frequency (Final Answer)
- Full sync: once every 24 hours (configurable)
- Airing sync: every 5–10 minutes (aggressive)
- Franchise discovery / relation re-resolve: every 2–4 hours
- Manual refresh (user-initiated) must honor concurrency/backoff and show progressive per-item updates.

11) Worker Pool, Backoff & Rate‑limit Strategy
- Default concurrency: 3 workers (make configurable 3–5)
- Exponential backoff for errors/429: base=700ms, backoff = base * 2^attempt + jitter(0..300ms)
- Retry policy: retry up to 1 (total attempts=2) for transient errors; mark failed after retries.
- Add small inter-request jitter/sleep of 150–350ms when queueing to avoid burst.

12) Performance & Caching
- Cache franchise resolution results; TTL 2–4 hours.
- Memoize compute-heavy functions (calculateFranchiseBoost, deep diffs).
- Recompute caches only on library changes or when a refresh updates related fields.
- Use virtualization (windowing) for large grids and lazy image loading (LQIP).
- Pause countdown intervals for offscreen cards.

13) DB Writes & Concurrency Safety
- All writes must be per-season patch updates (atomic per-season).
- Use an optimistic concurrency token or last_refreshed_at compare to avoid overwriting fresher local changes from concurrent manual edits.
- Example write logic:
```
if (incoming.last_refreshed_at > stored.season.last_refreshed_at) applyPatch();
else skip or log conflict and queue for re-evaluation;
```

14) UX & Motion
- Easing: cubic-bezier(0.16, 1, 0.3, 1), durations 180–600ms per context.
- Microinteractions: 180–300ms for hover; poster scale 1.05–1.08.
- Avoid heavy blurs; keep backdrop-blur < 14px.

15) Accessibility
- Keyboard navigable cards, rails, and actions.
- Provide `aria-live="polite"` for small per-item sync messages and `aria-live="assertive"` for errors.
- Contrast ratios >= 4.5 for primary text.
- Use tabular numeric font-variant for countdowns.

16) Acceptance Criteria & Test Plan
Manual test steps (smoke):
- Setup: Add a franchise root with seasons S1..S5 where S5 is marked airing.
- Trigger: Run manualLibrarySync (full) and watch progress UI updates:
  - Verify per-season updates occur (only seasons updated changed fields).
  - Verify `S5` is pinned to the top of the library grid and rails.
  - Hover S5: countdown shows `DD:HH:MM:SS` and updates per-second while hovered.
  - Verify notifications: per-item toast appears only when changed===true, and final summary shows (e.g., “Refresh complete — 12 updated, 1 error”).
- Edge cases:
  - Simulate 429 responses; ensure exponential backoff + retry, no UI freeze.
  - Simulate conflicting local update; ensure write uses last_refreshed_at logic and does not overwrite fresher local edits.
- Metrics:
  - Sync throughput with concurrency 3 should not exceed Jikan/AniList limits; measure average ms per request and failure rate.
  - UI responsiveness: main thread jank < 50ms frames during sync for typical libraries (100–500 items) using virtualization.

17) Deliverables & PR Requirements
- Backend / Sync:
  - Patch `js/services/refreshService.js` to implement per-season fetch, worker pool, backoff, per-item onProgress events, partial-season writes.
  - Implement `resolveFranchise()` in `js/services/franchiseService.js` (new) that returns franchise_id and canonical root mapping.
- UI:
  - Update `js/ui/animeCard.js` to bind per-season countdown and expose `updateCardFromAnime(root, season)` for incremental updates.
  - Update `js/pages/libraryPage.js` to render by root with seasons and ensure latest season first; use incremental DOM patching (no full rerender).
  - Update `js/pages/settingsPage.js` to include `Refresh Library Now` manual action wired to `manualLibrarySync()` with concurrency controls and progress UI.
- Docs:
  - Add README update with testing steps and sync frequency config.
  - Add migration guide for converting existing season-as-root records into the new `root` + `seasons[]` model.
- Figma & Design Assets:
  - Provide Figma file with annotated components (1440×900 frame), tokens, and spacing grid.
  - Provide Tailwind tokens and `tailwind.config.js` snippet (color variables, spacing scale, card component).
- Tests:
  - Unit tests for `formatDurationDDHHMMSS`, `resolveFranchise()`, and per-season patch logic.
  - Integration test simulation for manualLibrarySync with mock API responses (success, 429, 500).

18) Example Implementation Snippets (JS pseudocode)
- Per-season worker:
```
async function processSeasonTask(task) {
  let attempt = 0;
  while (attempt <= 1) {
    try {
      const newData = await fetchSeasonById(task.season_id);
      const changed = diffSeason(storedSeason, newData);
      if (changed.length) await saveSeasonPartial(task.root_id, task.season_id, changed);
      return {changed:true};
    } catch (err) {
      if (isRetryable(err) && attempt < 1) {
        await sleep(700 * Math.pow(2,attempt) + jitter());
        attempt++;
        continue;
      }
      return {error: err};
    }
  }
}
```

19) Migration Strategy (important)
If current DB stores seasons as independent items:
- Step 1: Scan library entries, identify groups by normalized title or existing relation ids.
- Step 2: For each group, create a new `root` entry and move season fields into `root.seasons[]`.
- Step 3: Validate grouping via AniList/MAL relations; if ambiguous, mark `franchise_resolve_status: "needs_review"`.
- Step 4: Update UI to render new structure and provide a "Review grouped franchises" admin UI for manual fixes.

20) Acceptance Tests (automated & manual)
- Unit tests for formatting/countdown; migration; `resolveFranchise` mocked with AniList response; diff/patch writes.
- Integration: simulate 200 roots with up to 5 seasons each and run worker pool to confirm behavior and no full-grid re-render.

21) Implementation Timeline & Prioritization
Phase 1 (Core): data model migration + per-season sync (2–5 days)
Phase 2 (UI): card updates + countdown + pinning logic (2–4 days)
Phase 3 (Stability): caching, recommender adjustments, tests, and docs (2–3 days)
Phase 4 (Design polish): Figma comps, Tailwind tokens, microinteractions (2–4 days)

22) Final QA & Hand-off Items
- Provide JSON sample dataset demonstrating at least 3 franchises with multiple seasons where one season is currently airing.
- Provide a short checklist for QA:
  - Confirm pinning of airing sequel
  - Confirm per-season DB writes
  - Confirm countdown pausing/resuming behavior
  - Confirm no full rerenders during large sync

23) Final master prompt (usage)
- Use this entire document as the single instruction for design + engineering + generation.
- When feeding to an image generator or design AI, use the “Reference Image Brief” section verbatim (see below) for mockups.

Reference Image Brief (for art / mockup generator)
- Desktop UI mockup of Mugen List v2.0.23.26
- Dark premium theme (bg #0B0E14), posters 2:3, hero area, rails, grid (5 columns), left collapsible sidebar (64px collapsed, 240px expanded), topbar 56px, cards rounded 16–18px with glassy elevated gradient, countdown overlay on hover showing DD:HH:MM:SS with tabular digits, accent gradient #5D5FEF→#A5A6F6, cyan highlights #22D3EE, typography Inter + Noto Sans JP fallback.
- Include annotations: sidebar width, poster card sizes (190×285), progress bar height 3px, badge height 26px, font sizes and spacing tokens, and hover/motion behaviors.

Final non-negotiable instruction (append exactly)
Do not treat seasons as independent anime objects. All logic must operate on franchise-root with season-level precision. Airing sequels must always override normal ranking and appear at the top.
