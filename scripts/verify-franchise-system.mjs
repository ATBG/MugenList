import assert from 'node:assert/strict';

import {
  buildFocusCluster,
  getContinueActionForAnime,
  getLightSyncCandidates,
  normalizeLibraryMetadata,
} from '../js/services/franchiseService.js';

const NOW = new Date('2026-04-25T00:00:00.000Z').getTime();
const HOUR = 60 * 60 * 1000;

function makeSeason(overrides) {
  return {
    mal_id: overrides.mal_id,
    title_english: overrides.title_english,
    title_japanese: overrides.title_japanese || overrides.title_english,
    total_episodes: overrides.total_episodes ?? 12,
    episodes: overrides.episodes ?? overrides.total_episodes ?? 12,
    progress: overrides.progress ?? 0,
    watch_status: overrides.watch_status || 'plan_to_watch',
    status: overrides.status || 'Finished Airing',
    airing: overrides.airing || false,
    is_airing: overrides.is_airing ?? overrides.airing ?? false,
    poster_url: overrides.poster_url || '',
    relations: overrides.relations || [],
    aired_at: overrides.aired_at || null,
    next_episode_airing_at: overrides.next_episode_airing_at || null,
    next_episode_airtime: overrides.next_episode_airtime || overrides.next_episode_airing_at || null,
    next_episode_number: overrides.next_episode_number || null,
    format: overrides.format || 'TV',
    season_label: overrides.season_label || '',
    season_year: overrides.season_year || null,
    updated_date: overrides.updated_date || '2026-04-24T00:00:00.000Z',
    last_progress_update: overrides.last_progress_update || null,
    started_watching_date: overrides.started_watching_date || null,
    franchise_id: overrides.franchise_id || null,
    franchise_root_id: overrides.franchise_root_id || null,
    franchise_order_index: overrides.franchise_order_index || null,
    franchise_rank_score: overrides.franchise_rank_score || 0,
    has_user_watched_previous: overrides.has_user_watched_previous || false,
  };
}

function makeEntry({ root_mal_id, title_english, selected_season_mal_id, seasons, updated_date }) {
  const seasonMap = Object.fromEntries(seasons.map((season) => [String(season.mal_id), season]));
  return {
    root_mal_id,
    selected_season_mal_id: selected_season_mal_id || seasons[0].mal_id,
    title_english,
    title_japanese: title_english,
    poster_url: '',
    genres: [],
    added_date: '2026-01-01T00:00:00.000Z',
    updated_date: updated_date || '2026-04-24T00:00:00.000Z',
    last_jikan_update: '2026-04-23T00:00:00.000Z',
    seasons: seasonMap,
  };
}

function getSeason(entry, malId) {
  return entry.seasons[String(malId)];
}

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}

runCase('simple 2-season franchise is stable and ordered', () => {
  const entry = makeEntry({
    root_mal_id: 1001,
    title_english: 'Chronicle Saga',
    seasons: [
      makeSeason({
        mal_id: 1001,
        title_english: 'Chronicle Saga Season 1',
        progress: 12,
        watch_status: 'completed',
        aired_at: '2019-01-01T00:00:00.000Z',
        relations: [{ mal_id: 1002, relation: 'Sequel' }],
      }),
      makeSeason({
        mal_id: 1002,
        title_english: 'Chronicle Saga Season 2',
        aired_at: '2021-01-01T00:00:00.000Z',
        relations: [{ mal_id: 1001, relation: 'Prequel' }],
      }),
    ],
  });

  const first = normalizeLibraryMetadata([entry]).library[0];
  const second = normalizeLibraryMetadata([first]).library[0];
  assert.equal(first.franchise_id, second.franchise_id);
  assert.equal(getSeason(first, 1001).franchise_order_index, 1);
  assert.equal(getSeason(first, 1002).franchise_order_index, 2);
  const continueAction = getContinueActionForAnime(first, [first]);
  assert.equal(continueAction?.label, 'Continue from S1 → S2');
});

runCase('split cour stays in same season arc', () => {
  const entry = makeEntry({
    root_mal_id: 2001,
    title_english: 'Aurora Front',
    seasons: [
      makeSeason({
        mal_id: 2001,
        title_english: 'Aurora Front Season 1 Part 1',
        aired_at: '2022-01-01T00:00:00.000Z',
        relations: [{ mal_id: 2002, relation: 'Sequel' }],
      }),
      makeSeason({
        mal_id: 2002,
        title_english: 'Aurora Front Season 1 Part 2',
        aired_at: '2022-10-01T00:00:00.000Z',
        relations: [{ mal_id: 2001, relation: 'Prequel' }],
      }),
    ],
  });

  const normalized = normalizeLibraryMetadata([entry]).library[0];
  assert.equal(getSeason(normalized, 2001).season_number, 1);
  assert.equal(getSeason(normalized, 2002).season_number, 1);
  assert.equal(getSeason(normalized, 2002).part_number, 2);
});

runCase('movies and specials stay attached without outranking the main sequel', () => {
  const entry = makeEntry({
    root_mal_id: 3001,
    title_english: 'Orbit Brigade',
    seasons: [
      makeSeason({
        mal_id: 3001,
        title_english: 'Orbit Brigade Season 1',
        progress: 12,
        watch_status: 'completed',
        aired_at: '2018-01-01T00:00:00.000Z',
        relations: [{ mal_id: 3002, relation: 'Side Story' }, { mal_id: 3003, relation: 'Sequel' }, { mal_id: 3004, relation: 'Sequel' }],
      }),
      makeSeason({
        mal_id: 3002,
        title_english: 'Orbit Brigade Movie',
        format: 'MOVIE',
        aired_at: '2018-06-01T00:00:00.000Z',
        relations: [{ mal_id: 3001, relation: 'Parent Story' }],
      }),
      makeSeason({
        mal_id: 3003,
        title_english: 'Orbit Brigade Special',
        format: 'SPECIAL',
        aired_at: '2018-07-01T00:00:00.000Z',
        relations: [{ mal_id: 3001, relation: 'Parent Story' }],
      }),
      makeSeason({
        mal_id: 3004,
        title_english: 'Orbit Brigade Season 2',
        aired_at: '2020-01-01T00:00:00.000Z',
        relations: [{ mal_id: 3001, relation: 'Prequel' }],
      }),
    ],
  });

  const normalized = normalizeLibraryMetadata([entry]).library[0];
  const cluster = buildFocusCluster([normalized], normalized);
  assert.equal(cluster.primaryNextWatch?.mal_id, 3004);
  assert.ok(getSeason(normalized, 3004).franchise_rank_score > getSeason(normalized, 3002).franchise_rank_score);
  assert.ok(getSeason(normalized, 3004).franchise_rank_score > getSeason(normalized, 3003).franchise_rank_score);
});

runCase('long-running series keeps stable long-run metadata', () => {
  const entry = makeEntry({
    root_mal_id: 4001,
    title_english: 'Endless Voyage',
    seasons: [
      makeSeason({
        mal_id: 4001,
        title_english: 'Endless Voyage',
        total_episodes: 500,
        episodes: 500,
        progress: 320,
        watch_status: 'watching',
        aired_at: '1999-01-01T00:00:00.000Z',
        last_progress_update: '2026-04-24T00:00:00.000Z',
      }),
    ],
  });

  const normalized = normalizeLibraryMetadata([entry]).library[0];
  assert.equal(normalized.is_one_long_running_series, true);
  assert.equal(getSeason(normalized, 4001).is_one_long_running_series, true);
  assert.equal(getSeason(normalized, 4001).season_number, 1);
});

runCase('4+ seasons with airing sequel pins the latest continuation', () => {
  const entry = makeEntry({
    root_mal_id: 5001,
    title_english: 'Skyline Record',
    selected_season_mal_id: 5004,
    seasons: [
      makeSeason({ mal_id: 5001, title_english: 'Skyline Record Season 1', progress: 12, watch_status: 'completed', aired_at: '2017-01-01T00:00:00.000Z', relations: [{ mal_id: 5002, relation: 'Sequel' }] }),
      makeSeason({ mal_id: 5002, title_english: 'Skyline Record Season 2', progress: 12, watch_status: 'completed', aired_at: '2018-01-01T00:00:00.000Z', relations: [{ mal_id: 5001, relation: 'Prequel' }, { mal_id: 5003, relation: 'Sequel' }] }),
      makeSeason({ mal_id: 5003, title_english: 'Skyline Record Season 3', progress: 12, watch_status: 'completed', aired_at: '2019-01-01T00:00:00.000Z', relations: [{ mal_id: 5002, relation: 'Prequel' }, { mal_id: 5004, relation: 'Sequel' }] }),
      makeSeason({ mal_id: 5004, title_english: 'Skyline Record Season 4', progress: 12, watch_status: 'completed', aired_at: '2021-01-01T00:00:00.000Z', relations: [{ mal_id: 5003, relation: 'Prequel' }, { mal_id: 5005, relation: 'Sequel' }] }),
      makeSeason({
        mal_id: 5005,
        title_english: 'Skyline Record Season 5',
        status: 'Currently Airing',
        airing: true,
        is_airing: true,
        aired_at: '2026-04-01T00:00:00.000Z',
        next_episode_airing_at: NOW + (6 * HOUR),
        next_episode_number: 4,
        relations: [{ mal_id: 5004, relation: 'Prequel' }],
      }),
    ],
  });

  const normalized = normalizeLibraryMetadata([entry]).library[0];
  const cluster = buildFocusCluster([normalized], normalized);
  assert.equal(cluster.currentAiringContinuation?.mal_id, 5005);
  assert.equal(cluster.primaryNextWatch?.mal_id, 5005);
  assert.equal(cluster.continueAction?.label, 'Continue from S4 → S5');
  assert.ok(getSeason(normalized, 5005).franchise_rank_score >= 95);
  assert.equal(getSeason(normalized, 5005).next_release_countdown.length, 11);
});

runCase('light sync candidates stay filtered', () => {
  const watchedFranchise = normalizeLibraryMetadata([
    makeEntry({
      root_mal_id: 6001,
      title_english: 'Active Path',
      seasons: [
        makeSeason({
          mal_id: 6001,
          title_english: 'Active Path Season 1',
          progress: 4,
          watch_status: 'watching',
          aired_at: '2025-01-01T00:00:00.000Z',
          last_progress_update: '2026-04-24T18:00:00.000Z',
          relations: [{ mal_id: 6002, relation: 'Sequel' }],
        }),
        makeSeason({
          mal_id: 6002,
          title_english: 'Active Path Season 2',
          aired_at: '2026-01-01T00:00:00.000Z',
          relations: [{ mal_id: 6001, relation: 'Prequel' }],
        }),
      ],
    }),
    makeEntry({
      root_mal_id: 7001,
      title_english: 'Dormant Single',
      updated_date: '2025-01-01T00:00:00.000Z',
      seasons: [
        makeSeason({
          mal_id: 7001,
          title_english: 'Dormant Single',
          aired_at: '2010-01-01T00:00:00.000Z',
          updated_date: '2025-01-01T00:00:00.000Z',
        }),
      ],
    }),
  ]).library;

  const candidates = getLightSyncCandidates(watchedFranchise);
  assert.deepEqual(candidates.map((entry) => entry.root_mal_id), [6001]);
});

if (process.exitCode) {
  console.error('Franchise verification failed.');
} else {
  console.log('All franchise verification cases passed.');
}
