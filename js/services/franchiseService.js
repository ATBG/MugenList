/**
 * franchiseService.js — Cached franchise resolution, chronology, and weighted ranking
 *
 * Goals:
 * - Stable franchise identity
 * - Deterministic chronology and continuation ranking
 * - Cached AniList relation graph usage on add/sync, never on render
 * - Local metadata normalization that preserves the existing root+seasons store shape
 */

import { graphqlFetch } from '../api.js';
import {
  getRootDisplayTitle,
  getRootWatchStatus,
  getSelectedSeason,
  getSeasonsArray,
  normalizeStatus,
} from '../state.js';
import { formatDurationDDHHMMSS } from '../utils.js';

export const FRANCHISE_META_VERSION = 3;

const GRAPH_CACHE_KEY = 'mugellist_franchise_graph_cache_v3';
const GRAPH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GRAPH_DEPTH = 4;
const SYNC_ACTIVE_WINDOW_MS = 72 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const RELATION_TYPES = new Set([
  'SEQUEL',
  'PREQUEL',
  'SIDE_STORY',
  'PARENT',
  'CHILD',
  'ALTERNATIVE_VERSION',
  'ALTERNATIVE_SETTING',
  'SPIN_OFF',
]);

const PRIMARY_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);
const LONG_RUNNING_FORMATS = new Set(['TV', 'TV_SHORT']);
const MOVIE_FORMATS = new Set(['MOVIE']);
const OVA_FORMATS = new Set(['OVA']);
const SPECIAL_FORMATS = new Set(['SPECIAL', 'TV_SPECIAL']);

const _graphCache = new Map();
let _persistentCacheLoaded = false;

export function normalizeLibraryMetadata(library, options = {}) {
  const source = Array.isArray(library) ? library : [];
  const targetRootIds = Array.isArray(options.targetRootIds) && options.targetRootIds.length > 0
    ? new Set(options.targetRootIds.map(Number))
    : null;

  let changed = false;
  let updatedLibrary = source.map((entry) => {
    const normalized = normalizeAnimeEntryLocal(entry);
    if (!isEntryStructurallyEqual(entry, normalized)) changed = true;
    return normalized;
  });

  const impactedFranchiseIds = new Set();
  if (!targetRootIds) {
    updatedLibrary.forEach((entry) => impactedFranchiseIds.add(getEntryFranchiseId(entry)));
  } else {
    updatedLibrary.forEach((entry) => {
      if (targetRootIds.has(Number(entry.root_mal_id))) {
        impactedFranchiseIds.add(getEntryFranchiseId(entry));
      }
    });
  }

  if (impactedFranchiseIds.size > 0) {
    const grouped = new Map();
    updatedLibrary.forEach((entry) => {
      const fid = getEntryFranchiseId(entry);
      if (!grouped.has(fid)) grouped.set(fid, []);
      grouped.get(fid).push(entry);
    });

    const replacements = new Map();
    for (const fid of impactedFranchiseIds) {
      const entries = grouped.get(fid) || [];
      for (const entry of applyGroupRanking(entries)) {
        replacements.set(Number(entry.root_mal_id), entry);
      }
    }

    updatedLibrary = updatedLibrary.map((entry) => {
      const replacement = replacements.get(Number(entry.root_mal_id));
      if (!replacement) return entry;
      if (!isEntryStructurallyEqual(entry, replacement)) changed = true;
      return replacement;
    });
  }

  return { library: updatedLibrary, changed };
}

export function normalizeAnimeEntry(anime) {
  return normalizeAnimeEntryLocal(anime);
}

export async function resolveFranchise(anime, library = [], options = {}) {
  if (!anime) return null;

  const allowNetwork = options.allowNetwork !== false;
  const seedMalId = Number(anime.selected_season_mal_id || anime.root_mal_id);
  const localCluster = buildLocalCluster(anime);

  let remoteCluster = null;
  if (allowNetwork) {
    try {
      remoteCluster = await buildRelationCluster(seedMalId, options);
    } catch (err) {
      console.warn(`[Franchise] Graph resolution failed for ${anime.root_mal_id}:`, err);
    }
  }

  const mergedNodes = new Map(localCluster.nodes);
  const mergedEdges = new Map(localCluster.edges);

  if (remoteCluster) {
    for (const [id, node] of remoteCluster.nodes.entries()) {
      mergedNodes.set(id, mergeGraphNodes(node, mergedNodes.get(id)));
    }
    mergeEdgeMaps(mergedEdges, remoteCluster.edges);
  }

  const rootNode = computeFranchiseRoot(mergedNodes, mergedEdges, anime.root_mal_id);
  const orderedNodes = computeOrderedNodes(mergedNodes, mergedEdges, rootNode?.mal_id || anime.root_mal_id);
  const byMalId = new Map(orderedNodes.map((node) => [Number(node.mal_id), node]));

  const selectedSeason = anime.seasons?.[String(anime.selected_season_mal_id)] || Object.values(anime.seasons || {})[0] || null;
  const selectedMeta = selectedSeason ? byMalId.get(Number(selectedSeason.mal_id)) : null;

  const franchiseId = rootNode?.anilist_id
    ? `ani-${rootNode.anilist_id}`
    : `mal-${Number(rootNode?.mal_id || anime.root_mal_id)}`;

  const seasonMetaByMalId = {};
  for (const season of getSeasonsArray(anime)) {
    const meta = byMalId.get(Number(season.mal_id));
    if (!meta) continue;
    seasonMetaByMalId[String(season.mal_id)] = {
      anilist_id: meta.anilist_id || season.anilist_id || null,
      format: meta.format || season.format || 'TV',
      aired_at: meta.aired_at || season.aired_at || null,
      season_number: meta.season_number,
      part_number: meta.part_number,
      franchise_order_index: meta.franchise_order_index,
      is_movie: meta.is_movie,
      is_ova: meta.is_ova,
      is_special: meta.is_special,
      is_one_long_running_series: meta.is_one_long_running_series,
    };
  }

  const selectedOrderIndex = selectedMeta?.franchise_order_index || 1;
  const hasPrequel = selectedMeta
    ? Array.from(mergedEdges.get(Number(selectedMeta.mal_id)) || []).some((edge) => edge.relationType === 'PREQUEL')
    : false;

  return {
    franchise_id: franchiseId,
    franchise_root_id: Number(rootNode?.mal_id || anime.root_mal_id),
    anilist_id: selectedMeta?.anilist_id || rootNode?.anilist_id || anime.anilist_id || null,
    franchise_cluster_members: orderedNodes.map((node) => Number(node.mal_id)),
    franchise_resolution_source: remoteCluster ? 'anilist-graph' : 'local-fallback',
    franchise_cache_updated_at: new Date().toISOString(),
    franchise_meta_version: FRANCHISE_META_VERSION,
    franchise_order_index: selectedOrderIndex,
    is_sequel_confirmed: hasPrequel || selectedOrderIndex > 1,
    seasonMetaByMalId,
    sync_status: remoteCluster ? 'synced' : (anime.sync_status || 'pending'),
  };
}

export function applyResolvedFranchisePatch(anime, resolved, library = []) {
  if (!anime) return anime;
  if (!resolved) return normalizeAnimeEntryLocal(anime);

  const seasons = {};
  for (const [sid, season] of Object.entries(anime.seasons || {})) {
    const patch = resolved.seasonMetaByMalId?.[sid] || {};
    seasons[sid] = { ...season, ...patch };
  }

  const merged = {
    ...anime,
    franchise_id: resolved.franchise_id,
    franchise_root_id: Number(resolved.franchise_root_id || anime.root_mal_id),
    franchise_cluster_members: resolved.franchise_cluster_members || anime.franchise_cluster_members || [Number(anime.root_mal_id)],
    franchise_resolution_source: resolved.franchise_resolution_source || anime.franchise_resolution_source || 'local-fallback',
    franchise_cache_updated_at: resolved.franchise_cache_updated_at || new Date().toISOString(),
    franchise_meta_version: resolved.franchise_meta_version || FRANCHISE_META_VERSION,
    franchise_order_index: resolved.franchise_order_index || anime.franchise_order_index || 1,
    anilist_id: resolved.anilist_id || anime.anilist_id || null,
    is_sequel_confirmed: resolved.is_sequel_confirmed ?? anime.is_sequel_confirmed ?? false,
    sync_status: resolved.sync_status || anime.sync_status || 'synced',
    seasons,
  };

  return normalizeLibraryMetadata(
    replaceEntry(Array.isArray(library) && library.length > 0 ? library : [merged], merged),
    { targetRootIds: [merged.root_mal_id] }
  ).library.find((entry) => Number(entry.root_mal_id) === Number(merged.root_mal_id)) || normalizeAnimeEntryLocal(merged);
}

export function calculateFranchiseBoost(anime, library, context = {}) {
  if (!anime) return 0;
  const selectedSeason = anime.seasons?.[String(anime.selected_season_mal_id)] || Object.values(anime.seasons || {})[0] || null;
  if (!selectedSeason) return 0;

  const group = getFranchiseEntries(library, anime);
  const ranked = applyGroupRanking(group);
  const rankedEntry = ranked.find((entry) => Number(entry.root_mal_id) === Number(anime.root_mal_id)) || anime;
  const baseScore = Number(rankedEntry.franchise_rank_score || selectedSeason.franchise_rank_score || 0);

  if (context.focusFranchiseId && context.focusFranchiseId === getEntryFranchiseId(anime)) {
    return baseScore + 30;
  }

  return baseScore;
}

export function sortFranchiseCandidates(entries, library, context = {}) {
  return [...(entries || [])].sort((left, right) => compareEntriesByRank(left, right, library, context));
}

export function getRankedFranchiseCandidates(library, options = {}) {
  const entries = Array.isArray(options.entries) ? options.entries : (library || []);
  return [...entries].sort((left, right) => compareEntriesByRank(left, right, library, options));
}

export function getLightSyncCandidates(library) {
  const now = Date.now();
  return (library || []).filter((entry) => {
    const selectedSeason = getSelectedSeason(entry);
    const watchedAnySeason = getSeasonsArray(entry).some((season) => (season.progress || 0) > 0 || normalizeStatus(season.watch_status) === 'completed');
    const hasKnownSequels = Array.isArray(entry.franchise_cluster_members)
      ? entry.franchise_cluster_members.length > 1
      : getSeasonsArray(entry).some((season) => Array.isArray(season.relations) && season.relations.some((rel) => rel?.relation === 'Sequel'));
    const lastWatchedAt = getEntryLastWatchedAtMs(entry);
    const lastUpdatedAt = parseDateMs(entry.updated_date || entry.updated_at);
    const recentlyActive = (lastWatchedAt && (now - lastWatchedAt) < SYNC_ACTIVE_WINDOW_MS) ||
      (lastUpdatedAt && (now - lastUpdatedAt) < SYNC_ACTIVE_WINDOW_MS);

    return watchedAnySeason || hasKnownSequels || recentlyActive || Boolean(selectedSeason?.is_airing && watchedAnySeason);
  });
}

export function buildFocusCluster(library, anime) {
  const { rankedEntries, orderedSeasons, flatSeasons, airingPrimary } = buildFocusDataset(library, anime);
  const primaryNextWatch = choosePrimaryNextWatch(flatSeasons, anime);
  const currentAiringContinuation = airingPrimary[0] || null;
  const continueAction = buildContinueActionFromSeasons(orderedSeasons);

  return {
    entries: rankedEntries,
    seasons: orderedSeasons,
    primaryNextWatch,
    currentAiringContinuation,
    adjacentSeasons: getAdjacentSeasons(orderedSeasons, anime.selected_season_mal_id),
    continueAction,
  };
}

export function getContinueActionForAnime(anime, library) {
  if (!anime) return null;

  const maybeSeasons = Array.isArray(library) ? library : [];
  const seasons = maybeSeasons.length > 0 && maybeSeasons.every((item) => Number(item?.mal_id))
    ? maybeSeasons
    : buildFocusDataset(maybeSeasons, anime).orderedSeasons;

  return buildContinueActionFromSeasons(seasons);
}

function compareEntriesByRank(left, right, library, context = {}) {
  const leftScore = calculateFranchiseBoost(left, library, context);
  const rightScore = calculateFranchiseBoost(right, library, context);
  if (rightScore !== leftScore) return rightScore - leftScore;

  const leftOrder = Number(left.franchise_order_index || getSelectedSeason(left)?.franchise_order_index || 9999);
  const rightOrder = Number(right.franchise_order_index || getSelectedSeason(right)?.franchise_order_index || 9999);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;

  const leftId = Number(left.root_mal_id || 0);
  const rightId = Number(right.root_mal_id || 0);
  if (leftId !== rightId) return leftId - rightId;

  return String(getRootDisplayTitle(left)).localeCompare(getRootDisplayTitle(right));
}

function applyGroupRanking(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const flattened = [];
  for (const entry of entries) {
    for (const season of getSeasonsArray(entry)) {
      flattened.push({
        ...season,
        parent_root_id: Number(entry.root_mal_id),
        parent_entry: entry,
      });
    }
  }

  const ordered = [...flattened].sort((a, b) =>
    Number(a.franchise_order_index || 9999) - Number(b.franchise_order_index || 9999) ||
    safeToMs(a.aired_at) - safeToMs(b.aired_at) ||
    Number(a.mal_id) - Number(b.mal_id)
  );

  const watchedOrders = ordered
    .filter((season) => normalizeStatus(season.watch_status) === 'completed' || (season.progress || 0) > 0)
    .map((season) => Number(season.franchise_order_index || 0))
    .filter(Boolean);

  const maxWatchedOrder = watchedOrders.length > 0 ? Math.max(...watchedOrders) : 0;
  const watchedSet = new Set(watchedOrders);

  const updatedByRoot = new Map(entries.map((entry) => [Number(entry.root_mal_id), { ...entry, seasons: { ...entry.seasons } }]));
  for (const season of ordered) {
    const hasPrevious = watchedOrders.some((order) => order < Number(season.franchise_order_index || 0));
    const score = computeSeasonRankScore(season, { watchedSet, maxWatchedOrder, hasPrevious });
    const root = updatedByRoot.get(Number(season.parent_root_id));
    if (!root) continue;

    root.seasons[String(season.mal_id)] = {
      ...root.seasons[String(season.mal_id)],
      has_user_watched_previous: hasPrevious,
      franchise_rank_score: score,
      next_release_countdown: getCountdownLabel(root.seasons[String(season.mal_id)]?.next_episode_airtime || root.seasons[String(season.mal_id)]?.next_episode_airing_at),
    };
  }

  const result = [];
  for (const entry of entries) {
    const updatedEntry = updatedByRoot.get(Number(entry.root_mal_id)) || entry;
    const selectedSeason = updatedEntry.seasons?.[String(updatedEntry.selected_season_mal_id)] || Object.values(updatedEntry.seasons || {})[0] || null;
    result.push({
      ...updatedEntry,
      has_user_watched_previous: !!selectedSeason?.has_user_watched_previous,
      franchise_rank_score: Number(selectedSeason?.franchise_rank_score || 0),
      franchise_order_index: Number(selectedSeason?.franchise_order_index || updatedEntry.franchise_order_index || 1),
      next_episode_airtime: selectedSeason?.next_episode_airtime || selectedSeason?.next_episode_airing_at || null,
      next_release_countdown: getCountdownLabel(selectedSeason?.next_episode_airtime || selectedSeason?.next_episode_airing_at),
      last_watched_at: getEntryLastWatchedAtIso(updatedEntry),
      watch_state: getRootWatchStatus(updatedEntry),
    });
  }

  return result;
}

function computeSeasonRankScore(season, context) {
  let score = 0;

  if ((context.watchedSet?.size || 0) > 0) score += 30;
  if (Number(season.franchise_order_index || 0) > Number(context.maxWatchedOrder || 0) && Number(context.maxWatchedOrder || 0) > 0) score += 25;
  if (season.is_airing) score += 20;

  const nextAt = season.next_episode_airtime || season.next_episode_airing_at;
  if (nextAt && (Number(nextAt) - Date.now()) > 0 && (Number(nextAt) - Date.now()) <= DAY_MS) score += 15;

  if (context.hasPrevious) score += 10;

  if (season.is_movie) score -= 12;
  if (season.is_ova) score -= 16;
  if (season.is_special) score -= 18;
  if (season.is_one_long_running_series && season.is_airing) score += 8;

  return score;
}

function normalizeAnimeEntryLocal(anime) {
  if (!anime) return anime;

  const cluster = buildLocalCluster(anime);
  const rootNode = computeFranchiseRoot(cluster.nodes, cluster.edges, anime.root_mal_id);
  const orderedNodes = computeOrderedNodes(cluster.nodes, cluster.edges, rootNode?.mal_id || anime.root_mal_id);
  const byMalId = new Map(orderedNodes.map((node) => [Number(node.mal_id), node]));

  const seasons = {};
  let latestWatchedAt = 0;
  let totalEpisodes = 0;

  for (const [sid, originalSeason] of Object.entries(anime.seasons || {})) {
    const season = { ...originalSeason };
    const node = byMalId.get(Number(originalSeason.mal_id)) || buildLocalNode(originalSeason, anime);
    const flags = inferFormatDetails(season.format || node.format);
    const lastWatchedAt = parseDateMs(season.last_watched_at || season.last_progress_update || season.started_watching_date);
    latestWatchedAt = Math.max(latestWatchedAt, lastWatchedAt || 0);

    const nextEpisodeAirtime = Number(season.next_episode_airtime || season.next_episode_airing_at || 0) || null;
    totalEpisodes += Number(season.total_episodes || season.episodes || 0);

    seasons[sid] = {
      ...season,
      id: Number(season.mal_id),
      title: season.title || season.title_english || season.title_japanese || 'Unknown',
      native_title: season.native_title || season.title_japanese || season.title_english || 'Unknown',
      format: flags.format,
      status: season.status || 'Unknown',
      episodes: Number(season.episodes || season.total_episodes || 0),
      aired_at: season.aired_at || node.aired_at || null,
      updated_at: season.updated_at || season.updated_date || anime.updated_date || anime.added_date || null,
      season_number: Number(season.season_number || node.season_number || 1),
      part_number: season.part_number ?? node.part_number ?? null,
      is_airing: Boolean(season.is_airing || season.status === 'Currently Airing' || nextEpisodeAirtime),
      is_movie: Boolean(season.is_movie ?? flags.is_movie),
      is_ova: Boolean(season.is_ova ?? flags.is_ova),
      is_special: Boolean(season.is_special ?? flags.is_special),
      is_one_long_running_series: Boolean(season.is_one_long_running_series),
      anilist_id: season.anilist_id || node.anilist_id || null,
      relations: Array.isArray(season.relations) ? season.relations : [],
      franchise_id: season.franchise_id || anime.franchise_id || `mal-${Number(rootNode?.mal_id || anime.root_mal_id)}`,
      franchise_root_id: Number(season.franchise_root_id || anime.franchise_root_id || rootNode?.mal_id || anime.root_mal_id),
      franchise_order_index: Number(season.franchise_order_index || node.franchise_order_index || 1),
      franchise_rank_score: Number(season.franchise_rank_score || 0),
      watch_state: normalizeStatus(season.watch_state || season.watch_status),
      last_watched_at: season.last_watched_at || season.last_progress_update || season.started_watching_date || null,
      next_episode_airtime: nextEpisodeAirtime,
      next_release_countdown: getCountdownLabel(nextEpisodeAirtime),
      has_user_watched_previous: Boolean(season.has_user_watched_previous),
      sync_status: season.sync_status || anime.sync_status || 'pending',
      source_updated_at: season.source_updated_at || anime.last_jikan_update || null,
    };
  }

  const selectedSeasonId = Number(anime.selected_season_mal_id || Object.keys(seasons)[0] || anime.root_mal_id);
  const selectedSeason = seasons[String(selectedSeasonId)] || Object.values(seasons)[0] || null;
  const isLongRunning = totalEpisodes >= 150 || (orderedNodes.filter((node) => !node.is_movie && !node.is_ova && !node.is_special).length <= 1 && totalEpisodes >= 100);

  for (const season of Object.values(seasons)) {
    season.is_one_long_running_series = isLongRunning;
  }

  // Determine a robust raw root title from available sources (prefer explicit root, then season, then node)
  const rootTitleCandidates = [
    anime.title,
    anime.title_english,
    anime.title_japanese,
    anime.native_title,
    selectedSeason?.title,
    selectedSeason?.title_english,
    selectedSeason?.title_japanese,
    rootNode?.title,
    rootNode?.native_title,
  ];
  const rawRootTitle = (rootTitleCandidates.find((v) => v && String(v).trim()) || 'Unknown').toString().trim();
  const normalizedRootTitle = normalizeRootTitle(rawRootTitle);

  return {
    ...anime,
    id: Number(anime.root_mal_id),
    title: anime.title || anime.title_english || anime.title_japanese || 'Unknown',
    native_title: anime.native_title || anime.title_japanese || anime.title_english || 'Unknown',
    // Preserve original and provide a cleaned franchise-level root title
    raw_title: anime.raw_title || rawRootTitle,
    normalized_root_title: anime.normalized_root_title || normalizedRootTitle,
    title_clean: anime.title_clean || normalizedRootTitle,
    format: selectedSeason?.format || anime.format || 'TV',
    status: selectedSeason?.status || anime.status || 'Unknown',
    episodes: Number(selectedSeason?.episodes || selectedSeason?.total_episodes || anime.episodes || 0),
    aired_at: selectedSeason?.aired_at || anime.aired_at || anime.added_date || null,
    updated_at: anime.updated_at || anime.updated_date || anime.added_date || null,
    season_number: Number(selectedSeason?.season_number || anime.season_number || 1),
    part_number: selectedSeason?.part_number ?? anime.part_number ?? null,
    is_airing: Boolean(selectedSeason?.is_airing),
    is_movie: Boolean(selectedSeason?.is_movie),
    is_ova: Boolean(selectedSeason?.is_ova),
    is_special: Boolean(selectedSeason?.is_special),
    is_one_long_running_series: isLongRunning,
    anilist_id: anime.anilist_id || selectedSeason?.anilist_id || rootNode?.anilist_id || null,
    relations: collectRootRelations(seasons),
    franchise_id: anime.franchise_id || `mal-${Number(rootNode?.mal_id || anime.root_mal_id)}`,
    franchise_root_id: Number(anime.franchise_root_id || rootNode?.mal_id || anime.root_mal_id),
    franchise_order_index: Number(anime.franchise_order_index || selectedSeason?.franchise_order_index || 1),
    franchise_rank_score: Number(anime.franchise_rank_score || selectedSeason?.franchise_rank_score || 0),
    watch_state: anime.watch_state || getRootWatchStatus({ ...anime, seasons }),
    last_watched_at: anime.last_watched_at || (latestWatchedAt ? new Date(latestWatchedAt).toISOString() : null),
    next_episode_airtime: selectedSeason?.next_episode_airtime || null,
    next_release_countdown: selectedSeason?.next_release_countdown || null,
    has_user_watched_previous: Boolean(anime.has_user_watched_previous || selectedSeason?.has_user_watched_previous),
    sync_status: anime.sync_status || 'pending',
    franchise_meta_version: anime.franchise_meta_version || FRANCHISE_META_VERSION,
    franchise_cache_updated_at: anime.franchise_cache_updated_at || anime.updated_date || anime.added_date || new Date().toISOString(),
    seasons,
  };
}

async function buildRelationCluster(seedMalId, options = {}) {
  const nodes = new Map();
  const edges = new Map();
  const visited = new Set();
  const queue = [{ idMal: Number(seedMalId), depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || !current.idMal || visited.has(current.idMal) || current.depth > (options.maxDepth || MAX_GRAPH_DEPTH)) continue;
    visited.add(current.idMal);

    const payload = await fetchAniListMediaNode(current.idMal, options);
    if (!payload) continue;

    nodes.set(Number(payload.node.mal_id), payload.node);
    if (!edges.has(Number(payload.node.mal_id))) edges.set(Number(payload.node.mal_id), []);

    for (const relation of payload.relations) {
      if (!relation?.mal_id || !RELATION_TYPES.has(relation.relationType)) continue;
      nodes.set(Number(relation.mal_id), relation);
      edges.get(Number(payload.node.mal_id)).push({
        targetId: Number(relation.mal_id),
        relationType: relation.relationType,
      });
      if (!visited.has(Number(relation.mal_id))) {
        queue.push({ idMal: Number(relation.mal_id), depth: current.depth + 1 });
      }
    }
  }

  return { nodes, edges };
}

async function fetchAniListMediaNode(idMal, options = {}) {
  const cached = getCachedGraphNode(Number(idMal), options.force === true);
  if (cached) return cached;

  const query = `
    query ($idMal: Int) {
      Media(idMal: $idMal, type: ANIME) {
        id
        idMal
        format
        status
        episodes
        season
        seasonYear
        title {
          romaji
          english
          native
        }
        startDate {
          year
          month
          day
        }
        nextAiringEpisode {
          airingAt
          episode
        }
        relations {
          edges {
            relationType
            node {
              id
              idMal
              type
              format
              status
              episodes
              season
              seasonYear
              title {
                romaji
                english
                native
              }
              startDate {
                year
                month
                day
              }
              nextAiringEpisode {
                airingAt
                episode
              }
            }
          }
        }
      }
    }
  `;

  const res = await graphqlFetch(query, { idMal: Number(idMal) }, true);
  const media = res?.data?.Media;
  if (!media?.idMal) return null;

  const payload = {
    node: mapAniListMedia(media),
    relations: (media.relations?.edges || [])
      .filter((edge) => edge?.node?.type === 'ANIME' && edge?.node?.idMal)
      .map((edge) => mapAniListMedia(edge.node, edge.relationType)),
  };

  setCachedGraphNode(Number(idMal), payload);
  return payload;
}

function mapAniListMedia(media, relationType = null) {
  const flags = inferFormatDetails(media?.format);
  return {
    anilist_id: Number(media?.id || 0) || null,
    mal_id: Number(media?.idMal || 0) || null,
    title: media?.title?.english || media?.title?.romaji || media?.title?.native || 'Unknown',
    native_title: media?.title?.native || media?.title?.romaji || media?.title?.english || 'Unknown',
    format: flags.format,
    status: media?.status || 'UNKNOWN',
    episodes: Number(media?.episodes || 0),
    season: media?.season || null,
    seasonYear: media?.seasonYear || null,
    aired_at: buildAniListDate(media?.startDate),
    next_episode_airtime: media?.nextAiringEpisode?.airingAt ? Number(media.nextAiringEpisode.airingAt) * 1000 : null,
    next_episode_number: media?.nextAiringEpisode?.episode || null,
    is_airing: Boolean(media?.nextAiringEpisode?.airingAt) || String(media?.status || '').toUpperCase() === 'RELEASING',
    is_movie: flags.is_movie,
    is_ova: flags.is_ova,
    is_special: flags.is_special,
    is_one_long_running_series: false,
    relationType,
  };
}

function buildLocalCluster(anime) {
  const nodes = new Map();
  const edges = new Map();

  for (const season of getSeasonsArray({ seasons: anime.seasons || {} })) {
    const node = buildLocalNode(season, anime);
    nodes.set(Number(node.mal_id), node);
    if (!edges.has(Number(node.mal_id))) edges.set(Number(node.mal_id), []);
  }

  for (const season of getSeasonsArray({ seasons: anime.seasons || {} })) {
    const sourceId = Number(season.mal_id);
    if (!edges.has(sourceId)) edges.set(sourceId, []);
    for (const relation of season.relations || []) {
      if (!relation?.mal_id) continue;
      const relationType = mapRelationLabel(relation.relation);
      if (!RELATION_TYPES.has(relationType)) continue;
      edges.get(sourceId).push({
        targetId: Number(relation.mal_id),
        relationType,
      });
    }
  }

  return { nodes, edges };
}

function buildLocalNode(season, anime) {
  const flags = inferFormatDetails(season.format || deriveLocalFormat(season));
  return {
    anilist_id: season.anilist_id || null,
    mal_id: Number(season.mal_id),
    title: season.title || season.title_english || season.title_japanese || getRootDisplayTitle(anime),
    native_title: season.native_title || season.title_japanese || season.title_english || getRootDisplayTitle(anime),
    format: flags.format,
    status: season.status || 'UNKNOWN',
    episodes: Number(season.total_episodes || season.episodes || 0),
    season: season.season_label || null,
    seasonYear: season.season_year || null,
    aired_at: season.aired_at || season.added_date || anime.added_date || null,
    next_episode_airtime: Number(season.next_episode_airtime || season.next_episode_airing_at || 0) || null,
    next_episode_number: season.next_episode_number || null,
    is_airing: Boolean(season.is_airing || season.status === 'Currently Airing' || season.next_episode_airing_at),
    is_movie: flags.is_movie,
    is_ova: flags.is_ova,
    is_special: flags.is_special,
    is_one_long_running_series: false,
    relationType: null,
  };
}

function buildFocusDataset(library, anime) {
  const focusEntries = getFranchiseEntries(library, anime).map((entry) => normalizeAnimeEntryLocal(entry));
  const rankedEntries = applyGroupRanking(focusEntries);
  const flatSeasons = [];

  for (const entry of rankedEntries) {
    for (const season of getSeasonsArray(entry)) {
      flatSeasons.push({
        ...season,
        parent_root_id: Number(entry.root_mal_id),
        parent_title: getRootDisplayTitle(entry),
        root_entry: entry,
        selected: Number(entry.selected_season_mal_id) === Number(season.mal_id),
      });
    }
  }

  const primary = flatSeasons.filter((season) => !season.is_movie && !season.is_ova && !season.is_special);
  const supplemental = flatSeasons.filter((season) => season.is_movie || season.is_ova || season.is_special);

  const airingPrimary = primary
    .filter((season) => season.is_airing)
    .sort((a, b) => compareSeasonDisplayOrder(a, b, true));

  const nonAiringPrimary = primary
    .filter((season) => !season.is_airing)
    .sort((a, b) => compareSeasonDisplayOrder(a, b, false));

  const supplementalSorted = supplemental.sort((a, b) => compareSeasonDisplayOrder(a, b, false));
  const orderedSeasons = [...airingPrimary, ...nonAiringPrimary, ...supplementalSorted];

  return { rankedEntries, flatSeasons, airingPrimary, orderedSeasons };
}

function buildContinueActionFromSeasons(seasons) {
  if (!Array.isArray(seasons) || seasons.length === 0) return null;

  const sortedChronological = [...seasons].sort((a, b) =>
    Number(a.franchise_order_index || 9999) - Number(b.franchise_order_index || 9999) ||
    Number(a.mal_id) - Number(b.mal_id)
  );

  const watched = sortedChronological.filter((season) => {
    const state = normalizeStatus(season.watch_status);
    return state === 'completed' || (season.progress || 0) > 0;
  });

  if (watched.length === 0) return null;

  const latestWatched = watched[watched.length - 1];
  const target = sortedChronological.find((season) => {
    if (Number(season.franchise_order_index || 0) <= Number(latestWatched.franchise_order_index || 0)) return false;
    if (season.is_movie || season.is_ova || season.is_special) return false;
    return normalizeStatus(season.watch_status) !== 'completed';
  });

  if (!target) return null;

  return {
    from: latestWatched,
    to: target,
    label: `Continue from S${latestWatched.season_number || '?'} → S${target.season_number || '?'}`,
  };
}

function computeFranchiseRoot(nodes, edges, fallbackRootMalId) {
  const records = Array.from(nodes.values());
  if (records.length === 0) {
    return { mal_id: Number(fallbackRootMalId), anilist_id: null };
  }

  const rootCandidates = records.filter((record) => {
    const outgoing = edges.get(Number(record.mal_id)) || [];
    return !outgoing.some((edge) => edge.relationType === 'PREQUEL' && nodes.has(Number(edge.targetId)));
  });

  const orderedCandidates = (rootCandidates.length > 0 ? rootCandidates : records).sort((left, right) => {
    const leftSupplemental = getSupplementalPenalty(left);
    const rightSupplemental = getSupplementalPenalty(right);
    if (leftSupplemental !== rightSupplemental) return leftSupplemental - rightSupplemental;

    const leftDate = safeToMs(left.aired_at);
    const rightDate = safeToMs(right.aired_at);
    if (leftDate !== rightDate) return leftDate - rightDate;

    const leftSeasonHint = parseTitleHints(left.title || left.native_title || '').seasonOrdinal || 9999;
    const rightSeasonHint = parseTitleHints(right.title || right.native_title || '').seasonOrdinal || 9999;
    if (leftSeasonHint !== rightSeasonHint) return leftSeasonHint - rightSeasonHint;

    const leftId = Number(left.anilist_id || left.mal_id || Number.MAX_SAFE_INTEGER);
    const rightId = Number(right.anilist_id || right.mal_id || Number.MAX_SAFE_INTEGER);
    return leftId - rightId;
  });

  return orderedCandidates[0];
}

function computeOrderedNodes(nodes, edges, fallbackRootMalId) {
  const records = Array.from(nodes.values()).map((node) => ({
    ...node,
    hints: parseTitleHints(node.title || node.native_title || ''),
  }));

  const primary = records.filter((record) => !record.is_movie && !record.is_ova && !record.is_special);
  const supplemental = records.filter((record) => record.is_movie || record.is_ova || record.is_special);

  const sortedPrimary = primary.sort((left, right) => comparePrimaryChronology(left, right));
  const assignedPrimary = [];

  for (const record of sortedPrimary) {
    const previous = assignedPrimary[assignedPrimary.length - 1] || null;
    const nextMeta = assignPrimarySeasonMeta(record, previous, edges);
    assignedPrimary.push(nextMeta);
  }

  const longRunning = assignedPrimary.length <= 1 && assignedPrimary.reduce((sum, record) => sum + Number(record.episodes || 0), 0) >= 100;

  const supplementalAssigned = supplemental
    .sort((left, right) => comparePrimaryChronology(left, right))
    .map((record) => assignSupplementalSeasonMeta(record, assignedPrimary, longRunning));

  for (const record of assignedPrimary) {
    record.is_one_long_running_series = longRunning || (LONG_RUNNING_FORMATS.has(record.format) && Number(record.episodes || 0) >= 150);
  }

  const groupedSupplementals = new Map();
  for (const record of supplementalAssigned) {
    const key = Number(record._associated_primary_order || 0);
    if (!groupedSupplementals.has(key)) groupedSupplementals.set(key, []);
    groupedSupplementals.get(key).push(record);
  }

  const ordered = [];
  for (const record of assignedPrimary) {
    ordered.push(record);
    const extras = groupedSupplementals.get(Number(record._primary_order_anchor || 0)) || [];
    extras.sort((left, right) => safeToMs(left.aired_at) - safeToMs(right.aired_at) || Number(left.mal_id) - Number(right.mal_id));
    ordered.push(...extras);
  }

  if (assignedPrimary.length === 0) {
    ordered.push(...supplementalAssigned);
  }

  ordered.forEach((record, index) => {
    record.franchise_order_index = index + 1;
    if (!record.is_one_long_running_series) {
      record.is_one_long_running_series = longRunning;
    }
  });

  if (ordered.length === 0) {
    const fallback = nodes.get(Number(fallbackRootMalId));
    if (fallback) {
      return [{ ...fallback, season_number: 1, part_number: null, franchise_order_index: 1 }];
    }
  }

  return ordered;
}

function assignPrimarySeasonMeta(record, previous, edges) {
  if (!previous) {
    return {
      ...record,
      season_number: record.hints.seasonOrdinal || 1,
      part_number: record.hints.partOrdinal || null,
      _primary_order_anchor: 1,
    };
  }

  const splitCour = isSplitCour(previous, record, edges);
  if (splitCour) {
    return {
      ...record,
      season_number: previous.season_number,
      part_number: previous.part_number ? previous.part_number + 1 : 2,
      _primary_order_anchor: previous._primary_order_anchor + 1,
    };
  }

  const explicitSeason = record.hints.seasonOrdinal;
  const seasonNumber = explicitSeason && explicitSeason >= previous.season_number
    ? explicitSeason
    : previous.season_number + 1;

  return {
    ...record,
    season_number: seasonNumber,
    part_number: record.hints.partOrdinal || null,
    _primary_order_anchor: previous._primary_order_anchor + 1,
  };
}

function assignSupplementalSeasonMeta(record, primaryRecords, longRunning) {
  if (primaryRecords.length === 0) {
    return {
      ...record,
      season_number: 1,
      part_number: record.hints.partOrdinal || null,
      is_one_long_running_series: longRunning,
      _associated_primary_order: 0,
    };
  }

  const airedAt = safeToMs(record.aired_at);
  let associated = primaryRecords[0];
  for (const primary of primaryRecords) {
    if (safeToMs(primary.aired_at) <= airedAt) associated = primary;
  }

  return {
    ...record,
    season_number: associated.season_number,
    part_number: record.hints.partOrdinal || null,
    is_one_long_running_series: longRunning,
    _associated_primary_order: associated._primary_order_anchor,
  };
}

function isSplitCour(previous, current, edges) {
  const previousBase = normalizeBaseTitle(previous.title || previous.native_title || '');
  const currentBase = normalizeBaseTitle(current.title || current.native_title || '');
  const previousHints = previous.hints || parseTitleHints(previous.title || previous.native_title || '');
  const currentHints = current.hints || parseTitleHints(current.title || current.native_title || '');

  const linkedAsDirectSequel = Array.from(edges.get(Number(current.mal_id)) || []).some((edge) =>
    edge.relationType === 'PREQUEL' && Number(edge.targetId) === Number(previous.mal_id)
  ) || Array.from(edges.get(Number(previous.mal_id)) || []).some((edge) =>
    edge.relationType === 'SEQUEL' && Number(edge.targetId) === Number(current.mal_id)
  );

  const sameBase = previousBase && currentBase && previousBase === currentBase;
  const partDriven = currentHints.partOrdinal && (!currentHints.seasonOrdinal || currentHints.seasonOrdinal === previous.season_number);
  const closeReleaseGap = Math.abs(safeToMs(current.aired_at) - safeToMs(previous.aired_at)) <= (450 * DAY_MS);

  return linkedAsDirectSequel && sameBase && (partDriven || (previousHints.seasonOrdinal === currentHints.seasonOrdinal && closeReleaseGap));
}

function comparePrimaryChronology(left, right) {
  const leftHint = left.hints.seasonOrdinal || Number.MAX_SAFE_INTEGER;
  const rightHint = right.hints.seasonOrdinal || Number.MAX_SAFE_INTEGER;
  if (leftHint !== rightHint) return leftHint - rightHint;

  const leftDate = safeToMs(left.aired_at);
  const rightDate = safeToMs(right.aired_at);
  if (leftDate !== rightDate) return leftDate - rightDate;

  const leftPart = left.hints.partOrdinal || 0;
  const rightPart = right.hints.partOrdinal || 0;
  if (leftPart !== rightPart) return leftPart - rightPart;

  return Number(left.mal_id) - Number(right.mal_id);
}

function parseTitleHints(title) {
  const source = String(title || '').trim();
  const lower = source.toLowerCase();

  const seasonPatterns = [
    /season\s+(\d+)/i,
    /(\d+)(?:st|nd|rd|th)\s+season/i,
    /\bs(\d+)\b/i,
    /part\s+(\d+)/i,
  ];

  const partPatterns = [
    /part\s+(\d+)/i,
    /cour\s+(\d+)/i,
    /(\d+)(?:st|nd|rd|th)\s+part/i,
  ];

  let seasonOrdinal = null;
  let partOrdinal = null;

  for (const pattern of seasonPatterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      seasonOrdinal = Number(match[1]);
      break;
    }
  }

  for (const pattern of partPatterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      partOrdinal = Number(match[1]);
      break;
    }
  }

  return {
    seasonOrdinal,
    partOrdinal,
    normalizedBaseTitle: normalizeBaseTitle(lower),
  };
}

function normalizeBaseTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/season\s+\d+/g, '')
    .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/g, '')
    .replace(/part\s+\d+/g, '')
    .replace(/cour\s+\d+/g, '')
    .replace(/[():\-–_,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean a root/franchise title by removing season indicators while preserving
 * official wording and case where possible. This returns a cleaned display
 * title suitable for franchise-level grouping (does not modify season titles).
 */
function normalizeRootTitle(title) {
  if (!title) return '';
  let t = String(title).trim();

  // Remove parentheses/brackets that explicitly mention season/part/cour/etc.
    t = t.replace(/\([^)]*(?:season|part|cour|final|s\d+|\d+(?:st|nd|rd|th))[^)]+\)/ig, ' ');
  t = t.replace(/\[[^\]]*(?:season|part|cour|final|s\d+|\d+(?:st|nd|rd|th))[^\]]*\]/ig, ' ');

  // Remove common season/part/cour patterns
  const removePatterns = [
    /\bseason\s*\d+\b/ig,
    /\b\d+(?:st|nd|rd|th)\s*season\b/ig,
    /\bsecond\s+season\b/ig,
    /\bthird\s+season\b/ig,
    /\bpart\s*\d+\b/ig,
    /\bcour\s*\d+\b/ig,
    /\bfinal\s*season\b/ig,
    /\bs\d+\b/ig,
    /\b(?:2nd|3rd|4th|5th)\s*season\b/ig,
  ];
  for (const p of removePatterns) t = t.replace(p, ' ');

  // Remove stray separators and punctuation left behind
  t = t.replace(/[\-–—:_]+/g, ' ');
  t = t.replace(/[()\[\]{}]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();

  // Trim trailing punctuation
  t = t.replace(/[\:\;\,\-–—]+$/g, '').trim();

  return t || String(title).trim();
}

function inferFormatDetails(format) {
  const normalized = String(format || '').toUpperCase().trim() || 'TV';
  return {
    format: normalized,
    is_movie: MOVIE_FORMATS.has(normalized),
    is_ova: OVA_FORMATS.has(normalized),
    is_special: SPECIAL_FORMATS.has(normalized),
    is_primary: PRIMARY_FORMATS.has(normalized) || (!MOVIE_FORMATS.has(normalized) && !OVA_FORMATS.has(normalized) && !SPECIAL_FORMATS.has(normalized)),
  };
}

function deriveLocalFormat(season) {
  const title = `${season?.title_english || ''} ${season?.title_japanese || ''}`.toLowerCase();
  if (title.includes('movie')) return 'MOVIE';
  if (title.includes('ova')) return 'OVA';
  if (title.includes('special')) return 'SPECIAL';
  return 'TV';
}

function buildAniListDate(startDate) {
  if (!startDate?.year) return null;
  const month = String(startDate.month || 1).padStart(2, '0');
  const day = String(startDate.day || 1).padStart(2, '0');
  return `${startDate.year}-${month}-${day}T00:00:00.000Z`;
}

function mergeEdgeMaps(target, source) {
  for (const [id, edgeList] of source.entries()) {
    if (!target.has(id)) target.set(id, []);
    const existing = target.get(id);
    for (const edge of edgeList) {
      if (!existing.some((item) => item.targetId === edge.targetId && item.relationType === edge.relationType)) {
        existing.push(edge);
      }
    }
  }
}

function mergeGraphNodes(primary, fallback) {
  if (!primary) return fallback || null;
  if (!fallback) return primary;

  const merged = { ...fallback, ...primary };
  for (const key of Object.keys(fallback)) {
    if (merged[key] === null || merged[key] === undefined || merged[key] === '') {
      merged[key] = fallback[key];
    }
  }
  return merged;
}

function getEntryFranchiseId(entry) {
  return entry?.franchise_id || `mal-${Number(entry?.franchise_root_id || entry?.root_mal_id || 0)}`;
}

function getFranchiseEntries(library, anime) {
  const fid = getEntryFranchiseId(anime);
  const entries = (library || []).filter((entry) => getEntryFranchiseId(entry) === fid);
  return entries.length > 0 ? entries : [anime];
}

function replaceEntry(library, nextEntry) {
  const list = Array.isArray(library) ? [...library] : [];
  const index = list.findIndex((entry) => Number(entry.root_mal_id) === Number(nextEntry.root_mal_id));
  if (index >= 0) {
    list[index] = nextEntry;
  } else {
    list.push(nextEntry);
  }
  return list;
}

function collectRootRelations(seasons) {
  const all = [];
  for (const season of Object.values(seasons || {})) {
    for (const relation of season.relations || []) {
      if (!relation?.mal_id) continue;
      if (!all.some((item) => Number(item.mal_id) === Number(relation.mal_id) && item.relation === relation.relation)) {
        all.push(relation);
      }
    }
  }
  return all;
}

function getEntryLastWatchedAtMs(entry) {
  const timestamps = getSeasonsArray(entry)
    .map((season) => parseDateMs(season.last_watched_at || season.last_progress_update || season.started_watching_date))
    .filter(Boolean);

  if (timestamps.length === 0) return null;
  return Math.max(...timestamps);
}

function getEntryLastWatchedAtIso(entry) {
  const ms = getEntryLastWatchedAtMs(entry);
  return ms ? new Date(ms).toISOString() : null;
}

function getCountdownLabel(nextAt) {
  const target = Number(nextAt || 0);
  if (!target || target <= Date.now()) return null;
  return formatDurationDDHHMMSS(target - Date.now());
}

function choosePrimaryNextWatch(seasons, anime) {
  const selectedSeasonId = Number(anime.selected_season_mal_id || 0);
  const candidates = seasons
    .filter((season) => !season.is_movie && !season.is_ova && !season.is_special)
    .filter((season) => normalizeStatus(season.watch_status) !== 'completed' || season.is_airing)
    .sort((left, right) => {
      const leftScore = Number(left.franchise_rank_score || 0);
      const rightScore = Number(right.franchise_rank_score || 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      return Number(left.franchise_order_index || 9999) - Number(right.franchise_order_index || 9999);
    });

  return candidates.find((season) => season.has_user_watched_previous) ||
    candidates.find((season) => Number(season.mal_id) === selectedSeasonId) ||
    candidates[0] ||
    null;
}

function getAdjacentSeasons(seasons, selectedSeasonId) {
  const ordered = [...(seasons || [])].sort((left, right) =>
    Number(left.franchise_order_index || 9999) - Number(right.franchise_order_index || 9999)
  );

  const index = ordered.findIndex((season) => Number(season.mal_id) === Number(selectedSeasonId));
  if (index < 0) return [];
  return ordered.slice(Math.max(0, index - 1), Math.min(ordered.length, index + 2));
}

function compareSeasonDisplayOrder(left, right, preferAiring) {
  if (preferAiring) {
    const leftSeason = Number(left.season_number || 0);
    const rightSeason = Number(right.season_number || 0);
    if (rightSeason !== leftSeason) return rightSeason - leftSeason;
  }

  const leftOrder = Number(left.franchise_order_index || 9999);
  const rightOrder = Number(right.franchise_order_index || 9999);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;

  return Number(left.mal_id) - Number(right.mal_id);
}

function mapRelationLabel(label) {
  const raw = String(label || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (raw === 'SIDE_STORY') return 'SIDE_STORY';
  if (raw === 'SPIN_OFF') return 'SPIN_OFF';
  if (raw === 'ALTERNATIVE_VERSION') return 'ALTERNATIVE_VERSION';
  if (raw === 'ALTERNATIVE_SETTING') return 'ALTERNATIVE_SETTING';
  if (raw === 'PARENT_STORY') return 'PARENT';
  if (raw === 'FULL_STORY') return 'CHILD';
  return raw;
}

function safeToMs(value) {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function parseDateMs(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isEntryStructurallyEqual(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function getSupplementalPenalty(record) {
  if (record.is_special) return 3;
  if (record.is_ova) return 2;
  if (record.is_movie) return 1;
  return 0;
}

function hasLocalStorage() {
  return typeof localStorage !== 'undefined';
}

function loadPersistentCache() {
  if (_persistentCacheLoaded || !hasLocalStorage()) return;
  _persistentCacheLoaded = true;

  try {
    const raw = localStorage.getItem(GRAPH_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const [key, value] of Object.entries(parsed || {})) {
      _graphCache.set(Number(key), value);
    }
  } catch {
    // ignore cache hydration failures
  }
}

function getCachedGraphNode(idMal, force = false) {
  if (force) return null;
  loadPersistentCache();
  const cached = _graphCache.get(Number(idMal));
  if (!cached) return null;
  if ((Date.now() - Number(cached.cachedAt || 0)) > GRAPH_CACHE_TTL_MS) return null;
  return cached.payload || null;
}

function setCachedGraphNode(idMal, payload) {
  loadPersistentCache();
  _graphCache.set(Number(idMal), { cachedAt: Date.now(), payload });

  if (!hasLocalStorage()) return;
  try {
    const serializable = {};
    for (const [key, value] of _graphCache.entries()) {
      serializable[String(key)] = value;
    }
    localStorage.setItem(GRAPH_CACHE_KEY, JSON.stringify(serializable));
  } catch {
    // ignore cache persistence failures
  }
}
