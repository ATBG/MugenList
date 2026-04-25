/**
 * relationChecker.js — Background sequel discovery (v2 schema)
 */

import { getState, getSeasonsArray } from '../state.js';
import { mergeRelationSeason, updateSeasonField } from './animeManager.js';
import { getAnimeRelations, getAnimeById } from './jikanClient.js';
import { showToast } from '../utils.js';

let _checkerInterval = null;

export function startRelationChecker() {
  if (_checkerInterval) return;
  const settings = getState('settings');
  if (!settings?.relation_checker_enabled) return;

  // Run on startup
  setTimeout(runCheck, 5000);

  // Then on interval
  const hrs = settings.relation_checker_interval_hours || 24;
  _checkerInterval = setInterval(runCheck, hrs * 60 * 60 * 1000);
}

export function stopRelationChecker() {
  if (_checkerInterval) {
    clearInterval(_checkerInterval);
    _checkerInterval = null;
  }
}

async function runCheck() {
  const library = getState('library');
  if (!library || library.length === 0) return;

  // Let's just check the most recently updated anime that hasn't been checked lately
  // to avoid spamming the API limit
  const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);

  let targetAnime = null;
  let targetSeason = null;

  // Find a season that needs checking
  for (const anime of library) {
    for (const season of getSeasonsArray(anime)) {
      const lastCheck = season.last_relation_check ? new Date(season.last_relation_check).getTime() : 0;
      if (lastCheck < threeDaysAgo) {
        targetAnime = anime;
        targetSeason = season;
        break;
      }
    }
    if (targetAnime) break;
  }

  if (!targetAnime || !targetSeason) return;

  const nowIso = new Date().toISOString();

  try {
    const relations = await getAnimeRelations(targetSeason.mal_id);
    // relations is a flat list of entries { mal_id, name, type, relation }
    const interesting = relations.filter(r => ['Sequel', 'Prequel', 'Side story'].includes(r.relation));

    for (const rel of interesting) {
      if (rel.type !== 'anime') continue;
      const sId = String(rel.mal_id);
      if (targetAnime.seasons[sId]) continue; // already have it

      const newSeasonData = await getAnimeById(rel.mal_id);
      if (newSeasonData) {
        await mergeRelationSeason(targetAnime.root_mal_id, newSeasonData);
        await updateSeasonField(targetAnime.root_mal_id, targetSeason.mal_id, { last_relation_check: nowIso });
        showToast(`Discovered related anime: ${newSeasonData.title}`, 'info');
        return;
      }
    }
  } catch (err) {
    console.error('Relation check failed:', err);
  }

  // mark as checked even if nothing new found
  await updateSeasonField(targetAnime.root_mal_id, targetSeason.mal_id, { last_relation_check: nowIso });
}
