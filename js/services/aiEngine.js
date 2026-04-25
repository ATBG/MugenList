/**
 * aiEngine.js — Mock AI text generation + optional real API
 */

import { getState } from '../state.js';

const TASTE_TEMPLATES = [
  'Your watch history shows a strong preference for {genres}. You gravitate toward emotionally intense narratives with high stakes.',
  'Based on your library, you love {genres}. Your taste has evolved toward more complex, mature storytelling.',
  'You are a fan of {genres}. Your library reflects an appreciation for both action-packed and emotionally resonant anime.',
];

const REC_INTROS = [
  'Based on your taste profile, you might enjoy',
  'Given your love for completed series, consider',
  'Anime fans with your profile often gravitate toward',
];

export async function generateTasteEvolution(library) {
  const settings = getState('settings');

  if (settings?.ai_enabled && settings?.ai_endpoint) {
    return await callExternalAI(settings.ai_endpoint, settings.ai_api_key, {
      prompt: buildTastePrompt(library),
    });
  }

  return mockTasteEvolution(library);
}

export async function generateRecommendationText(animeName, genres) {
  const settings = getState('settings');

  if (settings?.ai_enabled && settings?.ai_endpoint) {
    return await callExternalAI(settings.ai_endpoint, settings.ai_api_key, {
      prompt: `Write a short 1-sentence anime recommendation for "${animeName}" (${genres.join(', ')}).`,
    });
  }

  return mockRecText(animeName, genres);
}

// --- Mock generators ---

function mockTasteEvolution(library) {
  const allGenres = library.flatMap(a => Object.values(a.seasons || {}).flatMap(s => s.genres || []));
  const freq = {};
  allGenres.forEach(g => { freq[g] = (freq[g] || 0) + 1; });
  const topGenres = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
  const genreStr = topGenres.join(', ') || 'genre-diverse';
  const template = TASTE_TEMPLATES[Math.floor(Math.random() * TASTE_TEMPLATES.length)];
  return template.replace('{genres}', genreStr);
}

function mockRecText(animeName, genres) {
  const intro = REC_INTROS[Math.floor(Math.random() * REC_INTROS.length)];
  const genreStr = genres.slice(0, 2).join(' and ') || 'anime';
  return `${intro} "${animeName}" — a captivating ${genreStr} series that aligns perfectly with your taste profile.`;
}

// --- External AI call ---

async function callExternalAI(endpoint, apiKey, { prompt }) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ prompt, max_tokens: 100 }),
    });
    if (!res.ok) throw new Error('AI API failed');
    const data = await res.json();
    return data.text || data.choices?.[0]?.text || data.content || 'No response.';
  } catch {
    return mockRecText('this anime', []);
  }
}
