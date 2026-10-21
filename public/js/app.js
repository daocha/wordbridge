import * as data from './data.js';
import { F, OfflineMissError } from './data.js';
import { t, setLang, resolveLang, getLang } from './i18n.js';

const $ = (sel, el = document) => el.querySelector(sel);
// Replaced with the build id by scripts/hash_assets.py in the Docker build.
const BUILD = '__BUILD__';
const buildId = BUILD.startsWith('__') ? 'dev' : BUILD;
const root = document.documentElement;

// ---------------------------------------------------------------- preferences

const prefs = {
  get(key, fallback) {
    try {
      return localStorage.getItem('wb.' + key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('wb.' + key, value);
    } catch { /* storage unavailable */ }
  },
};

/** Tiny DOM builder: h('a', { href, class }, child, …) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const icon = (paths) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
};
const SPEAKER = '<path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>';

const wordHref = (w) => '#/w/' + encodeURIComponent(w);
const fmtMB = (n) => (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + ' MB';
const fmtNum = (n) => n.toLocaleString(getLang() === 'en' ? 'en' : 'zh-Hant');

// ---------------------------------------------------------------- theme

const darkMq = matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const pref = prefs.get('theme', 'system');
  root.dataset.themePref = pref;
  if (pref === 'light' || pref === 'dark') root.dataset.theme = pref;
  else delete root.dataset.theme;
  const dark = pref === 'dark' || (pref === 'system' && darkMq.matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0d1020' : '#f6f7fb';
  const label = t('switchTheme', { mode: t(pref) });
  $('#themeBtn').title = label;
  $('#themeBtn').setAttribute('aria-label', label);
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === pref;
}

// ---------------------------------------------------------------- language

function applyLang() {
  const pref = prefs.get('lang', 'system');
  setLang(resolveLang(pref));
  $('#langLabel').textContent = getLang() === 'en' ? '中' : 'EN';
  for (const r of document.querySelectorAll('input[name="lang"]')) r.checked = r.value === pref;
  applyTheme(); // refresh translated theme label
}

function onLangChange() {
  applyLang();
  renderInstall();
  route();
  if ($('#settings').open) {
    refreshOfflineStatus();
    renderVoiceInfo();
  }
}

// ---------------------------------------------------------------- recent searches

function getRecent() {
  try {
    return JSON.parse(prefs.get('recent', '[]'));
  } catch {
    return [];
  }
}

function addRecent(q) {
  const list = getRecent().filter((x) => x.toLowerCase() !== q.toLowerCase());
  list.unshift(q);
  prefs.set('recent', JSON.stringify(list.slice(0, 12)));
}

// ---------------------------------------------------------------- data readiness

let ready = data.init();
ready.catch(() => {});

async function retryInit() {
  ready = data.init();
  ready.catch(() => {});
  return ready;
}

// ---------------------------------------------------------------- search box & suggestions

const input = $('#q');
const list = $('#suggestions');
let sugSeq = 0;
let sugItems = [];
let active = -1;
let sugTimer = 0;

function hideSuggestions() {
  sugSeq++;
  list.hidden = true;
  list.replaceChildren();
  sugItems = [];
  active = -1;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function highlight(word, q) {
  if (word.toLowerCase().startsWith(q.toLowerCase())) {
    return [h('mark', {}, word.slice(0, q.length)), word.slice(q.length)];
  }
  return [word];
}

// Chinese suggestions may be the Traditional form of Simplified input, so
// highlight by length rather than by exact text.
function highlightChinese(term, q) {
  const n = [...q].length;
  const chars = [...term];
  return [h('mark', {}, chars.slice(0, n).join('')), chars.slice(n).join('')];
}

function renderSuggestions(items, q) {
  sugItems = items;
  active = -1;
  if (!items.length) {
    hideSuggestions();
    return;
  }
  list.replaceChildren(
    ...items.map((s, i) =>
      h('li', {
        id: 'sug-' + i,
        role: 'option',
        'aria-selected': 'false',
        onmousedown: (e) => e.preventDefault(), // keep focus in the input
        onclick: () => go(s.word),
      },
      h('span', { class: 'w' }, s.chinese ? highlightChinese(s.word, q) : highlight(s.word, q)),
      h('span', { class: 'g' }, s.gloss))),
  );
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function renderSuggestionHint(text) {
  sugItems = [];
  active = -1;
  list.replaceChildren(h('li', {
    class: 'hint', role: 'option', 'aria-disabled': 'true',
    onmousedown: (e) => e.preventDefault(),
    onclick: () => { hideSuggestions(); openSettings(); },
  }, text));
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function setActive(i) {
  const lis = list.children;
  if (!lis.length) return;
  if (active >= 0) lis[active]?.setAttribute('aria-selected', 'false');
  active = (i + lis.length) % lis.length;
  lis[active].setAttribute('aria-selected', 'true');
  lis[active].scrollIntoView({ block: 'nearest' });
  input.setAttribute('aria-activedescendant', lis[active].id);
}

async function updateSuggestions() {
  const q = data.normalize(input.value);
  const seq = ++sugSeq;
  if (!q) {
    hideSuggestions();
    return;
  }
  try {
    await ready;
    const items = await data.suggest(q);
    if (seq === sugSeq && document.activeElement === input) renderSuggestions(items, q);
  } catch (err) {
    if (seq !== sugSeq) return;
    if (err instanceof OfflineMissError && document.activeElement === input) {
      renderSuggestionHint(t(navigator.onLine ? 'serverUnreachable' : 'needNetworkShort'));
    } else {
      hideSuggestions();
    }
  }
}

input.addEventListener('input', () => {
  $('#clearBtn').hidden = !input.value;
  clearTimeout(sugTimer);
  sugTimer = setTimeout(updateSuggestions, 70);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && sugItems.length) {
    e.preventDefault();
    setActive(active + 1);
  } else if (e.key === 'ArrowUp' && sugItems.length) {
    e.preventDefault();
    setActive(active - 1);
  } else if (e.key === 'Escape') {
    if (!list.hidden) hideSuggestions();
    else input.select();
  } else if (e.key === 'Enter' && active >= 0 && sugItems[active]) {
    e.preventDefault();
    go(sugItems[active].word);
  }
});

input.addEventListener('focus', () => {
  if (input.value) updateSuggestions();
});
input.addEventListener('blur', () => setTimeout(hideSuggestions, 120));

$('#clearBtn').addEventListener('click', () => {
  input.value = '';
  $('#clearBtn').hidden = true;
  hideSuggestions();
  input.focus();
});

$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = data.normalize(input.value);
  if (q) go(q);
});

function go(q) {
  input.value = q;
  hideSuggestions();
  clearTimeout(sugTimer);
  if (matchMedia('(pointer: coarse)').matches) input.blur(); // dismiss the mobile keyboard
  const target = wordHref(q);
  if (location.hash === target) route();
  else location.hash = target;
}

// ---------------------------------------------------------------- views

const homeView = $('#homeView');
const resultView = $('#resultView');
let viewSeq = 0;

function route() {
  const m = location.hash.match(/^#\/w\/(.+)$/);
  if (m) {
    let q;
    try {
      q = decodeURIComponent(m[1]);
    } catch {
      q = m[1];
    }
    showWord(data.normalize(q));
  } else {
    showHome();
  }
}

async function showHome() {
  const seq = ++viewSeq;
  document.body.classList.add('is-home');
  document.title = `${t('appName')} · ${t('tagline')}`;
  homeView.hidden = false;
  resultView.hidden = true;
  input.value = '';
  $('#clearBtn').hidden = true;
  if (matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true });

  renderRecent();
  try {
    await ready;
  } catch {
    if (seq !== viewSeq) return;
    $('#homeError').hidden = false;
    $('#homeError').replaceChildren(
      h('p', {}, t(navigator.onLine ? 'loadError' : 'offlineMiss')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => retryInit().then(route, route) }, t('retry')),
    );
    $('#wotd').hidden = true;
    $('#offlineCta').hidden = true;
    return;
  }
  if (seq !== viewSeq) return;
  $('#homeError').hidden = true;
  renderWordOfDay(seq);
  const st = await data.status();
  if (seq === viewSeq) $('#offlineCta').hidden = st.offline || downloading;
}

function renderRecent() {
  const recent = getRecent();
  $('#recentBlock').hidden = !recent.length;
  $('#recentList').replaceChildren(...recent.map((w) => h('a', { class: 'chip', href: wordHref(w) }, w)));
}

async function renderWordOfDay(seq) {
  const box = $('#wotd');
  const list = data.getMeta()?.wotd;
  if (!list?.length) return;
  const day = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
  const word = list[day % list.length];
  try {
    const [e] = await data.lookup(word);
    if (!e || seq !== viewSeq) return;
    box.replaceChildren(
      h('span', { class: 'label' }, t('wordOfDay')),
      h('div', { class: 'word-line' },
        h('span', { class: 'w' }, e[F.WORD]),
        pronunciations(e, { compact: true })),
      h('div', { class: 'gloss zh' }, data.glossOf(e[F.TRANS])),
    );
    box.onclick = () => go(e[F.WORD]);
    box.hidden = false;
  } catch {
    box.hidden = true;
  }
}

async function showWord(q) {
  const seq = ++viewSeq;
  document.body.classList.remove('is-home');
  homeView.hidden = true;
  resultView.hidden = false;
  if (document.activeElement !== input) input.value = q;
  $('#clearBtn').hidden = !input.value;
  document.title = `${q} · ${t('appName')}`;
  resultView.replaceChildren(h('div', { class: 'card skeleton' }));
  window.scrollTo({ top: 0 });
  if (!q) return showHome();
  addRecent(q);

  try {
    await ready;
    const nodes = data.isChinese(q) ? await renderChinese(q) : await renderEnglish(q);
    if (seq === viewSeq) resultView.replaceChildren(...nodes);
  } catch (err) {
    if (seq !== viewSeq) return;
    if (!(err instanceof OfflineMissError)) console.error(err);
    resultView.replaceChildren(await missingDataNotice(err));
  }
}

/**
 * Explain why a lookup could not be answered and offer the way forward:
 * offline → connect, or download for next time; online → retry or download.
 */
async function missingDataNotice(err) {
  const offlineReady = await data.isOfflineReady().catch(() => false);
  const online = navigator.onLine;
  const miss = err instanceof OfflineMissError;
  const msg = !online ? (offlineReady ? 'loadError' : 'needNetwork') : miss ? 'serverUnreachable' : 'loadError';
  const retry = h('button', {
    class: 'btn ' + (online ? 'primary' : 'ghost'), type: 'button',
    onclick: () => retryInit().finally(route),
  }, t('retry'));
  const download = !offlineReady && online && !downloading
    ? h('button', {
      class: 'btn ghost', type: 'button',
      onclick: () => { openSettings(); startDownload(); },
    }, t('downloadForOffline'))
    : null;
  const settings = !online && !offlineReady
    ? h('button', { class: 'btn ghost', type: 'button', onclick: openSettings }, t('settings'))
    : null;
  return h('div', { class: 'card notice' },
    h('p', {}, t(msg)),
    h('div', { class: 'row-btns' }, retry, download, settings));
}

/**
 * Online fallback for a word the dictionary lacks (bitcoin, 區塊鏈…): names from
 * Wikidata, filled in when they arrive, plus links to search elsewhere.
 */
function webCard(q) {
  const zhQuery = data.isChinese(q);
  const body = h('div', { class: 'web-body' }, h('p', { class: 'muted' }, t('webSearching')));
  data.webLookup(q).then((results) => {
    body.replaceChildren(results.length
      ? h('ul', { class: 'web-list' }, results.map((r) => webItem(r, zhQuery)))
      : h('p', { class: 'muted' }, t('webNone')));
  }, (err) => {
    if (!(err instanceof OfflineMissError)) console.error(err);
    body.replaceChildren(h('p', { class: 'muted' }, t(navigator.onLine ? 'webError' : 'webOffline')));
  });
  return h('section', { class: 'card web' },
    h('span', { class: 'label' }, t('webTitle')),
    body,
    h('div', { class: 'web-links small' },
      h('span', { class: 'muted' }, t('webSearchOn')),
      data.webSearchLinks(q).map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.name))));
}

function webItem(r, zhQuery) {
  // A Chinese query links the English name, which may be in the dictionary.
  const en = zhQuery
    ? h('a', { class: 'en', lang: 'en', href: wordHref(r.en) }, r.en)
    : h('span', { class: 'en', lang: 'en' }, r.en);
  return h('li', {},
    h('div', { class: 'web-head' }, h('span', { class: 'zh', lang: 'zh-Hant' }, r.zh), en),
    r.zhDesc && h('div', { class: 'desc', lang: 'zh-Hant' }, r.zhDesc),
    r.enDesc && h('div', { class: 'desc', lang: 'en' }, r.enDesc),
    h('a', { class: 'small', href: r.url, target: '_blank', rel: 'noopener' }, t('webArticle')));
}

async function renderEnglish(q) {
  const entries = await data.lookup(q);
  if (entries.length) return entries.slice(0, 4).map(renderEntry);
  const similar = await data.similar(q);
  return [
    webCard(q),
    h('div', { class: 'card not-found' },
      h('h2', {}, t('notFound', { q })),
      similar.length
        ? [h('span', { class: 'label' }, t('didYouMean')),
          h('ul', { class: 'word-list' }, similar.map((s) =>
            h('li', {}, h('a', { href: wordHref(s.word) },
              h('span', { class: 'w' }, s.word), h('span', { class: 'g' }, s.gloss)))))]
        : h('p', { class: 'muted' }, t('noSuggestions'))),
  ];
}

const EXCH_ORDER = ['p', 'd', 'i', '3', 's', 'r', 't'];
const POS_DEF = { n: 'n.', v: 'v.', a: 'adj.', s: 'adj.', r: 'adv.' };

function parseExchange(s) {
  const out = {};
  for (const part of s.split('/')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function senseItem(line, isDef) {
  let m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (m) return h('li', {}, h('span', { class: 'pos domain' }, m[1]), h('span', {}, m[2]));
  m = isDef ? line.match(/^([a-z]{1,5})\.?\s+(.*)$/) : line.match(/^([a-z]{1,6}\.)\s*(.*)$/);
  if (m) {
    const pos = isDef ? POS_DEF[m[1]] || m[1] + '.' : m[1];
    return h('li', {}, h('span', { class: 'pos' }, pos), h('span', {}, m[2]));
  }
  return h('li', {}, h('span', {}, line));
}

// ---- pronunciation (device text-to-speech)
//
// Browsers clip the start of short utterances ("requiem" → "quiem") when:
//  - speak() follows cancel() immediately (Chrome drops the first audio),
//  - the audio output is asleep: macOS closes an idle Bluetooth link and needs
//    ~0.3–1 s to reopen it, so the first syllable is lost,
//  - the voice list has not loaded yet and a poor fallback voice is used.
// Voices carry no gender, so female/male is chosen from known voice names.

const BAD_VOICES = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Fred|Good News|Hysterical|Jester|Junior|Kathy|Organ|Pipe Organ|Princess|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;
const VOICE_NAMES = {
  female: {
    'en-GB': /Google UK English Female|\b(Kate|Serena|Martha|Stephanie|Libby|Sonia|Hazel|Susan|Maisie|Mia|Bella|Amy|Emma|Fiona)\b/i,
    'en-US': /Google US English|\b(Samantha|Ava|Allison|Susan|Zoe|Nicky|Aria|Jenny|Zira|Michelle|Ana|Joelle|Emma|Victoria)\b/i,
  },
  male: {
    'en-GB': /Google UK English Male|\b(Daniel|Arthur|Oliver|Ryan|George|Thomas|Alfie|Elliot|Ethan|Noah|Malcolm)\b/i,
    'en-US': /\b(Alex|Tom|Aaron|Evan|Nathan|Guy|David|Mark|Andrew|Brian|Christopher|Eric|Roger|Davis|Tony|Jason)\b/i,
  },
};

let voicesReady = null;
function loadVoices() {
  if (!voicesReady) {
    voicesReady = new Promise((resolve) => {
      const done = () => resolve();
      if (speechSynthesis.getVoices().length) return done();
      speechSynthesis.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, 1500); // some browsers never fire voiceschanged
    });
  }
  return voicesReady;
}

/** Best voice for a language. Returns { voice, genderMatched }. */
function pickVoice(lang) {
  const gender = prefs.get('voice', 'female');
  const other = gender === 'female' ? 'male' : 'female';
  const re = new RegExp('^' + lang.replace('-', '[-_]'), 'i');
  const score = (v) => (VOICE_NAMES[gender][lang].test(v.name) ? 8 : 0)
    - (VOICE_NAMES[other][lang].test(v.name) ? 3 : 0)
    + (/premium|enhanced|natural|neural/i.test(v.name) ? 2 : 0)
    + (v.localService ? 1 : 0)
    - (!v.localService && !navigator.onLine ? 30 : 0) // network voices fail offline
    - (BAD_VOICES.test(v.name) ? 20 : 0);
  const voices = speechSynthesis.getVoices();
  const voice = voices.filter((v) => re.test(v.lang)).sort((a, b) => score(b) - score(a))[0]
    || voices.find((v) => /^en/i.test(v.lang) && !BAD_VOICES.test(v.name)) || null;
  return { voice, genderMatched: Boolean(voice && VOICE_NAMES[gender][lang].test(voice.name)) };
}

// Keep the audio output awake around speech with an inaudible signal
// (a 20 Hz tone at -54 dB: below what speakers reproduce or ears notice).
// Digital silence is not always enough for Bluetooth devices to stay connected.
const KEEP_ALIVE_LEAD_MS = 600;   // time for a sleeping Bluetooth link to open
const KEEP_ALIVE_HOLD_MS = 20000; // stay awake so repeated clicks play instantly
const keepAlive = { ctx: null, osc: null, startedAt: 0, timer: 0 };
const needsKeepAlive = matchMedia('(pointer: fine)').matches; // desktop; phones route audio fine

/** Start (or extend) the keep-alive signal; returns ms to wait before speaking. */
function wakeAudioOutput() {
  if (!needsKeepAlive) return 0;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return 0;
    keepAlive.ctx ||= new Ctx();
    const ctx = keepAlive.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    if (!keepAlive.osc) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 20;
      gain.gain.value = 0.002;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      keepAlive.osc = osc;
      keepAlive.startedAt = performance.now();
    }
    holdAudioOutput();
    return Math.max(0, keepAlive.startedAt + KEEP_ALIVE_LEAD_MS - performance.now());
  } catch {
    return 0;
  }
}

function holdAudioOutput() {
  clearTimeout(keepAlive.timer);
  keepAlive.timer = setTimeout(() => {
    try {
      keepAlive.osc?.stop();
      keepAlive.osc?.disconnect();
      keepAlive.ctx?.suspend();
    } catch { /* ignore */ }
    keepAlive.osc = null;
  }, KEEP_ALIVE_HOLD_MS);
}

let currentUtterance = null; // keep a reference: Chrome may garbage-collect it mid-speech
let speakTimer = 0;

async function speak(word, btn, lang = 'en-US') {
  const wait = wakeAudioOutput(); // must run inside the click handler (user gesture)
  const busy = speechSynthesis.speaking || speechSynthesis.pending;
  if (busy) speechSynthesis.cancel();
  btn?.classList.add('playing');
  await loadVoices();

  const u = new SpeechSynthesisUtterance(word);
  u.lang = lang;
  const { voice } = pickVoice(lang);
  if (voice) u.voice = voice;
  u.rate = 0.85;
  u.onend = u.onerror = () => {
    btn?.classList.remove('playing');
    if (currentUtterance === u) currentUtterance = null;
    if (keepAlive.osc) holdAudioOutput();
  };
  currentUtterance = u;
  clearTimeout(speakTimer);
  speakTimer = setTimeout(() => {
    speechSynthesis.resume(); // Safari/Chrome can get stuck paused
    speechSynthesis.speak(u);
  }, Math.max(wait, busy ? 150 : 0));
}

/** Settings → Pronunciation: show which voices are in use. */
async function renderVoiceInfo() {
  const box = $('#voiceInfo');
  if (!('speechSynthesis' in window)) {
    box.textContent = t('voiceUnsupported');
    $('#voiceTest').hidden = true;
    return;
  }
  await loadVoices();
  const uk = pickVoice('en-GB');
  const us = pickVoice('en-US');
  const name = (v) => v.voice?.name || t('voiceDefault');
  const lines = [h('div', {}, t('voiceUsing', { uk: name(uk), us: name(us) }))];
  if (!uk.genderMatched || !us.genderMatched) {
    lines.push(h('div', { class: 'muted small' },
      t(prefs.get('voice', 'female') === 'female' ? 'voiceMissingFemale' : 'voiceMissingMale'),
      /Mac/.test(navigator.platform) ? ' ' + t('voiceMacHint') : ''));
  }
  box.replaceChildren(...lines);
  for (const r of document.querySelectorAll('input[name="voice"]')) r.checked = r.value === prefs.get('voice', 'female');
}

if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', () => {
    if ($('#settings').open) renderVoiceInfo();
  });
}

for (const r of document.querySelectorAll('input[name="voice"]')) {
  r.addEventListener('change', () => {
    prefs.set('voice', r.value);
    renderVoiceInfo();
  });
}
$('#voiceTestUK').addEventListener('click', (e) => speak('pronunciation', e.currentTarget, 'en-GB'));
$('#voiceTestUS').addEventListener('click', (e) => speak('pronunciation', e.currentTarget, 'en-US'));

const ipaText = (ipa) => ipa.split(', ').map((p) => `/${p}/`).join(', ');

/** British + American IPA, each with its own play button. */
function pronunciations(e, { compact = false } = {}) {
  const word = e[F.WORD];
  // Data built before UK/US IPA existed only has ECDICT's single phonetic.
  const ipa = { uk: e[F.UK] ?? e[F.PHON], us: e[F.US] ?? '' };
  const canSpeak = !compact && 'speechSynthesis' in window;
  const items = ['uk', 'us'].filter((k) => ipa[k] || canSpeak).map((k) => {
    const label = t(k === 'uk' ? 'speakUK' : 'speakUS');
    let btn = null;
    if (canSpeak) {
      btn = h('button', { type: 'button', class: 'icon-btn speak', title: label, 'aria-label': label }, icon(SPEAKER));
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        speak(word, btn, k === 'uk' ? 'en-GB' : 'en-US');
      });
    }
    return h('span', { class: 'pron' },
      h('span', { class: 'accent ' + k, lang: getLang() }, t(k)),
      ipa[k] ? h('span', { class: 'phon' }, ipaText(ipa[k])) : null,
      btn);
  });
  return items.length ? h('div', { class: 'prons' + (compact ? ' compact' : '') }, items) : null;
}

function renderEntry(e) {
  const word = e[F.WORD];
  const exch = parseExchange(e[F.EXCH]);
  const card = h('article', { class: 'card entry', lang: 'en' });

  card.append(h('div', { class: 'entry-head' }, h('h1', {}, word)), pronunciations(e));

  const badges = [];
  if (e[F.COLLINS]) {
    badges.push(h('span', { class: 'badge stars', title: t('collins') },
      '★'.repeat(e[F.COLLINS]) + '☆'.repeat(5 - e[F.COLLINS])));
  }
  if (e[F.OXFORD]) badges.push(h('span', { class: 'badge oxford' }, t('oxford')));
  for (const tag of e[F.TAGS] ? e[F.TAGS].split(' ') : []) badges.push(h('span', { class: 'badge exam' }, tag));
  if (badges.length) card.append(h('div', { class: 'badges' }, badges));

  // "went" → past tense of "go"
  if (exch['0'] && exch['0'].toLowerCase() !== word.toLowerCase()) {
    const types = (exch['1'] || '').split('').map((c) => t('x.' + c)).filter((s) => !s.startsWith('x.'));
    const type = types.length ? types.join(' / ') : t('x.1');
    const [before, after] = t('lemmaOf', { type }).split('{word}');
    card.append(h('div', { class: 'lemma', lang: getLang() }, before, h('a', { href: wordHref(exch['0']) }, exch['0']), after));
  }

  const zh = e[F.TRANS].split('\n').filter(Boolean);
  card.append(h('section', { class: 'block', lang: 'zh-Hant' },
    h('span', { class: 'label', lang: getLang() }, t('translations')),
    h('ul', { class: 'senses zh' }, zh.map((l) => senseItem(l, false)))));

  const forms = EXCH_ORDER.filter((k) => exch[k]).flatMap((k) =>
    exch[k].split(',').filter((w) => w && w !== word).map((w) =>
      h('a', { class: 'form', href: wordHref(w) }, h('span', { lang: getLang() }, t('x.' + k)), w)));
  if (forms.length) {
    card.append(h('section', { class: 'block' }, h('span', { class: 'label', lang: getLang() }, t('forms')),
      h('div', { class: 'forms' }, forms)));
  }

  const defs = e[F.DEF].split('\n').filter(Boolean);
  if (defs.length) {
    const SHOW = 6;
    const extra = defs.slice(SHOW);
    card.append(h('section', { class: 'block' },
      h('span', { class: 'label', lang: getLang() }, t('definitions')),
      h('ul', { class: 'senses defs' }, defs.slice(0, SHOW).map((l) => senseItem(l, true))),
      extra.length > 0 && h('details', { class: 'more' },
        h('summary', {}, `+ ${extra.length}`),
        h('ul', { class: 'senses defs' }, extra.map((l) => senseItem(l, true))))));
  }
  return card;
}

async function renderChinese(q) {
  const groups = await data.reverseLookup(q);
  if (!groups.length) {
    return [webCard(q), h('div', { class: 'card not-found' }, h('h2', {}, t('notFound', { q })), h('p', { class: 'muted' }, t('noSuggestions')))];
  }
  const main = groups[0].exact ? groups[0] : null;
  const related = main ? groups.slice(1) : groups;
  // No exact match, only longer terms starting with q: ask Wikipedia too.
  const nodes = main ? [] : [webCard(q)];

  if (main) {
    const rows = main.words.map((w) => {
      const g = h('span', { class: 'g' });
      data.glossFor(w).then((s) => { g.textContent = s; }, () => {});
      return h('li', {}, h('a', { href: wordHref(w) }, h('span', { class: 'w', lang: 'en' }, w), g));
    });
    nodes.push(h('section', { class: 'card zh-group' },
      h('span', { class: 'label' }, t('chineseResults', { q })),
      h('h2', { lang: 'zh-Hant' }, main.term),
      h('ul', { class: 'word-list' }, rows)));
  }
  if (related.length) {
    nodes.push(h('section', { class: 'card' },
      h('span', { class: 'label' }, t('relatedTerms')),
      h('div', { class: 'related' }, related.slice(0, 15).map((g) =>
        h('a', { href: wordHref(g.term) },
          h('span', { class: 'term', lang: 'zh-Hant' }, g.term),
          h('span', { class: 'g', lang: 'en' }, g.words.slice(0, 5).join(', ')))))));
  }
  return nodes;
}

$('#clearRecent').addEventListener('click', () => {
  prefs.set('recent', '[]');
  renderRecent();
});

// ---------------------------------------------------------------- settings & offline download

const dialog = $('#settings');
let downloading = null; // AbortController while a download runs

function openSettings() {
  applyLang();
  dialog.showModal();
  refreshOfflineStatus();
  renderVoiceInfo();
}

$('#settingsBtn').addEventListener('click', openSettings);
$('#ctaBtn').addEventListener('click', () => {
  openSettings();
  if (!downloading) startDownload();
});
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close(); // click on backdrop
});

for (const r of document.querySelectorAll('input[name="lang"]')) {
  r.addEventListener('change', () => {
    prefs.set('lang', r.value);
    onLangChange();
  });
}
for (const r of document.querySelectorAll('input[name="theme"]')) {
  r.addEventListener('change', () => {
    prefs.set('theme', r.value);
    applyTheme();
  });
}

async function refreshOfflineStatus() {
  let st;
  try {
    await ready;
    st = await data.status();
  } catch {
    $('#offlineStatus').textContent = t('loadError');
    $('#dlBtn').hidden = true;
    $('#rmBtn').hidden = true;
    return;
  }
  const dl = $('#dlBtn');
  const rm = $('#rmBtn');
  if (!downloading) {
    if (st.offline) {
      $('#offlineStatus').textContent = st.updateAvailable
        ? `${t('offlineReady')} ${t('updateAvailable')}` : t('offlineReady');
      dl.hidden = !st.updateAvailable;
      dl.textContent = t('update');
    } else {
      $('#offlineStatus').textContent = `${t('offlineDesc', { count: fmtNum(st.count), size: fmtMB(st.gzBytes) })} `
        + (st.storedFiles ? t('offlinePartial', { stored: st.storedFiles, total: st.totalFiles }) : '');
      dl.hidden = false;
      dl.textContent = t('download');
    }
    rm.hidden = !st.storedFiles;
  }
  $('#dataVersion').textContent = `${t('dataVersion', { v: st.version, count: fmtNum(st.count) })} · ${t('appBuild', { b: buildId })}`;
  try {
    const est = await navigator.storage?.estimate?.();
    $('#storageInfo').textContent = est?.usage ? t('storageUsed', { size: fmtMB(est.usage) }) : '';
  } catch {
    $('#storageInfo').textContent = '';
  }
}

async function startDownload(update = false) {
  const ctrl = new AbortController();
  downloading = ctrl;
  const dl = $('#dlBtn');
  const bar = $('#progress');
  bar.hidden = false;
  $('#rmBtn').hidden = true;
  $('#offlineCta').hidden = true;
  dl.hidden = false;
  dl.classList.replace('primary', 'ghost');
  const show = (p) => {
    const pct = p.totalBytes ? Math.floor((p.bytes / p.totalBytes) * 100) : 0;
    bar.firstElementChild.style.width = pct + '%';
    $('#offlineStatus').textContent = t('downloading', { pct });
    dl.textContent = t('cancel');
  };
  show({ bytes: 0, totalBytes: 1 });
  try {
    await data.downloadAll({ onProgress: show, signal: ctrl.signal, update });
    toast(t('downloadDone'));
  } catch (err) {
    if (err.name !== 'AbortError') toast(t('downloadFailed', { msg: err.message }));
  } finally {
    downloading = null;
    bar.hidden = true;
    dl.classList.replace('ghost', 'primary');
    refreshOfflineStatus();
    if (document.body.classList.contains('is-home')) showHome();
  }
}

$('#dlBtn').addEventListener('click', async () => {
  if (downloading) {
    downloading.abort();
    return;
  }
  const st = await data.status();
  startDownload(st.offline && st.updateAvailable);
});

$('#rmBtn').addEventListener('click', async () => {
  if (!confirm(t('removeConfirm'))) return;
  await data.deleteOffline();
  refreshOfflineStatus();
});

// ---------------------------------------------------------------- header buttons

$('#themeBtn').addEventListener('click', () => {
  const order = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(prefs.get('theme', 'system')) + 1) % order.length];
  prefs.set('theme', next);
  applyTheme();
  toast(t('switchTheme', { mode: t(next) }), 1400);
});

$('#langBtn').addEventListener('click', () => {
  prefs.set('lang', getLang() === 'en' ? 'zh-Hant' : 'en');
  onLangChange();
});

darkMq.addEventListener('change', applyTheme);
window.addEventListener('languagechange', () => {
  if (prefs.get('lang', 'system') === 'system') onLangChange();
});

// ---------------------------------------------------------------- toast, network, PWA

let toastTimer = 0;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function updateNet() {
  $('#netPill').hidden = navigator.onLine;
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

// ---- install (PWA)
//
// States: standalone (running as the installed app), installed (installed,
// but opened in a browser tab), available (browser offers an install prompt),
// manual (iOS / macOS Safari: install from the browser menu), insecure (plain
// HTTP: browsers refuse to install), unsupported.

const standaloneMq = matchMedia('(display-mode: standalone), (display-mode: fullscreen), '
  + '(display-mode: minimal-ui), (display-mode: window-controls-overlay)');
const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isMacSafari = !isIOS && /Macintosh/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua)
  && !/Chrome|Chromium|CriOS|Edg|Firefox|OPR/.test(ua);
// Desktop Chrome / Edge install from the address bar or menu; they may hold back
// beforeinstallprompt (engagement heuristics), so offer the manual steps too.
const isEdge = /Edg\//.test(ua);
const isChromiumDesktop = !isIOS && !/Android|Mobile/.test(ua)
  && (navigator.userAgentData?.brands?.some((b) => /Chrome|Chromium|Edge/.test(b.brand)) ?? /Chrome\//.test(ua))
  && !/OPR|Firefox/.test(ua);
const INSTALL_ICON = '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 7.5v6m0 0-2.5-2.5M12 13.5l2.5-2.5"/>';
const SHARE_ICON = '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/>';

let installPrompt = null;
let relatedInstalled = false;
let promptWaitOver = false;
const PROMPT_WAIT_MS = 2500; // Chrome normally fires within ~1 s of load
setTimeout(() => {
  promptWaitOver = true;
  renderInstall();
}, PROMPT_WAIT_MS);

function installState() {
  if (standaloneMq.matches || navigator.standalone === true) return 'standalone';
  if (installPrompt) return 'available';
  if (relatedInstalled || prefs.get('installed', '0') === '1') return 'installed';
  if (!window.isSecureContext) return 'insecure';
  // Chromium fires beforeinstallprompt a few seconds after load (once the
  // service worker is ready). Wait for it so the button installs in one click;
  // fall back to manual steps only if it never comes (already installed, or
  // the user dismissed Chrome's prompt before).
  if (isChromiumDesktop && !promptWaitOver) return 'pending';
  if (isIOS || isMacSafari || isChromiumDesktop) return 'manual';
  return 'unsupported';
}

function renderInstall() {
  const state = installState();
  const canInstall = state === 'available' || state === 'manual';
  $('#installBtn').hidden = !canInstall;
  $('#installBtn2').hidden = !canInstall;
  $('#installStatus').textContent = t('install' + state[0].toUpperCase() + state.slice(1));
  root.dataset.install = state;
}

function showInstallHelp() {
  const steps = isIOS ? ['iosStep1', 'iosStep2', 'iosStep3']
    : isChromiumDesktop ? [isEdge ? 'edgeStep1' : 'chromeStep1', 'chromeStep2', 'chromeStep3', 'chromeStep4']
      : ['macStep1', 'macStep2'];
  $('#installSteps').replaceChildren(...steps.map((key) => {
    const [before, after = ''] = t(key).split('{icon}');
    const ic = key === 'iosStep1' ? SHARE_ICON : /^(chrome|edge)Step1$/.test(key) ? INSTALL_ICON : null;
    return h('li', {}, before, ic ? icon(ic) : null, after);
  }));
  $('#installHelp').showModal();
}

async function installApp() {
  if (installPrompt) {
    const promptEvent = installPrompt;
    installPrompt = null;
    promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === 'accepted') prefs.set('installed', '1');
    renderInstall();
  } else if (installState() === 'manual') {
    showInstallHelp();
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  prefs.set('installed', '0'); // the browser only offers this when not installed
  renderInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  prefs.set('installed', '1');
  renderInstall();
  toast(t('installDone'));
});
standaloneMq.addEventListener('change', renderInstall);
$('#installBtn').addEventListener('click', installApp);
$('#installBtn2').addEventListener('click', installApp);
$('#installHelp').addEventListener('click', (e) => {
  if (e.target === $('#installHelp')) $('#installHelp').close();
});

// Chromium can tell whether this web app is installed (manifest related_applications).
if ('getInstalledRelatedApps' in navigator) {
  navigator.getInstalledRelatedApps().then((apps) => {
    relatedInstalled = apps.length > 0;
    if (relatedInstalled) prefs.set('installed', '1');
    renderInstall();
  }).catch(() => {});
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker registration failed', e));
}

// ---------------------------------------------------------------- start

// Support ?q=word links (e.g. from search engines or shortcuts).
const params = new URLSearchParams(location.search);
if (params.get('q')) {
  history.replaceState(null, '', location.pathname + wordHref(params.get('q')));
}

applyLang();
renderInstall();
updateNet();
window.addEventListener('hashchange', route);
route();
