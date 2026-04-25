/**
 * airingDaemon.js — Locally monitors next_episode_airing_at for actively airing anime.
 * Triggers state updates and notifications at the exact release time.
 */

import { getState } from '../state.js';
import { updateSeasonField } from './animeManager.js';
import { addNotification } from './notificationSystem.js';

let _daemonTimer = null;
let _daemonStartupTimer = null;
const DAEMON_INTERVAL_MS = 1000 * 60; // Check once a minute

export function startAiringDaemon() {
  if (_daemonTimer) return;
  
  // Stagger startup 
  if (!_daemonStartupTimer) {
    _daemonStartupTimer = setTimeout(() => {
      _daemonStartupTimer = null;
      runDaemonTick();
      _daemonTimer = setInterval(runDaemonTick, DAEMON_INTERVAL_MS);
    }, 10000);
  }
}

export function stopAiringDaemon() {
  if (_daemonStartupTimer) {
    clearTimeout(_daemonStartupTimer);
    _daemonStartupTimer = null;
  }
  if (_daemonTimer) {
    clearInterval(_daemonTimer);
    _daemonTimer = null;
  }
}

async function runDaemonTick() {
  const library = getState('library') || [];
  const now = Date.now();

  for (const anime of library) {
    const seasonId = anime.selected_season_mal_id || anime.root_mal_id;
    const seasonKey = String(seasonId);
    const season = anime.seasons?.[seasonKey] || Object.values(anime.seasons || {})[0];

    // Verify it's airing and has a defined airing time
    if (season?.status !== 'Currently Airing' || !season?.next_episode_airing_at || !season?.next_episode_number) {
      continue;
    }

    if (now >= season.next_episode_airing_at) {
      const releaseNum = season.next_episode_number;

      if (season.last_notified_episode === releaseNum) {
        continue; // Already processed this episode
      }

      console.log(`🎉 [AiringDaemon] Episode ${releaseNum} of "${anime.title_english}" has aired!`);

      // 1. Update the season to increment total_episodes, add the badge, and clear the timer until next sync
      await updateSeasonField(anime.root_mal_id, season.mal_id, {
        total_episodes: releaseNum,
        has_new_episode: true,
        next_episode_airing_at: null,
        next_episode_number: null,
        last_notified_episode: releaseNum
      });

      // 2. Trigger Notification
      addNotification(
        'new_episode',
        `New Episode Released!`,
        anime,
        `Episode ${releaseNum} is now available.`
      );
    }
  }
}
