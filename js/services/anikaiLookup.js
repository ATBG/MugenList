/**
 * anikaiLookup.js — Resolve AniKai watch pages safely from a title
 * Strategy:
 *  - Normalize title and create a search-friendly string
 *  - Fetch AniKai search results via a permissive HTML proxy (r.jina.ai)
 *  - Parse candidate /watch/ links and score them against the input title
 *  - Return the canonical /watch/... path when confidence is sufficient
 *  - If confidence is low, return the AniKai search page URL instead
 */

function normalizeText(t = '') {
  return String(t || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[“”"'`·•…]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function slugifyForSearch(t = '') {
  return normalizeText(t).replace(/\s+/g, '-');
}

function scoreMatch(titleNorm, anchorText, hrefSlug) {
  const aText = normalizeText(anchorText || '') || '';
  const slugWords = String(hrefSlug || '').toLowerCase().split(/[-_]/).filter(Boolean);
  const titleWords = titleNorm.split(' ').filter(Boolean);

  // Exact containment
  if (aText && aText.includes(titleNorm)) return 100;
  // slug contains all words in order
  const slugStr = slugWords.join(' ');
  if (titleWords.length && titleWords.every((w,i)=> slugStr.includes(w))) return 90;

  // token overlap
  const common = titleWords.filter(w => slugWords.includes(w)).length;
  const overlapRatio = titleWords.length ? (common / titleWords.length) : 0;
  let score = Math.round(overlapRatio * 80);

  // small bonus if anchor text appears similar
  if (aText && aText.length > 0) {
    const tCommon = titleWords.filter(w => aText.includes(w)).length;
    const tRatio = titleWords.length ? (tCommon / titleWords.length) : 0;
    score = Math.max(score, Math.round(tRatio * 95));
  }

  // penalize extremely short matches
  if (titleWords.length <= 2 && overlapRatio < 0.5) score = Math.min(score, 50);

  return score;
}

async function fetchHtmlViaProxy(url) {
  // Use jina.ai text proxy; it often permits CORS and returns HTML text
  const proxy = 'https://r.jina.ai/http://';
  const proxied = proxy + url.replace(/^https?:\/\//, '');
  try {
    const res = await fetch(proxied);
    if (!res || !res.ok) throw new Error('proxy fetch failed');
    const text = await res.text();
    return text;
  } catch (err) {
    console.warn('[anikaiLookup] proxy fetch failed for', url, err);
    return null;
  }
}

function parseWatchLinksFromHtml(html) {
  if (!html) return [];
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const anchors = Array.from(doc.querySelectorAll('a[href*="/watch/"]'));
    return anchors.map(a => ({ href: a.getAttribute('href'), text: a.textContent || a.getAttribute('title') || '' }));
  } catch (err) {
    console.warn('[anikaiLookup] parse error', err);
    return [];
  }
}

export async function resolveAniKaiWatch(title, { episode = null, malId = null, anilistId = null } = {}) {
  if (!title) return { url: null, confidence: 0, fallback: `https://anikai.to/search?q=` };
  // Try local backend first (faster and avoids proxying HTML in the client)
  try {
    const r = await fetch('/api/anikai/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, episode })
    });
    if (r && r.ok) {
      const j = await r.json();
      if (j && j.url) return j;
    }
  } catch (err) {
    // backend not available — fall back to in-client proxy method, but log for visibility
    console.warn('[anikaiLookup] backend resolve failed, falling back to client proxy', err);
  }
  const titleNorm = normalizeText(title);
  const slug = slugifyForSearch(title);

  // Candidate: try search page first
  const searchUrl = `https://anikai.to/search?q=${encodeURIComponent(title)}`;
  const html = await fetchHtmlViaProxy(searchUrl);
  let candidates = parseWatchLinksFromHtml(html);

  // Also try category/watch with simple slug (in case site has redirect rules)
  if (candidates.length === 0) {
    const attemptUrl = `https://anikai.to/watch/${slug}`;
    const attemptHtml = await fetchHtmlViaProxy(attemptUrl);
    if (attemptHtml) {
      // If the watch page exists for this slug, it will likely contain canonical links too
      const anchors = parseWatchLinksFromHtml(attemptHtml);
      // include self
      candidates = candidates.concat(anchors.length ? anchors : [{ href: `/watch/${slug}`, text: title }]);
    }
  }

  // Score candidates
  const scored = candidates.map(c => {
    const href = String(c.href || '').trim();
    const match = href.match(/\/watch\/([^\s?#\/]+)/i);
    const slugPart = match ? match[1] : href.replace(/^\//, '');
    const sc = scoreMatch(titleNorm, c.text || '', slugPart || '');
    return { href, slug: slugPart, text: c.text || '', score: sc };
  }).filter(s => s.href && s.slug);

  scored.sort((a,b) => b.score - a.score);

  const best = scored[0];
  if (best && best.score >= 70) {
    const base = `https://anikai.to${best.href.split('#')[0]}`;
    const url = episode ? `${base}#ep=${episode}` : base;
    return { url, confidence: best.score, matched: best };
  }

  // Low confidence: do not guess; return search page (with episode anchor appended to hint but not to search)
  const fallback = episode ? `https://anikai.to/search?q=${encodeURIComponent(title)}#ep=${episode}` : `https://anikai.to/search?q=${encodeURIComponent(title)}`;
  return { url: fallback, confidence: best ? best.score : 0, matched: best || null };
}

export default { resolveAniKaiWatch };
