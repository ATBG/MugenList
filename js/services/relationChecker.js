/**
 * relationChecker.js — Background sequel discovery (v2 schema)
 * Delegates to the unified relationEngine for all relation logic.
 */

import { getState, getSeasonsArray } from '../state.js';
import { updateSeasonField } from './animeManager.js';
import { quickSeasonCheck, discoverRelatedSeasons, autoAddDiscoveredSeasons } from './relationFinder.js';
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

  // Find a season that hasn't been checked lately
  const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);

  let targetAnime = null;
  let targetSeason = null;

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
    // Use the unified relationFinder — same logic as add-anime and re-search
    const discovery = await discoverRelatedSeasons(targetAnime);
    
    if (discovery.all.length > 0) {
      const added = await autoAddDiscoveredSeasons(targetAnime, discovery, { 
        includePrequels: false // Only auto-add sequels in background
      });
      
      if (added.added.length > 0) {
        showToast(`Discovered ${added.added.length} related anime for ${targetAnime.title_english || targetAnime.title_japanese}`, 'info');
      }
    }
  } catch (err) {
    console.error('Relation check failed:', err);
  }

  // Mark as checked even if nothing new found
  await updateSeasonField(targetAnime.root_mal_id, targetSeason.mal_id, { last_relation_check: nowIso });
}
