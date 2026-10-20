// Dictionary data access: lazy shard loading, IndexedDB storage, offline download.
//
// Data files (see scripts/build_dict.py):
//   data/meta.json  – version, shard start keys, file sizes
//   data/s/<n>.json – range shard n: [word, phonetic, translation, definition,
//                      exchange, collins, oxford, tags, rank, ipaUK, ipaUS][]
//   data/t/<c>.json – suggestions for prefixes spanning several shards
//   data/r/<n>.json – reverse index bucket: { 中文詞: [english words] }
//   data/s2t.json   – simplified → traditional character candidates
//
// IndexedDB is used (not Cache Storage) because it also works on plain-HTTP
// origins such as http://<ip>:<port>/, where service workers are unavailable.

export const F = { WORD: 0, PHON: 1, TRANS: 2, DEF: 3, EXCH: 4, COLLINS: 5, OXFORD: 6, TAGS: 7, RANK: 8, UK: 9, US: 10 };

const DATA_URL = new URL('../data/', import.meta.url);
const DB_NAME = 'wordbridge';
const MEM_LIMIT = 48;
const CJK = /[㐀-鿿豈-﫿]/;

let dbPromise = null;
let meta = null;
let remoteMeta = null;
const mem = new Map(); // path -> parsed JSON (small LRU)
const inflight = new Map();

// ---------------------------------------------------------------- IndexedDB

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        req.result.createObjectStore('files');
        req.result.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // e.g. private mode: work online only
    });
  }
  return dbPromise;
}

async function idb(store, mode, fn) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const kvGet = (k) => idb('kv', 'readonly', (s) => s.get(k)).catch(() => undefined);
const kvSet = (k, v) => idb('kv', 'readwrite', (s) => s.put(v, k)).catch(() => {});
const kvDel = (k) => idb('kv', 'readwrite', (s) => s.delete(k)).catch(() => {});
const fileGet = (p) => idb('files', 'readonly', (s) => s.get(p)).catch(() => undefined);
const filePut = (p, v) => idb('files', 'readwrite', (s) => s.put(v, p)).catch(() => {});
const fileKeys = () => idb('files', 'readonly', (s) => s.getAllKeys()).catch(() => []);
const filesClear = () => idb('files', 'readwrite', (s) => s.clear()).catch(() => {});

// ---------------------------------------------------------------- helpers

export function shardKey(word) {
  let out = '';
  for (const c of word.toLowerCase()) out += c >= 'a' && c <= 'z' ? c : '_';
  return out;
}

export const isChinese = (s) => CJK.test(s);

/** Normalise user input: trim, collapse whitespace. */
export const normalize = (s) => s.replace(/\s+/g, ' ').trim();

export function glossOf(translation) {
  const lines = translation.split('\n');
  for (let line of lines) {
    line = line.trim().replace(/^[a-z]+\.\s*/, '');
    if (line && !line.startsWith('[')) return line.slice(0, 40);
  }
  return lines[0].replace(/^\[[^\]]*\]\s*/, '').slice(0, 40);
}

/** Index of the shard whose range contains `key` (last start <= key). */
function shardIndex(key) {
  const s = meta.starts;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid] <= key) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function remember(path, data) {
  mem.delete(path);
  mem.set(path, data);
  if (mem.size > MEM_LIMIT) mem.delete(mem.keys().next().value);
  return data;
}

async function fetchJson(path, signal) {
  const res = await fetch(new URL(path + '.json', DATA_URL), { cache: 'no-cache', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

export class OfflineMissError extends Error {}

/** Get a data file: memory → IndexedDB → network (then stored in IndexedDB). */
async function getFile(path) {
  if (mem.has(path)) return remember(path, mem.get(path));
  if (inflight.has(path)) return inflight.get(path);
  const p = (async () => {
    let data = await fileGet(path);
    if (data === undefined) {
      try {
        data = await fetchJson(path);
      } catch (e) {
        if (!navigator.onLine || e instanceof TypeError) throw new OfflineMissError(path);
        throw e;
      }
      filePut(path, data);
    }
    return remember(path, data);
  })();
  inflight.set(path, p);
  try {
    return await p;
  } finally {
    inflight.delete(path);
  }
}

// ---------------------------------------------------------------- init / status

/**
 * Load metadata. When the full dictionary is stored offline we keep using that
 * version until the user chooses to update; otherwise we follow the server.
 */
export async function init() {
  const [stored, offlineVersion] = await Promise.all([kvGet('meta'), kvGet('offline')]);
  try {
    remoteMeta = await fetchJson('meta');
  } catch {
    remoteMeta = null;
  }
  if (stored && offlineVersion === stored.version) {
    meta = stored;
  } else if (remoteMeta) {
    if (!stored || stored.version !== remoteMeta.version) {
      await filesClear();
      await kvDel('offline');
      await kvSet('meta', remoteMeta);
    }
    meta = remoteMeta;
  } else {
    meta = stored || null;
  }
  if (!meta) throw new OfflineMissError('meta');
  return meta;
}

export async function status() {
  const keys = await fileKeys();
  const offline = (await kvGet('offline')) === meta?.version;
  const total = meta ? Object.keys(meta.files).length : 0;
  return {
    version: meta?.version,
    count: meta?.count ?? 0,
    gzBytes: meta?.gzBytes ?? 0,
    level: meta?.level,
    offline,
    storedFiles: keys.length,
    totalFiles: total,
    updateAvailable: Boolean(offline && remoteMeta && remoteMeta.version !== meta.version),
    remoteGzBytes: remoteMeta?.gzBytes,
  };
}

export const getMeta = () => meta;

// ---------------------------------------------------------------- offline download

/**
 * Download every data file into IndexedDB.
 * onProgress({ done, total, bytes, totalBytes }); abort via signal.
 */
export async function downloadAll({ onProgress, signal, update = false } = {}) {
  if (update) {
    if (!remoteMeta) remoteMeta = await fetchJson('meta', signal);
    await filesClear();
    await kvDel('offline');
    mem.clear();
    meta = remoteMeta;
    await kvSet('meta', meta);
  }
  try {
    await navigator.storage?.persist?.();
  } catch { /* best effort */ }

  const have = new Set(await fileKeys());
  const entries = Object.entries(meta.files);
  const totalBytes = entries.reduce((n, [, b]) => n + b, 0);
  let bytes = entries.filter(([p]) => have.has(p)).reduce((n, [, b]) => n + b, 0);
  let done = have.size;
  const queue = entries.filter(([p]) => !have.has(p));
  onProgress?.({ done, total: entries.length, bytes, totalBytes });

  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const [path, size] = queue.shift();
      const data = await fetchJson(path, signal);
      await filePut(path, data);
      done += 1;
      bytes += size;
      onProgress?.({ done, total: entries.length, bytes, totalBytes });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  await kvSet('offline', meta.version);
}

/**
 * Remove the downloaded dictionary and go back to online lookups. The stored
 * copy may be older than the server's data, so switch to the server's current
 * metadata; otherwise shard numbers would point into the wrong files.
 */
export async function deleteOffline() {
  await filesClear();
  await kvDel('offline');
  mem.clear();
  try {
    remoteMeta = await fetchJson('meta');
  } catch { /* offline: keep the old metadata until we can reach the server */ }
  if (remoteMeta && remoteMeta.version !== meta?.version) {
    meta = remoteMeta;
    await kvSet('meta', meta);
  }
}

/** True when the whole dictionary is stored on this device. */
export async function isOfflineReady() {
  return Boolean(meta) && (await kvGet('offline')) === meta.version;
}

// ---------------------------------------------------------------- queries

/** Exact lookup (case-insensitive; exact-case entries first). */
export async function lookup(word) {
  const key = shardKey(word);
  const shard = await getFile('s/' + shardIndex(key));
  return shard
    .filter((e) => shardKey(e[F.WORD]) === key)
    .sort((a, b) => (b[F.WORD] === word) - (a[F.WORD] === word) || a[F.RANK] - b[F.RANK]);
}

const byRank = (a, b) => a[F.RANK] - b[F.RANK] || a[F.WORD].length - b[F.WORD].length;

/** Prefix suggestions: [{ word, gloss }] */
export async function suggest(input, limit = 8) {
  const q = normalize(input);
  if (!q) return [];
  if (isChinese(q)) return suggestChinese(q, limit);
  const key = shardKey(q);
  const lo = shardIndex(key);
  const hi = shardIndex(key + '{'); // '{' sorts after every key character
  let list;
  let exact;
  if (lo === hi) {
    const matches = (await getFile('s/' + lo)).filter((e) => shardKey(e[F.WORD]).startsWith(key)).sort(byRank);
    exact = matches.filter((e) => shardKey(e[F.WORD]) === key);
    list = matches.map((e) => ({ word: e[F.WORD], gloss: glossOf(e[F.TRANS]) }));
  } else {
    const top = await getFile('t/' + key[0]);
    list = (top[key] || []).map(([word, gloss]) => ({ word, gloss }));
    // The exact word (if any) lives in shard `lo`.
    exact = (await getFile('s/' + lo)).filter((e) => shardKey(e[F.WORD]) === key).sort(byRank);
  }
  // Lowercase input prefers lowercase words ("hel" → "help" before "Hel").
  const capitalized = (w) => q === q.toLowerCase() && w !== w.toLowerCase();
  list.sort((a, b) => capitalized(a.word) - capitalized(b.word));
  // Offer the exact word first, unless it is an obscure match for a 1–2 letter
  // prefix (typing "co" should suggest "could" before "co-").
  for (const e of exact.reverse()) {
    if (capitalized(e[F.WORD]) || (key.length < 3 && e[F.RANK] > 20000)) continue;
    list = list.filter((s) => s.word !== e[F.WORD]);
    list.unshift({ word: e[F.WORD], gloss: glossOf(e[F.TRANS]) });
  }
  const seen = new Set();
  return list.filter((s) => !seen.has(s.word.toLowerCase()) && seen.add(s.word.toLowerCase())).slice(0, limit);
}

async function reverseBucket(term) {
  return getFile('r/' + (term.codePointAt(0) % meta.revBuckets));
}

/**
 * Traditional spellings to try for a Chinese query. Simplified input is mapped
 * per character via data/s2t.json; ambiguous characters (发 → 發/髮) give
 * several variants, most likely first. Traditional input maps to itself.
 */
async function chineseVariants(q, max = 12) {
  let table = {};
  if (meta.files.s2t !== undefined) {
    try {
      table = await getFile('s2t');
    } catch (e) {
      if (!(e instanceof OfflineMissError)) throw e;
    }
  }
  let out = [''];
  for (const ch of q) {
    const cands = table[ch] ? [...table[ch]] : [ch];
    out = out.flatMap((prefix) => cands.map((c) => prefix + c)).slice(0, max);
  }
  if (!out.includes(q)) out.push(q);
  return out;
}

/** Index terms starting with any variant of q: [{ term, words, exact }], best first. */
async function matchTerms(q) {
  const variants = await chineseVariants(q);
  const found = new Map();
  for (const [order, v] of variants.entries()) {
    const bucket = await reverseBucket(v);
    for (const term of Object.keys(bucket)) {
      if (term.startsWith(v) && !found.has(term)) {
        found.set(term, { term, words: bucket[term], exact: term === v, order });
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    b.exact - a.exact || a.term.length - b.term.length || a.order - b.order);
}

async function suggestChinese(q, limit) {
  return (await matchTerms(q))
    .slice(0, limit)
    .map((m) => ({ word: m.term, gloss: m.words.slice(0, 4).join(', '), chinese: true }));
}

/** Chinese (Traditional or Simplified) → English: [{ term, words, exact }]. */
export async function reverseLookup(q) {
  return (await matchTerms(q)).slice(0, 20);
}

/** Short gloss for a word (used by the Chinese → English result list). */
export async function glossFor(word) {
  const [e] = await lookup(word);
  return e ? glossOf(e[F.TRANS]) : '';
}

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** "Did you mean" candidates for a word that was not found. */
export async function similar(word, limit = 6) {
  const key = shardKey(word);
  const max = key.length <= 4 ? 1 : 2;
  const i = shardIndex(key);
  const idx = [...new Set([i - 1, i, i + 1])].filter((n) => n >= 0 && n < meta.starts.length);
  // Also look where a typo in the first letters would have put the word.
  if (key.length > 1) idx.push(shardIndex(key[0]));
  const seen = new Set();
  const out = [];
  for (const n of new Set(idx)) {
    let shard;
    try {
      shard = await getFile('s/' + n);
    } catch {
      continue;
    }
    for (const e of shard) {
      const k = shardKey(e[F.WORD]);
      if (seen.has(k)) continue;
      const d = editDistance(key, k, max);
      if (d <= max) {
        seen.add(k);
        out.push({ word: e[F.WORD], gloss: glossOf(e[F.TRANS]), d, r: e[F.RANK] });
      }
    }
  }
  return out.sort((a, b) => a.d - b.d || a.r - b.r).slice(0, limit);
}

// ---------------------------------------------------------------- online fallback
//
// Newer words (bitcoin, blockchain, selfie…) are missing from ECDICT but usually
// have a Wikipedia article, and Wikidata stores its name in each Chinese
// variant. Only queried after a dictionary miss; results are kept in IndexedDB
// so a word looked up once also works offline.

const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const WEB_TTL = 30 * 86400000;
const WEB_TIMEOUT = 8000;
const ZH_HANT = ['zh-tw', 'zh-hant', 'zh-hk', 'zh-mo'];
const ZH_OTHER = ['zh', 'zh-hans', 'zh-cn', 'zh-sg', 'zh-my']; // may be Simplified

/** Wikipedia/Wikidata variant matching the dictionary's OpenCC config. */
const zhVariant = () => (meta?.opencc === 's2hk' ? 'zh-hk' : 'zh-tw');

async function wikidata(params) {
  const url = new URL(WIKIDATA);
  url.search = new URLSearchParams({ ...params, format: 'json', origin: '*' });
  const res = await fetch(url, { signal: AbortSignal.timeout?.(WEB_TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Wikidata`);
  return res.json();
}

/** Best Traditional Chinese value from Wikidata labels/descriptions. */
async function zhValue(map = {}) {
  const local = zhVariant();
  for (const l of [local, ...ZH_HANT]) if (map[l]) return map[l].value;
  for (const l of ZH_OTHER) if (map[l]) return (await chineseVariants(map[l].value, 1))[0];
  return '';
}

async function searchWikidata(q) {
  const lang = isChinese(q) ? 'zh' : 'en';
  const found = await wikidata({ action: 'wbsearchentities', search: q, language: lang, uselang: lang, type: 'item', limit: 8 });
  const ids = (found.search || []).map((s) => s.id);
  if (!ids.length) return [];
  const { entities = {} } = await wikidata({
    action: 'wbgetentities', ids: ids.join('|'), props: 'labels|descriptions|sitelinks',
    languages: [...ZH_HANT, ...ZH_OTHER, 'en'].join('|'), sitefilter: 'zhwiki',
  });
  const out = [];
  const seen = new Set();
  for (const [order, id] of ids.entries()) {
    const e = entities[id];
    const en = e?.labels?.en?.value;
    const zh = e && (await zhValue(e.labels));
    const key = `${en}|${zh}`.toLowerCase();
    if (!en || !zh || seen.has(key)) continue;
    seen.add(key);
    const zhwiki = e.sitelinks?.zhwiki?.title;
    out.push({
      id, en, zh, order,
      zhDesc: await zhValue(e.descriptions),
      enDesc: e.descriptions?.en?.value || '',
      url: zhwiki
        ? `https://zh.wikipedia.org/${zhVariant()}/${encodeURIComponent(zhwiki.replace(/ /g, '_'))}`
        : `https://www.wikidata.org/wiki/${id}`,
      wiki: Boolean(zhwiki),
    });
  }
  // Prefer topics with a Chinese Wikipedia article: "selfie" the photo over a 2014 film.
  return out.sort((a, b) => b.wiki - a.wiki || a.order - b.order).slice(0, 4);
}

/**
 * Online lookup for a word the dictionary lacks: [{ en, zh, zhDesc, enDesc, url }].
 * Uses the stored result when it is recent, or whenever we are offline.
 * Throws OfflineMissError when offline with nothing stored.
 */
export async function webLookup(input) {
  const q = normalize(input);
  const key = 'web:' + q.toLowerCase();
  const cached = await kvGet(key);
  if (cached && (!navigator.onLine || Date.now() - cached.at < WEB_TTL)) return cached.results;
  if (!navigator.onLine) throw new OfflineMissError('web');
  try {
    const results = await searchWikidata(q);
    kvSet(key, { at: Date.now(), results });
    return results;
  } catch (e) {
    if (cached) return cached.results;
    throw e;
  }
}

/** Links to search the web for q (used when the dictionary has no entry). */
export function webSearchLinks(q) {
  const zh = isChinese(q);
  const s = encodeURIComponent(q);
  return [
    { name: 'Wiktionary', url: `https://en.wiktionary.org/wiki/Special:Search?search=${s}` },
    { name: 'Wikipedia', url: `https://zh.wikipedia.org/w/index.php?search=${s}&variant=${zhVariant()}` },
    { name: 'Google', url: `https://www.google.com/search?q=${encodeURIComponent(q + (zh ? ' 英文' : ' 中文'))}` },
  ];
}
