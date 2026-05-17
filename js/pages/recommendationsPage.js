/**
 * recommendationsPage.js — Render recommendations with explainable reasons (v2 schema)
 */

import { subscribe } from '../state.js';
import { getRecommendations } from '../services/recommendationEngine.js';
import { createAnimeCard } from '../ui/animeCard.js';
import { batchMultipleDOM } from '../services/updateBatcher.js';

export async function render(container) {
  container.innerHTML = `<div id="rec-container">Loading recommendations...</div>`;

  const redraw = async () => {
    const c = document.getElementById('rec-container');
    if (!c) return;

    const recs = await getRecommendations();

    if (Object.values(recs).every(v => Array.isArray(v) && v.length === 0)) {
      c.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔮</div>
          <div class="empty-state-title">Not enough data</div>
          <div class="empty-state-desc">Add and track more anime to get personalized recommendations.</div>
        </div>
      `;
      return;
    }

    // Render HTML shell first
    c.innerHTML = `
      <div class="recommendations-container">
        ${renderSection('continueWatching', '👀 Continue Watching', recs.continueWatching, 'Pick up right where you left off.')}
        ${renderSection('newSeasons', '🚀 Best Continuations', recs.newSeasons, 'Weighted franchise picks based on what you have already watched.')}
        ${renderSection('similar', '⭐ Based on Your Tastes', recs.similar, 'Personalized recommendations just for you.')}
        ${renderSection('gems', '📖 From Your Backlog', recs.gems, 'Titles you planned to watch.')}
        ${renderSection('rewatch', '🔁 Time for a Rewatch?', recs.rewatch, 'It has been a while since you completed these.')}
      </div>
    `;

    // Batch all card creations to prevent layout thrashing
    const cardCreations = [];
    
    Object.entries(recs).forEach(([key, list]) => {
      if (typeof list === 'string' || !Array.isArray(list)) return;
      const row = document.getElementById(`rec-row-${key}`);
      if (!row) return;

      list.forEach(anime => {
        cardCreations.push(() => {
          const card = createAnimeCard(anime);
          
          // Add recommendation reason badge
          if (anime._recommendation) {
            const badge = document.createElement('div');
            badge.className = 'recommendation-badge';
            badge.innerHTML = `
              <div class="rec-reason">${anime._recommendation.reason}</div>
              <div class="rec-tags">
                ${anime._recommendation.tags.map(tag => `<span class="rec-tag">${tag}</span>`).join('')}
              </div>
            `;
            card.appendChild(badge);
          }
          
          row.appendChild(card);
        });
      });
    });

    // Batch all DOM operations
    if (cardCreations.length > 0) {
      batchMultipleDOM(cardCreations);
    }
  };

  const idle = window.requestIdleCallback || function(cb) { return setTimeout(cb, 16); };
  idle(redraw);
  subscribe('library', redraw);
}

function renderSection(idKey, title, list, subtitle) {
  if (!list || list.length === 0) return '';
  return `
    <div class="rec-section">
      <div class="rec-section-header">
        <div>
          <h2 class="rec-section-title">${title}</h2>
          <p class="rec-section-subtitle">${subtitle}</p>
        </div>
      </div>
      <div class="anime-grid" id="rec-row-${idKey}"></div>
    </div>
  `;
}
