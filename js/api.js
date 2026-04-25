/**
 * api.js — Rate-limited fetch queue (3 req/sec)
 */

const RATE_LIMIT = 3;
const INTERVAL_MS = 1000;

// Jikan Queue
let queue = [];
let running = 0;
let lastFlush = 0;

// AniList Queue (Safe limit: 1 req/sec to stay under 90/min)
const AL_RATE_LIMIT = 1;
const AL_INTERVAL_MS = 1000;
let alQueue = [];
let alRunning = 0;
let alLastFlush = 0;

function processQueue() {
  const now = Date.now();
  const elapsed = now - lastFlush;
  if (elapsed >= INTERVAL_MS) { running = 0; lastFlush = now; }

  while (queue.length > 0 && running < RATE_LIMIT) {
    const { url, opts, resolve, reject, retries } = queue.shift();
    running++;
    _doFetch(url, opts, retries).then(resolve).catch(reject);
  }

  if (queue.length > 0) {
    setTimeout(processQueue, INTERVAL_MS - (Date.now() - lastFlush) + 10);
  }
}

async function _doFetch(url, opts, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429) {
        const wait = (attempt + 1) * 1500;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

export function apiFetch(url, opts = {}, priority = false) {
  return new Promise((resolve, reject) => {
    const item = { url, opts, resolve, reject, retries: 2 };
    if (priority) queue.unshift(item);
    else queue.push(item);
    processQueue();
  });
}

function processAlQueue() {
  const now = Date.now();
  const elapsed = now - alLastFlush;
  if (elapsed >= AL_INTERVAL_MS) { alRunning = 0; alLastFlush = now; }

  while (alQueue.length > 0 && alRunning < AL_RATE_LIMIT) {
    const { url, opts, resolve, reject, retries } = alQueue.shift();
    alRunning++;
    _doFetch(url, opts, retries).then(resolve).catch(reject);
  }

  if (alQueue.length > 0) {
    setTimeout(processAlQueue, AL_INTERVAL_MS - (Date.now() - alLastFlush) + 10);
  }
}

export function graphqlFetch(query, variables = {}, priority = false) {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables })
    };
    const item = { url: 'https://graphql.anilist.co', opts, resolve, reject, retries: 2 };
    if (priority) alQueue.unshift(item);
    else alQueue.push(item);
    processAlQueue();
  });
}

export function clearQueue() { 
  queue = []; 
  alQueue = [];
}
