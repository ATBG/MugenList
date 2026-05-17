/**
 * utils.js — Shared utility functions
 */

// ---------- DOM Helpers ----------
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') e.appendChild(document.createTextNode(child));
    else if (child) e.appendChild(child);
  }
  return e;
}

export function setHTML(element, html) { element.innerHTML = html; }
export function clearEl(element) { while (element.firstChild) element.removeChild(element.firstChild); }

export function svgIcon(path, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.innerHTML = path;
  return svg;
}

// ---------- Timing ----------
export function debounce(fn, delay = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function throttle(fn, limit = 100) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= limit) { last = now; fn(...args); }
  };
}

// ---------- Fuzzy Search ----------
export function fuzzyMatch(str, query) {
  if (!query) return true;
  str = str.toLowerCase();
  query = query.toLowerCase();
  if (str.includes(query)) return true;
  let si = 0, qi = 0;
  while (si < str.length && qi < query.length) {
    if (str[si] === query[qi]) qi++;
    si++;
  }
  return qi === query.length;
}

export function fuzzyScore(str, query) {
  if (!query) return 1;
  str = str.toLowerCase();
  query = query.toLowerCase();
  if (str === query) return 1;
  if (str.startsWith(query)) return 0.9;
  if (str.includes(query)) return 0.7;
  return fuzzyMatch(str, query) ? 0.4 : 0;
}

// ---------- ID Generation ----------
export function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ---------- Deep Clone ----------
export function deepClone(obj) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
  } catch (err) {
    console.warn('deepClone failed, returning shallow copy', err);
    if (Array.isArray(obj)) return [...obj];
    if (obj && typeof obj === 'object') return { ...obj };
    return obj;
  }
}

// ---------- Date Formatting ----------
export function formatDate(dateStr) {
  if (!dateStr) return 'Unknown';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
  } catch { return dateStr; }
}

export function daysAgo(dateStr) {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export function formatDurationDDHHMMSS(diffMs) {
  if (diffMs <= 0) return '00:00:00:00';
  const d = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const h = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
  const m = Math.floor((diffMs / 1000 / 60) % 60);
  const s = Math.floor((diffMs / 1000) % 60);
  return [d, h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
}


// ---------- Jaccard Similarity (for genres) ----------
export function jaccardSimilarity(setA, setB) {
  if (!setA.length || !setB.length) return 0;
  const a = new Set(setA.map(s => s.toLowerCase()));
  const b = new Set(setB.map(s => s.toLowerCase()));
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

// ---------- Status helpers ----------
export const STATUS_LABELS = {
  watching: 'Watching',
  completed: 'Completed',
  plan_to_watch: 'Plan to Watch',
  dropped: 'Dropped',
  paused: 'On Hold',
};

export function statusLabel(status, isAiring = false) { 
  if (status === 'completed' && isAiring) return 'Caught Up';
  return STATUS_LABELS[status] || status; 
}

export function statusColor(status) {
  const map = {
    watching: 'var(--status-watching)',
    completed: 'var(--status-completed)',
    plan_to_watch: 'var(--status-plan)',
    dropped: 'var(--status-dropped)',
    paused: 'var(--status-paused)',
  };
  return map[status] || 'var(--text-muted)';
}

export function autoStatus(watched, total) {
  if (total === 0) return 'plan_to_watch';
  if (watched === 0) return 'plan_to_watch';
  if (watched >= total) return 'completed';
  return 'watching';
}

// ---------- Array helpers ----------
export function groupBy(arr, fn) {
  return arr.reduce((acc, item) => {
    const key = fn(item);
    (acc[key] = acc[key] || []).push(item);
    return acc;
  }, {});
}

export function sortBy(arr, key, dir = 'asc') {
  return [...arr].sort((a, b) => {
    const av = typeof key === 'function' ? key(a) : a[key];
    const bv = typeof key === 'function' ? key(b) : b[key];
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

// ---------- Number helpers ----------
export function clamp(val, min, max) { return Math.min(max, Math.max(min, val)); }

export function formatNumber(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

// ---------- Toast ----------
export function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { success: '✓', error: '✗', info: '◆' };
  const toast = el('div', { class: `toast ${type}` },
    el('span', { class: 'toast-icon' }, icons[type] || '◆'),
    el('span', {}, message)
  );
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 280);
  }, duration);
}

// ---------- Poster fallback ----------
export function posterUrl(url, fallback = 'assets/icons/placeholder.svg') {
  return url || fallback;
}

// ---------- Library hash for caching ----------
export function libraryHash(library) {
  const str = library.map(g => `${g.id}:${g.seasons.map(s => s.watched_episodes).join(',')}`).join('|');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash * 32) - hash) + str.charCodeAt(i); // Replace << 5 with * 32
    hash |= 0;
  }
  return hash;
}
