'use strict';

const API = 'https://assembly-minutes-api.neoulneoul.workers.dev';
const POLL_MS = 4000;
const LIST_POLL_MS = 30000;
const GAP_MINUTES = 10;
const MAX_RESULTS = 500;

const $ = (id) => document.getElementById(id);
const els = {
  select: $('meetingSelect'), liveBadge: $('liveBadge'), video: $('videoLink'), banner: $('banner'),
  search: $('searchInput'), matchInfo: $('matchInfo'), prev: $('prevMatch'), next: $('nextMatch'),
  filterOnly: $('filterOnly'), follow: $('followLive'),
  status: $('status'), transcript: $('transcript'), jumpNew: $('jumpNew'),
  copySel: $('copySel'), copyMatches: $('copyMatches'), copyAll: $('copyAll'), saveTxt: $('saveTxt'),
  withTime: $('withTime'),
  rosterForm: $('rosterForm'), rosterInput: $('rosterInput'), roster: $('roster'), detected: $('detected'),
  applyAll: $('applyAllSuggest'),
  results: $('results'), resultCount: $('resultCount'),
  pop: $('popover'), popInput: $('popInput'), popList: $('popList'), popClear: $('popClear'),
  toast: $('toast'),
};

const state = {
  meetings: [],
  current: null,      // meeting object
  segs: [],           // [{n, t, at}] sorted by n
  byN: new Map(),     // n -> seg
  lineEl: new Map(),  // n -> element
  assign: {},         // n -> speaker label (speaker changes from this line on)
  roster: [],
  suggestions: new Map(), // n -> label
  terms: [], regex: null,
  matches: [],        // ns
  cur: -1,
  selected: new Set(),
  anchor: null, active: null,
  pollTimer: null, listTimer: null,
  unseen: 0,
  loadToken: 0,
};

/* ---------- utils ---------- */
const timeFmt = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const hms = (iso) => (iso ? timeFmt.format(new Date(iso)) : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function store(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable */ }
}
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

async function getJSON(path) {
  const res = await fetch(API + path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let toastTimer;
function toast(msg, action) {
  els.toast.innerHTML = esc(msg);
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn small'; b.style.marginLeft = '10px'; b.textContent = action.label;
    b.onclick = () => { action.run(); els.toast.hidden = true; };
    els.toast.append(b);
  }
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, action ? 6000 : 2200);
}

const isMunche = (m) => m.channel === '문체위' || m.slug === 'munche' || /문화체육관광위원회/.test(m.subject || '');

/* ---------- meetings ---------- */
async function loadMeetings(initial) {
  const [md, live] = await Promise.allSettled([getJSON('/api/md/live'), getJSON('/api/live/list')]);
  if (md.status === 'fulfilled') {
    state.meetings = (md.value.meetings || [])
      .filter((m) => m.xcgcd && m.segment_count > 0 && isMunche(m))
      .sort((a, b) => (b.collecting - a.collecting)
        || String(b.conf_date).localeCompare(String(a.conf_date))
        || String(b.started_at).localeCompare(String(a.started_at)));
  } else if (initial) {
    setStatus('회의 목록을 받지 못했습니다. 잠시 후 새로고침해 주세요.');
    return;
  }

  const channel = live.status === 'fulfilled'
    ? (live.value.xlist || []).find((x) => x.xcgcd && isMunche({ channel: x.xname, subject: x.xsubj }))
    : null;
  state.channel = channel || null;
  const onAir = channel?.xstat === '1' ? channel : null;

  renderMeetingSelect();
  if (state.current) updateMeetingChrome();

  if (initial) {
    const fromHash = decodeURIComponent(location.hash.slice(1));
    const pick = state.meetings.find((m) => m.xcgcd === fromHash) || state.meetings[0];
    if (pick) selectMeeting(pick.xcgcd);
    else setStatus('수집된 문체위 회의가 없습니다.');
  } else if (state.current) {
    const fresh = state.meetings.find((m) => m.xcgcd === state.current.xcgcd);
    if (fresh) {
      const wasLive = state.current.collecting;
      state.current = fresh;
      updateMeetingChrome();
      if (wasLive && !fresh.collecting) stopPolling();
      if (!wasLive && fresh.collecting) startPolling();
    }
  }

  // Banner: a 문체위 broadcast that is not the one being viewed.
  const otherLive = state.meetings.find((m) => m.collecting && m.xcgcd !== state.current?.xcgcd);
  if (otherLive) {
    showBanner(`문체위 생중계 진행 중: ${otherLive.subject}`, '이동', () => selectMeeting(otherLive.xcgcd));
  } else if (onAir && !state.meetings.some((m) => m.xcgcd === onAir.xcgcd)) {
    showBanner(`문체위 중계가 시작됐습니다 (${onAir.xsubj || '회의'}). 속기 수집이 시작되면 목록에 나타납니다.`);
  } else {
    els.banner.hidden = true;
  }
}

function showBanner(text, actionLabel, action) {
  els.banner.innerHTML = `<span>${esc(text)}</span>`;
  if (actionLabel) {
    const b = document.createElement('button');
    b.className = 'btn small'; b.textContent = actionLabel; b.onclick = action;
    els.banner.append(b);
  }
  els.banner.hidden = false;
}

function renderMeetingSelect() {
  const cur = state.current?.xcgcd;
  els.select.innerHTML = state.meetings.map((m) => {
    const label = `${m.collecting ? '● 생중계 · ' : ''}${m.conf_date || '날짜미상'} ${m.subject} (${m.segment_count.toLocaleString()}줄)`;
    return `<option value="${esc(m.xcgcd)}"${m.xcgcd === cur ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

function updateMeetingChrome() {
  const m = state.current;
  // While the broadcast is paused (정회·감사중지) the channel still names this meeting.
  const paused = !m?.collecting && state.channel?.xcgcd === m?.xcgcd && state.channel?.xstat !== '1' && state.channel?.xbttn;
  els.liveBadge.hidden = !m?.collecting && !paused;
  els.liveBadge.textContent = m?.collecting ? '● 생중계' : `⏸ ${state.channel?.xbttn || ''}`;
  els.liveBadge.classList.toggle('paused', !!paused);
  if (m?.xcode && m?.xcgcd) {
    els.video.href = `https://assembly.webcast.go.kr/main/player.asp?xcode=${encodeURIComponent(m.xcode)}&xcgcd=${encodeURIComponent(m.xcgcd)}`;
    els.video.hidden = false;
  } else {
    els.video.hidden = true;
  }
  document.title = `${m?.collecting ? '● ' : ''}문체위 실시간 속기 - 한국관광공사 상황반`;
}

async function selectMeeting(xcgcd) {
  const m = state.meetings.find((x) => x.xcgcd === xcgcd);
  if (!m) return;
  stopPolling();
  const token = ++state.loadToken;
  state.current = m;
  state.segs = []; state.byN = new Map();
  state.selected.clear(); state.active = null; state.anchor = null; state.unseen = 0;
  state.assign = load(`munche.assign.${xcgcd}`, {});
  els.select.value = xcgcd;
  history.replaceState(null, '', `#${encodeURIComponent(xcgcd)}`);
  updateMeetingChrome();
  els.transcript.innerHTML = '';
  setStatus('속기를 불러오는 중…');

  try {
    const data = await getJSON(`/api/stt/backlog?xcgcd=${encodeURIComponent(xcgcd)}&after=0`);
    if (token !== state.loadToken) return;
    mergeSegments(data.segments || []);
    setStatus(state.segs.length ? '' : '아직 속기가 없습니다.');
    renderAll();
    if (m.collecting && els.follow.checked) scrollToBottom();
    else window.scrollTo(0, 0);
    if (m.collecting) startPolling();
  } catch (e) {
    if (token === state.loadToken) setStatus(`속기를 받지 못했습니다 (${e.message}). 다시 선택해 주세요.`);
  }
}

function setStatus(text) { els.status.textContent = text; }

/* ---------- segments & polling ---------- */
// Returns segments that are new (not previously known). Existing ones whose text changed are updated in place.
function mergeSegments(list) {
  const added = [];
  for (const raw of list) {
    if (raw == null || raw.n == null || !raw.t) continue;
    const prev = state.byN.get(raw.n);
    if (prev) {
      if (prev.t !== raw.t) { prev.t = raw.t; const el = state.lineEl.get(raw.n); if (el) fillLine(el, prev); }
      continue;
    }
    const seg = { n: raw.n, t: String(raw.t).trim(), at: raw.at };
    state.byN.set(seg.n, seg);
    added.push(seg);
  }
  if (added.length) {
    const lastN = state.segs.length ? state.segs[state.segs.length - 1].n : -Infinity;
    state.segs.push(...added);
    if (added.some((s) => s.n < lastN)) state.segs.sort((a, b) => a.n - b.n);
    else added.sort((a, b) => a.n - b.n);
  }
  return added;
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(poll, POLL_MS);
}
function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }

let polling = false;
async function poll() {
  if (polling || document.hidden || !state.current) return;
  polling = true;
  const token = state.loadToken;
  try {
    const lastN = state.segs.length ? state.segs[state.segs.length - 1].n : 0;
    const data = await getJSON(`/api/stt/backlog?xcgcd=${encodeURIComponent(state.current.xcgcd)}&after=${Math.max(0, lastN - 2)}`);
    if (token !== state.loadToken) return;
    const wasNearBottom = nearBottom();
    const lastBefore = state.segs[state.segs.length - 1]?.n;
    const added = mergeSegments(data.segments || []);
    if (!added.length) return;
    setStatus('');
    computeSuggestions();
    // Out-of-order arrival is rare; fall back to a full render when it happens.
    if (lastBefore != null && added[0].n < lastBefore) renderAll();
    else appendLines(added);
    refreshSearch(false);
    renderDetected();
    if (els.follow.checked && wasNearBottom) scrollToBottom();
    else { state.unseen += added.length; showJumpNew(); }
  } catch { /* transient; next tick retries */ } finally { polling = false; }
}

/* ---------- speakers ---------- */
const NAME_STOP = new Set(['존경하는', '여러', '우리', '모든', '다른', '해당', '그러면', '다음은', '다음으로', '이어서', '먼저', '간사', '각', '소속', '여야', '전체', '참석', '증인', '국민의힘', '민주당']);
const okName = (s) => s && s.length >= 2 && s.length <= 4 && !NAME_STOP.has(s) && !/위원|회$|님$/.test(s);
const RE_CALL = /([가-힣]{2,4})\s*(?:위원|의원)님?[,.\s]*(?:수고(?:하셨|많으셨)습니다[.,\s]*)?(?:보충\s*|추가\s*)?(?:질의|질문|말씀|발언|토론|의사진행\s*발언)(?:을|를)?\s*(?:이어\s*가|해|하여|하)?\s*(?:주시기\s*바랍니다|주십시오|주세요|주시죠|하시겠습니다|하십시오|바랍니다)/;
// "○○○ 위원님께 의사진행발언 1분 드리겠습니다", "○○○ 위원님부터", or a bare "○○○ 위원님" line.
const RE_GIVE = /([가-힣]{2,4})\s*위원님께\s*[^.]{0,20}?(?:발언|질의|시간|\d+\s*분)[^.]{0,10}?드리겠습니다/;
const RE_FROM = /([가-힣]{2,4})\s*위원님부터/;
const RE_BARE = /^\s*(?:네|예)?\s*([가-힣]{2,4})\s*위원님[.?!\s]*$/;
const RE_NEXT = /(?:다음은|다음으로|이어서)\s*([가-힣]{2,4})\s*(?:위원|의원)님(?![^.]{0,24}순(?:입니다|으로|서))/;
const RE_INTRO = /([가-힣]{2,4})\s*(위원장|소위원장|간사|위원|의원|장관|차관|청장|원장|사장|이사장|회장|처장|실장|본부장)입니다/;
const RE_ANSWER = /(장관|차관|청장|원장|사장|이사장|회장|처장|실장|본부장)님?\s*(?:께서\s*)?답변(?:해|하여|하시|을)?/;

function chairLabel() {
  return state.roster.find((r) => /^위원장/.test(r) || / 위원장$/.test(r)) || '위원장';
}

function computeSuggestions() {
  const sug = new Map();
  const segs = state.segs;
  const eff = effectiveSpeakers();
  const put = (i, label) => {
    const s = segs[i];
    if (!s || state.assign[s.n] !== undefined) return;
    if (eff[i] === label) return;
    sug.set(s.n, label);
  };
  for (let i = 0; i < segs.length; i++) {
    const t = segs[i].t;
    let m = t.match(RE_INTRO);
    if (m && m.index < 30 && okName(m[1])) {
      const role = m[2] === '의원' ? '위원' : m[2];
      put(i, `${m[1]} ${role}`);
      continue;
    }
    m = t.match(RE_CALL) || t.match(RE_NEXT) || t.match(RE_GIVE) || t.match(RE_FROM) || t.match(RE_BARE);
    if (m && okName(m[1])) {
      put(i, chairLabel());
      put(i + 1, `${m[1]} 위원`);
      continue;
    }
    m = t.match(RE_ANSWER);
    if (m) {
      put(i + 1, m[1]);
    }
  }
  state.suggestions = sug;
}

// Speaker label effective at each index of state.segs.
function effectiveSpeakers() {
  const out = new Array(state.segs.length);
  let cur = null;
  for (let i = 0; i < state.segs.length; i++) {
    const a = state.assign[state.segs[i].n];
    if (a !== undefined) cur = a || null;
    out[i] = cur;
  }
  return out;
}

function saveAssign() { if (state.current) store(`munche.assign.${state.current.xcgcd}`, state.assign); }

function setSpeaker(n, label, { silent } = {}) {
  if (label) {
    state.assign[n] = label;
    addToRoster(label, true);
  } else {
    delete state.assign[n];
  }
  saveAssign();
  computeSuggestions();
  renderAll(true);
  renderDetected();
  if (!silent) toast(label ? `화자 지정: ${label}` : '화자 지정 해제');
}

function applyAllSuggestions() {
  if (!state.suggestions.size) return;
  const before = { ...state.assign };
  const count = state.suggestions.size;
  for (const [n, label] of state.suggestions) state.assign[n] = label;
  saveAssign();
  computeSuggestions();
  renderAll(true);
  renderDetected();
  toast(`제안 ${count}건 적용`, {
    label: '되돌리기',
    run: () => { state.assign = before; saveAssign(); computeSuggestions(); renderAll(true); renderDetected(); },
  });
}

/* ---------- roster ---------- */
function addToRoster(label, quiet) {
  label = label.trim();
  if (!label || state.roster.includes(label)) return;
  state.roster.push(label);
  store('munche.roster', state.roster);
  renderRoster();
  if (!quiet) toast(`명부에 추가: ${label}`);
}

function renderRoster() {
  els.roster.innerHTML = '';
  state.roster.forEach((name, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="num">${i < 9 ? i + 1 : ''}</span><span class="name" title="선택한 줄에 지정">${esc(name)}</span><button class="rm" title="명부에서 삭제">×</button>`;
    li.querySelector('.name').onclick = () => {
      if (state.active == null) return toast('먼저 본문에서 줄을 클릭해 주세요.');
      setSpeaker(state.active, name);
    };
    li.querySelector('.rm').onclick = () => {
      state.roster.splice(i, 1);
      store('munche.roster', state.roster);
      renderRoster();
    };
    els.roster.append(li);
  });
}

function renderDetected() {
  const labels = [...new Set(state.suggestions.values())].filter((l) => !state.roster.includes(l));
  els.detected.innerHTML = labels.length ? '<span class="lbl">본문에서 감지된 화자 (클릭해 명부에 추가)</span>' : '';
  for (const l of labels) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = `+ ${l}`;
    b.onclick = () => addToRoster(l);
    els.detected.append(b);
  }
  els.applyAll.hidden = !state.suggestions.size;
  els.applyAll.textContent = `화자 제안 ${state.suggestions.size}건 모두 적용`;
}

/* ---------- rendering ---------- */
function highlight(text) {
  if (!state.regex) return esc(text);
  let out = ''; let last = 0;
  state.regex.lastIndex = 0;
  for (const m of text.matchAll(state.regex)) {
    if (!m[0]) continue;
    out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const isMatch = (seg) => !!state.regex && seg.t.search(state.regex) !== -1;

function fillLine(el, seg) {
  const sug = state.suggestions.get(seg.n);
  el.querySelector('.x').innerHTML =
    (sug ? `<span class="sug" data-sug="${esc(sug)}" title="클릭하면 이 줄부터 화자로 지정">제안 · ${esc(sug)} ✓</span>` : '') + highlight(seg.t);
}

function makeLine(seg) {
  const el = document.createElement('div');
  el.className = 'ln';
  el.dataset.n = seg.n;
  el.innerHTML = `<span class="t">${esc(hms(seg.at))}</span><span class="x"></span>` +
    `<span class="tools"><button data-act="spk" title="이 줄부터 화자 지정">화자</button><button data-act="copy" title="이 줄 복사">복사</button></span>`;
  fillLine(el, seg);
  if (state.selected.has(seg.n)) el.classList.add('sel');
  if (state.active === seg.n) el.classList.add('active');
  state.lineEl.set(seg.n, el);
  return el;
}

function makeSpeakerHeader(n, label) {
  const h = document.createElement('div');
  h.className = 'spk';
  h.dataset.n = n;
  h.innerHTML = `<span>◯ ${esc(label)}</span><button class="edit" data-act="edit" title="화자 바꾸기">변경</button><button class="del" data-act="del" title="여기서 화자 지정 해제">해제</button>`;
  return h;
}

function makeGap(prev, seg) {
  if (!prev?.at || !seg?.at) return null;
  const min = Math.round((new Date(seg.at) - new Date(prev.at)) / 60000);
  if (min < GAP_MINUTES) return null;
  const g = document.createElement('div');
  g.className = 'gap';
  g.textContent = `— ${min}분 공백 (정회·중계 중단 등) —`;
  return g;
}

function renderAll(keepScroll) {
  const y = window.scrollY;
  computeSuggestions();
  const filter = els.filterOnly.checked && state.regex;
  const eff = effectiveSpeakers();
  const frag = document.createDocumentFragment();
  state.lineEl = new Map();
  let lastShownSpk;
  let prevSeg = null;
  state.segs.forEach((seg, i) => {
    if (filter && !isMatch(seg)) return;
    if (!filter) {
      const gap = makeGap(prevSeg, seg);
      if (gap) frag.append(gap);
    }
    const spk = eff[i];
    if (spk && (spk !== lastShownSpk || state.assign[seg.n] !== undefined)) {
      frag.append(makeSpeakerHeader(findAssignAnchor(i), spk));
    }
    lastShownSpk = spk;
    frag.append(makeLine(seg));
    prevSeg = seg;
  });
  els.transcript.replaceChildren(frag);
  if (filter && !state.matches.length) setStatus('일치하는 줄이 없습니다.');
  else if (state.segs.length) setStatus('');
  refreshSearch(false);
  renderDetected();
  if (keepScroll) window.scrollTo(0, y);
}

// The line where the speaker effective at index i was assigned.
function findAssignAnchor(i) {
  for (let j = i; j >= 0; j--) if (state.assign[state.segs[j].n] !== undefined) return state.segs[j].n;
  return state.segs[i].n;
}

function appendLines(added) {
  const filter = els.filterOnly.checked && state.regex;
  const frag = document.createDocumentFragment();
  let prev = state.segs[state.segs.indexOf(added[0]) - 1] || null;
  for (const seg of added) {
    if (filter && !isMatch(seg)) { prev = seg; continue; }
    if (!filter) { const gap = makeGap(prev, seg); if (gap) frag.append(gap); }
    const el = makeLine(seg);
    el.classList.add('new');
    frag.append(el);
    prev = seg;
  }
  els.transcript.append(frag);
  // A suggestion may now target the line before the new ones (e.g. a call that just completed).
  const before = state.lineEl.get(state.segs[state.segs.indexOf(added[0]) - 1]?.n);
  if (before) fillLine(before, state.byN.get(Number(before.dataset.n)));
}

/* ---------- search ---------- */
function buildRegex(value) {
  state.terms = value.split(/[,，]/).map((s) => s.replace(/\s+/g, '')).filter(Boolean);
  if (!state.terms.length) { state.regex = null; return; }
  // Spacing-insensitive: AI captions space words inconsistently.
  const parts = state.terms.map((t) => [...t].map(reEsc).join('\\s*'));
  state.regex = new RegExp(parts.join('|'), 'gi');
}

function refreshSearch(resetCursor) {
  const prevCur = state.matches[state.cur];
  state.matches = state.regex ? state.segs.filter(isMatch).map((s) => s.n) : [];
  if (resetCursor) state.cur = -1;
  else state.cur = prevCur != null ? state.matches.indexOf(prevCur) : -1;
  els.matchInfo.textContent = state.regex
    ? (state.matches.length ? `${state.cur >= 0 ? state.cur + 1 : '–'} / ${state.matches.length}` : '0건')
    : '';
  els.copyMatches.disabled = !state.matches.length;
  els.resultCount.textContent = state.regex ? `${state.matches.length.toLocaleString()}건` : '';
  renderResults();
}

function renderResults() {
  els.results.innerHTML = '';
  if (!state.regex) {
    els.results.innerHTML = '<li class="more">키워드를 입력하면 일치하는 줄이 여기에 모입니다.</li>';
    return;
  }
  const frag = document.createDocumentFragment();
  state.matches.slice(0, MAX_RESULTS).forEach((n, idx) => {
    const seg = state.byN.get(n);
    const li = document.createElement('li');
    li.innerHTML = `<span class="rt">${esc(hms(seg.at))}</span>${highlight(seg.t)}`;
    li.onclick = () => gotoMatch(idx);
    frag.append(li);
  });
  if (state.matches.length > MAX_RESULTS) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `… 외 ${(state.matches.length - MAX_RESULTS).toLocaleString()}건 (↑↓ 버튼으로 이동)`;
    frag.append(li);
  }
  els.results.append(frag);
}

function gotoMatch(idx) {
  if (!state.matches.length) return;
  state.cur = (idx + state.matches.length) % state.matches.length;
  document.querySelectorAll('.ln.cur').forEach((e) => e.classList.remove('cur'));
  const n = state.matches[state.cur];
  const el = state.lineEl.get(n);
  els.matchInfo.textContent = `${state.cur + 1} / ${state.matches.length}`;
  if (!el) return;
  el.classList.add('cur');
  setActive(n);
  scrollToLine(el);
}

function scrollToLine(el) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    buildRegex(els.search.value);
    renderAll(!els.filterOnly.checked);
    refreshSearch(true);
    store('munche.query', els.search.value);
  }, 160);
});
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? state.cur - 1 : state.cur + 1); }
  if (e.key === 'Escape') { els.search.value = ''; els.search.dispatchEvent(new Event('input')); }
});
els.prev.onclick = () => gotoMatch(state.cur - 1);
els.next.onclick = () => gotoMatch(state.cur + 1);
els.filterOnly.onchange = () => { renderAll(); window.scrollTo(0, 0); };

/* ---------- selection ---------- */
function setActive(n) {
  if (state.active != null) state.lineEl.get(state.active)?.classList.remove('active');
  state.active = n;
  if (n != null) state.lineEl.get(n)?.classList.add('active');
}

function paintSelection() {
  for (const [n, el] of state.lineEl) el.classList.toggle('sel', state.selected.has(n));
  els.copySel.disabled = !state.selected.size;
  els.copySel.textContent = state.selected.size ? `선택 복사 (${state.selected.size}줄)` : '선택 복사';
}

function visibleNs() { return [...state.lineEl.keys()]; }

function clickLine(n, e) {
  if (e.shiftKey && state.anchor != null) {
    const vis = visibleNs();
    const a = vis.indexOf(state.anchor); const b = vis.indexOf(n);
    if (a >= 0 && b >= 0) {
      if (!(e.ctrlKey || e.metaKey)) state.selected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selected.add(vis[i]);
    }
  } else if (e.ctrlKey || e.metaKey) {
    state.selected.has(n) ? state.selected.delete(n) : state.selected.add(n);
    state.anchor = n;
  } else {
    const only = state.selected.size === 1 && state.selected.has(n);
    state.selected.clear();
    if (!only) state.selected.add(n);
    state.anchor = n;
  }
  setActive(n);
  paintSelection();
}

els.transcript.addEventListener('click', (e) => {
  const sugEl = e.target.closest('.sug');
  const lineEl = e.target.closest('.ln');
  const hdr = e.target.closest('.spk');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (hdr) {
    const n = Number(hdr.dataset.n);
    if (act === 'edit') openPopover(n, e.target);
    if (act === 'del') setSpeaker(n, null);
    return;
  }
  if (!lineEl) return;
  const n = Number(lineEl.dataset.n);
  if (sugEl) { setSpeaker(n, sugEl.dataset.sug); return; }
  if (act === 'spk') { setActive(n); openPopover(n, e.target); return; }
  if (act === 'copy') { copyText(formatSegs([state.byN.get(n)]), '1줄 복사했습니다'); return; }
  if (String(window.getSelection())) return; // user is selecting text with the mouse
  clickLine(n, e);
});

/* ---------- popover ---------- */
let popN = null; let popHl = 0; let popPicked = false;
function popOptions() {
  const q = els.popInput.value.replace(/\s+/g, '');
  const pool = [...new Set([...state.roster, ...state.suggestions.values(), ...Object.values(state.assign)])];
  return pool.filter((l) => !q || l.replace(/\s+/g, '').includes(q));
}
function renderPopList() {
  const opts = popOptions();
  popHl = Math.min(popHl, Math.max(0, opts.length - 1));
  els.popList.innerHTML = '';
  opts.forEach((l, i) => {
    const b = document.createElement('button');
    b.textContent = l;
    if (i === popHl) b.className = 'hl';
    b.onclick = () => { closePopover(); setSpeaker(popN, l); };
    els.popList.append(b);
  });
}
function openPopover(n, anchorEl) {
  popN = n; popHl = 0; popPicked = false;
  els.popInput.value = '';
  renderPopList();
  els.popClear.hidden = state.assign[n] === undefined;
  els.pop.hidden = false;
  const r = anchorEl.getBoundingClientRect();
  const w = els.pop.offsetWidth; const h = els.pop.offsetHeight;
  els.pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  els.pop.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  els.popInput.focus();
}
function closePopover() { els.pop.hidden = true; }
els.popInput.addEventListener('input', () => { popHl = 0; popPicked = false; renderPopList(); });
els.popInput.addEventListener('keydown', (e) => {
  const opts = popOptions();
  if (e.key === 'ArrowDown') { e.preventDefault(); popHl = Math.min(popHl + 1, opts.length - 1); popPicked = true; renderPopList(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); popHl = Math.max(popHl - 1, 0); popPicked = true; renderPopList(); }
  else if (e.key === 'Escape') closePopover();
  else if (e.key === 'Enter') {
    e.preventDefault();
    // Arrow-picked entry wins; otherwise typed text is taken as a (possibly new) speaker.
    const typed = els.popInput.value.trim();
    const chosen = popPicked || !typed ? opts[popHl] : typed;
    if (chosen) { closePopover(); setSpeaker(popN, chosen); }
  }
});
els.popClear.onclick = () => { closePopover(); setSpeaker(popN, null); };
document.addEventListener('mousedown', (e) => {
  if (!els.pop.hidden && !els.pop.contains(e.target) && !e.target.closest('[data-act]')) closePopover();
});

/* ---------- copy / export ---------- */
function formatSegs(list) {
  const withTime = els.withTime.checked;
  const fmt = document.querySelector('input[name="fmt"]:checked').value;
  const eff = effectiveSpeakers();
  const idxOf = new Map(state.segs.map((s, i) => [s.n, i]));
  const items = list.filter(Boolean).map((s) => ({ s, i: idxOf.get(s.n) })).sort((a, b) => a.i - b.i);
  const out = [];
  if (fmt === 'lines') {
    let lastSpk;
    for (const { s, i } of items) {
      if (eff[i] && eff[i] !== lastSpk) out.push(`◯${eff[i]}`);
      lastSpk = eff[i];
      out.push(`${withTime ? `[${hms(s.at)}] ` : ''}${s.t}`);
    }
    return out.join('\n');
  }
  // Minutes format: consecutive lines of the same speaker become one paragraph.
  let group = null;
  const flush = () => {
    if (!group) return;
    const head = (withTime ? `[${group.time}] ` : '') + (group.spk ? `◯${group.spk}  ` : '');
    out.push(head + group.texts.join(' '));
    group = null;
  };
  for (const { s, i } of items) {
    const spk = eff[i];
    if (!group || group.spk !== spk || i !== group.lastI + 1) {
      const gap = group && i !== group.lastI + 1;
      flush();
      if (gap) out.push('(중략)');
      group = { spk, time: hms(s.at), texts: [] };
    }
    group.texts.push(s.t);
    group.lastI = i;
  }
  flush();
  return out.join('\n\n');
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg);
}

const selectedSegs = () => [...state.selected].map((n) => state.byN.get(n));
els.copySel.onclick = () => copyText(formatSegs(selectedSegs()), `${state.selected.size}줄 복사했습니다`);
els.copyMatches.onclick = () => copyText(formatSegs(state.matches.map((n) => state.byN.get(n))), `검색 결과 ${state.matches.length}줄 복사했습니다`);
els.copyAll.onclick = () => copyText(formatSegs(state.segs), `전체 ${state.segs.length.toLocaleString()}줄 복사했습니다`);
els.saveTxt.onclick = () => {
  const m = state.current;
  if (!m) return;
  const header = [
    m.subject, `일자: ${m.conf_date || ''}`,
    '출처: 국회 인터넷의사중계 AI 자막 (미확정 속기 — 공식 회의록과 다를 수 있음)', '',
  ].join('\n');
  const blob = new Blob([`${header}\n${formatSegs(state.segs)}\n`], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `문체위_${m.conf_date || ''}_${m.subject.replace(/[\\/:*?"<>|\s]+/g, '_')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// Ctrl+C with lines selected (and no text highlighted) copies them in the chosen format.
document.addEventListener('copy', (e) => {
  if (String(window.getSelection()) || !state.selected.size || isTyping(e.target)) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', formatSegs(selectedSegs()));
  toast(`${state.selected.size}줄 복사했습니다`);
});

/* ---------- keyboard ---------- */
const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
document.addEventListener('keydown', (e) => {
  if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); els.search.focus(); els.search.select(); return; }
  if (e.key === 'Escape') {
    closePopover(); state.selected.clear(); paintSelection(); return;
  }
  if (state.active == null) return;
  if (/^[1-9]$/.test(e.key)) {
    const label = state.roster[Number(e.key) - 1];
    if (label) setSpeaker(state.active, label);
    return;
  }
  if (e.key === '0') { setSpeaker(state.active, null); return; }
  if (e.key === 'j' || e.key === 'k') {
    const vis = visibleNs();
    const i = vis.indexOf(state.active) + (e.key === 'j' ? 1 : -1);
    if (vis[i] != null) { setActive(vis[i]); state.lineEl.get(vis[i]).scrollIntoView({ block: 'nearest' }); }
  }
});

/* ---------- scrolling ---------- */
const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 200;
function scrollToBottom() {
  window.scrollTo(0, document.documentElement.scrollHeight);
  state.unseen = 0; els.jumpNew.hidden = true;
}
function showJumpNew() {
  if (!state.unseen) return;
  els.jumpNew.textContent = `새 발언 ${state.unseen}줄 ↓`;
  els.jumpNew.hidden = false;
}
els.jumpNew.onclick = scrollToBottom;
window.addEventListener('scroll', () => { if (nearBottom()) { state.unseen = 0; els.jumpNew.hidden = true; } }, { passive: true });
els.follow.onchange = () => { if (els.follow.checked && state.current?.collecting) scrollToBottom(); };

/* ---------- misc wiring ---------- */
els.select.onchange = () => selectMeeting(els.select.value);
els.applyAll.onclick = applyAllSuggestions;
els.rosterForm.onsubmit = (e) => { e.preventDefault(); addToRoster(els.rosterInput.value); els.rosterInput.value = ''; };
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.pollTimer) poll(); });

/* ---------- boot ---------- */
state.roster = load('munche.roster', []);
renderRoster();
const savedQuery = load('munche.query', '');
if (savedQuery) { els.search.value = savedQuery; buildRegex(savedQuery); }
refreshSearch(true);
loadMeetings(true);
state.listTimer = setInterval(() => { if (!document.hidden) loadMeetings(false).catch(() => {}); }, LIST_POLL_MS);
