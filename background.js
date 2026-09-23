/* =============================================================================
 * background.js — 세션 소유자 · 기록 로그 · sink (service worker)
 *
 * 소유: 세션(sessionId, epoch, recording, 검색어), 탭 → 페이지 대응표,
 *       기록 로그(rec:*)
 * 저장: chrome.storage.local
 *
 * --- 왜 세션이 여기로 왔나 --------------------------------------------------
 *   content script 는 페이지마다 새로 뜨고 페이지와 함께 죽는다. 세션을 거기
 *   두면 탭을 옮기거나 다른 글로 가는 순간 세션이 사라진다.
 *   세션은 여기 하나만 두고, 각 탭은 "지금 이 글" 구간만 기록해서 넘긴다.
 *
 * --- 기록 로그: 테스트 버전과 실사용 버전이 같은 데이터를 갖는 이유 ----------
 *   들어온 것은 전부 record 하나로 만들어 로그에 순서대로 쌓는다(put).
 *   가공하지 않는다. 모드가 달라도 put 까지는 완전히 같다.
 *
 *     content script ──page/chunk──▶ put() ──▶ rec:00000001, rec:00000002, ...
 *                                              │
 *                          download 모드: 쌓아뒀다가 export 때 assemble()
 *                          server   모드: 묶어서 전송, ACK 받으면 삭제 (미구현)
 *
 *   record 형식이 곧 서버 업로드 형식이다. assemble() 은 로그 → bundle 로 바꾸는
 *   순수 함수라서, 서버도 같은 로직으로 같은 bundle 을 만든다.
 *   "두 모드의 결과가 같은가" = "같은 로그를 넣으면 같은 bundle 이 나오는가".
 *
 * --- 글(pageId)과 구간(segId) ------------------------------------------------
 *   로그에는 구간 단위로 쌓는다. 구간 = "이 탭에서 이 글을 연 이번 한 번"
 *   (5-recorder 가 start() 마다 segId 를 만든다). 이게 원본이다.
 *   export 때 같은 글(pageId = origin + pageKey)의 구간들을 한 페이지로 합친다.
 *   이게 결정된 뷰다. 합쳐도 이벤트마다 segId·tabId 가 남으므로, 오프라인에서
 *   구간 단위로 다시 쪼갤 수 있고 연속 틱 간 차분을 경계에서 리셋할 수 있다.
 *   떠남/돌아옴(탭·창 전환)은 visit record 로 남는다. 첫 틱 전의 탭을 활성화하면
 *   visit 에는 tabId 만 남고 pageId 는 null 이다(탭 대응표는 page 기록이 채운다).
 *
 * --- 안 본 탭 ---------------------------------------------------------------
 *   5-recorder 는 첫 틱(보이고 + 창 포커스) 전에는 page 도 chunk 도 보내지 않는다.
 *   그래서 세션 중 한 번도 안 본 탭은 이 로그에 URL·원문이 들어오지 않는다.
 *   export 의 droppedPages 는 그 규칙이 깨진 이상 사례를 보여주는 안전망이다.
 *   틱은 보이는 탭에서만 돈다(5-recorder 의 hidden/focused 게이트). 여기선 안 막는다.
 *
 * --- export 모양 -------------------------------------------------------------
 *   { kind: 'rbc-session', bundleVersion: 1, session: {...}, pages: [ v2 payload ... ] }
 *   pages 의 각 원소는 기존 v2 payload 그대로다. extract_features.py 는 피처
 *   계산을 안 바꾸고, 읽을 때 pages 를 풀기만 하면 된다.
 *
 * --- service worker 라서 지키는 것 --------------------------------------------
 *   1) 유휴 30초면 종료된다. 메모리 상태는 캐시, 원본은 storage.
 *   2) 리스너는 최상위에서 동기적으로 등록해야 깨어날 때 이벤트를 받는다.
 *   3) 동시에 온 메시지가 읽기-수정-쓰기를 꼬지 않도록 전부 serial() 로 줄 세운다.
 * ========================================================================== */
'use strict';

const MODE = 'download';      // 'download' | 'server'  — 빌드 타깃이 바꾸는 유일한 값
const TICK_MS = 150;          // 0-core CFG.TICK_MS 와 같아야 한다
const K_SESS = 'sess:cur';    // 세션 상태 (작은 것만)
const REC = 'rec:';           // 기록 로그. 키 = 'rec:' + seq 8자리

// ============================================================================
// 세션 상태
// ============================================================================
function emptyState() {
  return {
    sessionId: null,
    epoch: 0,
    recording: false,
    query: null,
    seq: 0,              // 기록 로그 번호. 도착 순서 = 저장 순서
    tabPage: {},         // tabId → pageId (지금 그 탭이 보여주는 글)
    tabSeg: {},          // tabId → segId  (지금 그 탭에서 열린 구간)
    lastVisit: null,     // 같은 곳 연속 기록 방지용
  };
}

let S = emptyState();
const ready = chrome.storage.local.get(K_SESS).then((r) => {
  if (r[K_SESS]) S = Object.assign(emptyState(), r[K_SESS]);   // 필드가 늘어난 뒤의 옛 상태 대비
});

let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(() => ready).then(fn);
  chain = p.catch(() => {});
  return p;
}

function saveState() { return chrome.storage.local.set({ [K_SESS]: S }); }
function tNow() { return Date.now() - S.epoch; }

// ============================================================================
// put — 모든 기록이 지나가는 유일한 입구. 모드와 무관하다.
// ============================================================================
async function put(rec) {
  const r = Object.assign({ seq: S.seq, ts: Date.now(), sessionId: S.sessionId }, rec);
  S.seq++;
  await chrome.storage.local.set({ [REC + String(r.seq).padStart(8, '0')]: r });
  await saveState();
  SINK.after(r);
  return r;
}

async function readLog() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith(REC)).sort().map((k) => all[k]);
}

// ============================================================================
// sink — 로그를 누가 소비하나. 여기만 모드별로 다르다.
// ============================================================================
const SINKS = {
  download: {
    after() { /* 쌓아두기만 한다. export 버튼이 소비한다. */ },
  },
  server: {
    after() {
      // TODO(서버 단계): 1초 또는 32~64KB 마다 묶어서 전송 → ACK 받은 seq 삭제.
      // 오프라인이면 로그에 남아 있다가 다음에 보낸다. 로그 형식은 그대로 쓴다.
      throw new Error('server sink 미구현');
    },
  },
};
const SINK = SINKS[MODE];

function visit(tabId, reason) {
  if (!S.recording) return null;
  const pageId = tabId != null ? (S.tabPage[tabId] || null) : null;   // null = 수집 안 되는 곳
  const segId = tabId != null ? (S.tabSeg[tabId] || null) : null;
  const key = segId + '|' + pageId + '|' + tabId;
  if (S.lastVisit === key) return null;
  S.lastVisit = key;
  return put({ k: 'visit', t: tNow(), pageId, segId, tabId, reason });
}

// ============================================================================
// assemble — 로그 → bundle. 순수 함수 (storage 를 안 만진다).
//   서버 쪽에서 같은 bundle 을 만들려면 이 함수만 옮기면 된다.
// ============================================================================
function assemble(log) {
  let startRec = null, stopRec = null, query = null;
  const visits = [];
  const pages = {};          // pageId → { meta, paras: Map, events: [], segs: Map }
  const segChunks = {};      // segId → { pageId, ns: Set, dup: 수 }

  // 1회차: 세션 · 방문 · 페이지. 로그 안의 도착 순서와 무관하게 페이지가 먼저 모인다.
  //   (첫 틱에 page 와 첫 chunk 가 거의 동시에 나가므로, chunk 가 먼저 저장될 수 있다)
  for (const r of log) {
    if (r.k === 'start') { startRec = r; query = r.query || null; }
    else if (r.k === 'stop') stopRec = r;
    else if (r.k === 'query') query = r.q || null;
    else if (r.k === 'visit') {
      visits.push({ t: r.t, pageId: r.pageId, segId: r.segId, tabId: r.tabId, reason: r.reason });
    } else if (r.k === 'page') {
      const pg = pages[r.pageId] ||
        (pages[r.pageId] = { meta: r.meta, paras: new Map(), events: [], segs: new Map() });
      for (const p of r.paragraphs || []) if (!pg.paras.has(p.pid)) pg.paras.set(p.pid, p);
      // 같은 구간의 page record 는 여러 번 온다(유닛 append). 첫 번째가 구간 시작이다.
      if (!pg.segs.has(r.segId)) {
        pg.segs.set(r.segId, { segId: r.segId, tabId: r.tabId, t: r.t, url: r.meta && r.meta.url });
      }
    }
  }

  // 2회차: 조각. (segId, n) 이 같은 조각은 처음 것만 쓴다 — 재전송 대비.
  //   중복은 로그(원본)에 그대로 남고, 여기서만 걸러진다.
  for (const r of log) {
    if (r.k !== 'chunk') continue;
    const sc = segChunks[r.segId] || (segChunks[r.segId] = { pageId: r.pageId, ns: new Set(), dup: 0 });
    if (r.n != null) {
      if (sc.ns.has(r.n)) { sc.dup++; continue; }
      sc.ns.add(r.n);
    }
    const pg = pages[r.pageId];
    if (!pg) continue;                         // page record 가 끝내 없는 조각 — chunkReport 에 남는다
    for (const e of r.events) {
      pg.events.push(Object.assign({}, e, { segId: e.segId || r.segId, tabId: r.tabId }));
    }
  }

  const startedAt = startRec ? new Date(startRec.ts).toISOString() : null;
  const endedAt = stopRec ? new Date(stopRec.ts).toISOString() : null;
  let total = 0;

  const out = [];
  const droppedPages = [];
  const segEnd = {};         // segId → 'closed' | 'unloaded' | 'open'

  for (const [pageId, pg] of Object.entries(pages)) {
    const paragraphs = [...pg.paras.values()].sort((a, b) => a.order - b.order);
    const timeline = pg.events.slice().sort((a, b) => a.t - b.t);   // 안정 정렬
    const segments = [...pg.segs.values()];                          // 시작 순서

    // 구간별 끝 상태: segend 가 있으면 정상 종료. 없으면 마지막 틱 뒤에 pagehide 가
    // 있었는지 본다(bfcache 로 되살아나면 pagehide 뒤에 틱이 또 올 수 있다).
    for (const sg of segments) {
      let lastTick = -1, lastHide = -1, closed = false;
      timeline.forEach((e, i) => {
        if (e.segId !== sg.segId) return;
        if (e.type === 'segend') closed = true;
        else if (e.type === 'tick') lastTick = i;
        else if (e.type === 'pagehide') lastHide = i;
      });
      segEnd[sg.segId] = closed ? 'closed' : (lastHide > lastTick ? 'unloaded' : 'open');
    }

    const ticks = timeline.filter((e) => e.type === 'tick').length;
    // 안전망. 5-recorder 는 첫 틱 전에는 아무것도 안 보내므로 정상이면 여기 걸리는 게 없다.
    const why = !paragraphs.length ? 'no-units' : !ticks ? 'no-ticks' : null;
    if (why) {
      droppedPages.push({
        pageId, reason: why,
        segments: segments.map((g) => ({ segId: g.segId, tabId: g.tabId, url: g.url })),
      });
      continue;
    }

    total += ticks * TICK_MS;
    out.push({
      meta: Object.assign({}, pg.meta, {
        sessionId: startRec ? startRec.sessionId : null,
        startedAt, endedAt,
        focusMs: ticks * TICK_MS,
        pageId,
        segments,                                // 각 구간의 탭 · 시작 시각 · URL
        paragraphs,
      }),
      timeline,
    });
  }

  // 조각 유실 보고. 판정은 여기(export 시점)에서만 한다 — 늦게 오는 조각이 있으므로
  // 도착할 때마다 판단하면 오탐이 난다.
  //   missing  : 0..maxN 중 빠진 번호 → 확실한 유실
  //   end      : closed(segend) / unloaded(pagehide) / open(열려 있거나 꼬리 유실 가능)
  //   orphan   : page record 가 없는 구간의 조각 (조립 불가)
  const chunkReport = Object.entries(segChunks).map(([segId, sc]) => {
    const maxN = sc.ns.size ? Math.max(...sc.ns) : -1;
    const missing = [];
    for (let i = 0; i <= maxN; i++) if (!sc.ns.has(i)) missing.push(i);
    return {
      segId, pageId: sc.pageId, maxN, missing, duplicates: sc.dup,
      end: segEnd[segId] || 'open',
      orphan: !pages[sc.pageId],
    };
  });

  return {
    kind: 'rbc-session',
    bundleVersion: 1,
    session: {
      sessionId: startRec ? startRec.sessionId : null,
      startedAt, endedAt,
      stopReason: stopRec ? stopRec.reason : null,
      focusMs: total,
      searchQuery: query,
      tickMs: TICK_MS,
      records: log.length,
      visits,
      chunkReport,
      droppedPages,
    },
    pages: out,
  };
}

// ============================================================================
// 탭 방송 — 각 탭의 최상위 프레임에만. 거기서 6-frames 가 primary 로 보낸다.
// ============================================================================
async function broadcast(msg) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) =>
    chrome.tabs.sendMessage(t.id, msg, { frameId: 0 }).catch(() => {})
    // content script 가 없는 탭(chrome://, 웹스토어 등)은 조용히 실패한다
  ));
}

function sessionMsg() {
  return {
    rbc: S.recording ? 'start' : 'stop',
    sessionId: S.sessionId, epoch: S.epoch, query: S.query,
  };
}

// ============================================================================
// 명령 처리
// ============================================================================
const handlers = {
  // 새로 뜬 content script 가 "지금 세션 중이냐"를 묻는다. 재주입·새 탭 복구 경로.
  // 출석 신호일 뿐이다: 메시지에 페이지 데이터가 없고, sender(탭 URL 등)도 읽지 않으며
  // 아무것도 저장하지 않는다. 탭의 URL·원문은 첫 틱 뒤의 page 기록으로만 들어온다.
  async hello() { return sessionMsg(); },

  async start(m) {
    if (S.recording) return sessionMsg();
    // download 모드: 직전 세션 로그는 여기서 버린다. export 는 그 전에 할 것.
    // (server 모드에서는 ACK 안 된 로그를 지우면 안 된다 — 서버 단계에서 바꿀 것)
    const old = (await chrome.storage.local.get(null));
    const keys = Object.keys(old).filter((k) => k.startsWith(REC));
    if (keys.length) await chrome.storage.local.remove(keys);

    S = emptyState();
    S.sessionId = crypto.randomUUID();
    S.epoch = Date.now();
    S.recording = true;
    S.query = (m && m.query) || null;
    await put({ k: 'start', t: 0, query: S.query, mode: MODE });
    await broadcast(sessionMsg());
    return sessionMsg();
  },

  async stop(m) {
    if (!S.recording) return sessionMsg();
    await put({ k: 'stop', t: tNow(), reason: (m && m.reason) || 'user' });
    S.recording = false;
    await saveState();
    await broadcast(sessionMsg());
    return sessionMsg();
  },

  async query(m) {
    S.query = (m && m.q) || null;
    if (S.recording) await put({ k: 'query', t: tNow(), q: S.query });
    else await saveState();
    return { ok: true };
  },

  // 한 탭이 어떤 글의 기록 구간을 시작했다.
  async page(m, sender) {
    if (m.sessionId !== S.sessionId) return { ok: false, why: 'stale-session' };
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId != null) { S.tabPage[tabId] = m.pageId; S.tabSeg[tabId] = m.segId; }
    await put({
      k: 'page', t: tNow(), pageId: m.pageId, segId: m.segId, tabId,
      meta: m.meta, paragraphs: m.paragraphs || [],
    });
    await visit(tabId, 'enter');
    return { ok: true };
  },

  // timeline 조각. 세션이 멈춘 뒤에 도착해도 받는다 — 정지 직전 조각이 늦게 온다.
  async flush(m, sender) {
    if (m.sessionId !== S.sessionId) return { ok: false, why: 'stale-session' };
    if (!m.events || !m.events.length) return { ok: true };
    const tabId = sender.tab ? sender.tab.id : null;
    await put({ k: 'chunk', pageId: m.pageId, segId: m.segId, n: m.n, tabId, events: m.events });
    return { ok: true };
  },

  async export() {
    if (MODE !== 'download') return { ok: false, why: 'not-download-mode' };
    return assemble(await readLog());
  },
};

async function handle(m, sender) {
  const fn = handlers[m && m.rbc];
  if (!fn) return { ok: false, why: 'unknown-command' };
  return serial(() => fn(m, sender || {}));
}

// ============================================================================
// 리스너 — 최상위에서 동기 등록
// ============================================================================
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || !m.rbc) return false;
  handle(m, sender).then(reply, (e) => reply({ ok: false, why: String(e) }));
  return true;                                    // 비동기 응답
});

// 방문 순서: 탭 전환. null = 수집 안 되는 페이지로 감
chrome.tabs.onActivated.addListener(({ tabId }) => serial(() => visit(tabId, 'tab')));

// 방문 순서: 창 전환 (다른 앱으로 가면 windowId = NONE)
chrome.windows.onFocusChanged.addListener((windowId) => serial(async () => {
  if (!S.recording) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) return visit(null, 'window-blur');
  const [t] = await chrome.tabs.query({ active: true, windowId });
  if (t) return visit(t.id, 'window');
}));

chrome.tabs.onRemoved.addListener((tabId) => serial(async () => {
  if (S.tabPage[tabId] === undefined) return;
  delete S.tabPage[tabId];
  delete S.tabSeg[tabId];
  await saveState();
}));

// 콘솔 점검용: 서비스 워커 콘솔에서 await RBCBG.handle({ rbc: 'start' })
self.RBCBG = { handle, state: () => S, readLog, assemble };