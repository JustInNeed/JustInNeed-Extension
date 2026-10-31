/* =============================================================================
 * bg-core.js — 세션 소유자 · 기록 로그 · sink (service worker 의 엔진 부분)
 *
 * 소유: 세션(sessionId, epoch, recording, 검색어), 탭 → 페이지 대응표,
 *       기록 로그(rec:*)
 * 저장: chrome.storage.local
 *
 * --- 엔진과 버전 파일 (#19) ----------------------------------------------------
 *   service worker 는 버전 폴더의 background.js 하나다. 그 파일이 importScripts 로
 *   이 엔진(bg-core.js)과 버전 파일(data-collect/bg-collect.js 등)을 차례로 올린다.
 *   classic script 라 최상위 이름(S · put · handlers ...)을 서로 같이 본다.
 *   버전마다 다른 것은 VERSION 자리(mode · 시작 허락 · tester · 정지 뒤 · status 덧붙임)와
 *   handlers 에 더하는 명령뿐이다. 엔진은 버전 파일을 모른다 — VERSION 만 부른다.
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
 *                          server   모드: 묶어서 전송, ACK 받으면 삭제 (미구현 — 지금은 쌓기만)
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
 * --- 무동작 시계 (#26) -------------------------------------------------------
 *   세션을 끝내는 규칙이라 세션 주인인 여기가 시계를 갖는다. 탭은 숨거나 크롬 밖에 있으면
 *   틱이 멈춰서 그 시간을 셀 수 없다.
 *     크롬 안 : 마지막 움직임에서 IDLE_IN_MS 를 넘기면 자동 정지
 *     크롬 밖 : 창 포커스가 없어진 때부터 IDLE_OUT_MS 를 넘기면 자동 정지. 그 안에 돌아오면 이어짐
 *   움직임 = 탭의 입력(activity 명령, 기록 안 하는 탭 · iframe 포함) · 탭 전환 · 크롬으로 돌아옴.
 *   확장이 못 들어가는 탭(새 탭 · 크롬 설정 · 웹스토어)에 가만히 있는 것 · 손대지 않고 영상만 보는 것은 움직임이 아니다
 *   — 자리를 비운 시간(화장실 등)을 걸러내려고 (10-31 서현).
 *   service worker 는 쉬면 꺼지므로 시각은 S 에 저장하고, 알람으로 30초마다 깨어 본다.
 *   움직임이 오면 시계를 고치기 전에 먼저 넘겼는지 본다 — 알람 사이에 돌아와도 넘긴 시간은 잡힌다.
 *
 * --- service worker 라서 지키는 것 --------------------------------------------
 *   1) 유휴 30초면 종료된다. 메모리 상태는 캐시, 원본은 storage.
 *   2) 리스너는 최상위에서 동기적으로 등록해야 깨어날 때 이벤트를 받는다.
 *   3) 동시에 온 메시지가 읽기-수정-쓰기를 꼬지 않도록 전부 serial() 로 줄 세운다.
 * ========================================================================== */
'use strict';

const TICK_MS = 150;          // 0-core CFG.TICK_MS 와 같아야 한다
const K_SESS = 'sess:cur';    // 세션 상태 (작은 것만)
const REC = 'rec:';           // 기록 로그. 키 = 'rec:' + seq 8자리
const IDLE_IN_MS = 10 * 60 * 1000;    // 크롬 안 무동작 → 자동 정지. 0-core CFG.IDLE_TIMEOUT_MS 와 같아야 한다
const IDLE_OUT_MS = 30 * 60 * 1000;   // 크롬 밖(창 포커스 없음) → 자동 정지
const IDLE_ALARM = 'rbc-idle';        // 무동작 검사 알람 (30초마다, 기록 중에만)
const IDLE_TEST = { in: 20 * 1000, out: 40 * 1000 };   // 패널 "빠른 시험" 때의 값. 기록을 시작할 때마다 꺼진다

// ============================================================================
// 버전 자리 — 버전 파일이 Object.assign(VERSION, {...}) 로 채운다
// ============================================================================
const VERSION = {
  mode: null,                       // 'download' | 'server' — start 기록의 mode, sink 선택. 안 채우면 put 이 오류
  ready: Promise.resolve(),         // 버전 파일이 storage 에서 읽을 것이 있으면 그 약속
  async gate() { return null; },    // 기록 시작 거절 사유(why) 또는 null
  tester() { return null; },        // start 기록의 tester
  onStop() {},                      // 정지 뒤 할 일 (reason 을 받는다)
  status() { return {}; },          // status 응답에 덧붙일 것
};

// ============================================================================
// 세션 상태
// ============================================================================
function emptyState() {
  return {
    sessionId: null,
    epoch: 0,
    recording: false,
    query: null,
    scenario: null,       // 읽는 목적 (테스트 모드, 기록 시작 전 팝업에서)
    seq: 0,              // 기록 로그 번호. 도착 순서 = 저장 순서
    tabPage: {},         // tabId → pageId (지금 그 탭이 보여주는 글)
    tabSeg: {},          // tabId → segId  (지금 그 탭에서 열린 구간)
    lastVisit: null,     // 같은 곳 연속 기록 방지용
    pagePids: {},        // pageId → [pid] (팝업 진행 표시용. 기록 데이터 아님)
    lastActAt: 0,        // 무동작 시계: 마지막 움직임 시각 (기록 데이터 아님)
    awaySince: null,     // 크롬을 떠난 시각. null = 크롬 안
    lastAwayMs: null,    // 지난번 크롬 밖에 있던 시간 (패널 표시용)
    lastActSrc: null,    // 마지막 움직임이 어디서 왔나 (패널 표시용): input · tab · window · start · test
    idleErr: null,       // 무동작 시계 쪽 마지막 실패 원문 (패널 표시용)
    idleTest: false,     // 패널 "빠른 시험" (디버그). 새 세션은 언제나 꺼진 채 시작
  };
}

let S = emptyState();
const ready = chrome.storage.local.get(K_SESS).then((r) => {
  if (r[K_SESS]) S = Object.assign(emptyState(), r[K_SESS]);   // 필드가 늘어난 뒤의 옛 상태 대비
});

let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(() => ready).then(() => VERSION.ready).then(fn);
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
  SINKS[VERSION.mode].after(r);
  return r;
}

async function removeLog() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(REC));
  if (keys.length) await chrome.storage.local.remove(keys);
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
      // 지금(#19 실사용 껍데기)은 전송 없이 쌓기만 한다 — 실사용 팝업이 "서버 전송 없음"을 띄운다.
    },
  },
};

function cleanField(v, max) {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return t.slice(0, max);
}

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
// 무동작 시계 (#26, 헤더 참고)
// ============================================================================
function idleInfo() {
  return { lastActAt: S.lastActAt, awaySince: S.awaySince, lastAwayMs: S.lastAwayMs,
    src: S.lastActSrc, err: S.idleErr,
    inMs: S.idleTest ? IDLE_TEST.in : IDLE_IN_MS, outMs: S.idleTest ? IDLE_TEST.out : IDLE_OUT_MS,
    test: !!S.idleTest };
}

// 시간을 넘겼나. 시계를 고치기 전에 본다 — 알람 사이에 돌아와도 넘긴 시간은 잡힌다.
function idleOver(now) {
  if (!S.recording) return false;
  const c = idleInfo();
  if (S.awaySince != null) return now - S.awaySince > c.outMs;
  return now - S.lastActAt > c.inMs;
}

// 자동 정지 = 정지 버튼과 같은 동작. 크롬 안 · 밖 모두 이유는 'idle'(기록 형식의 기존 값, 새 값을 만들지 않는다).
function idleStop() {
  return handlers.stop({ reason: 'idle' });
}

// 움직임이 있었다. 크롬 밖에 있었으면 돌아온 것이다. src = 어디서 왔나(패널 표시용).
async function moved(now, src) {
  if (!S.recording) return;
  if (idleOver(now)) return idleStop();
  if (S.awaySince != null) { S.lastAwayMs = now - S.awaySince; S.awaySince = null; }
  S.lastActAt = now;
  S.lastActSrc = src || null;
  await saveState();
}

// 무동작 시계 쪽 실패는 삼키지 않는다 — 콘솔과 패널(idleInfo.err)에 원문 (#26).
//   리스너는 serial 의 약속을 받지 않으므로 여기서 받아 둔다. 안 받으면 자동 정지가 조용히 안 일어난다.
function idleFail(where) {
  return (e) => {
    const m = where + ': ' + ((e && e.message) || String(e));
    console.warn('[RBC] 무동작 시계 실패', m);
    S.idleErr = m;
  };
}

// 크롬을 떠났다 (다른 앱으로 · 모든 창이 포커스를 잃음).
async function wentAway(now) {
  if (!S.recording || S.awaySince != null) return;
  if (idleOver(now)) return idleStop();
  S.awaySince = now;
  await saveState();
}

// 알람마다: 크롬 안팎을 다시 확인한다. 포커스 이벤트를 놓쳤어도(서비스 워커가 꺼져 있었음) 여기서 맞춰진다.
async function idleCheck() {
  if (!S.recording) { await chrome.alarms.clear(IDLE_ALARM); return; }
  const now = Date.now();
  const w = await chrome.windows.getLastFocused();          // 실패하면 판정하지 않고 idleFail 로 (크롬 밖으로 치지 않는다)
  if (!w || !w.focused) await wentAway(now);
  else if (S.awaySince != null) return moved(now, 'window'); // 돌아왔는데 이벤트를 놓쳤다
  S.idleErr = null;
  if (idleOver(now)) return idleStop();
}

function idleAlarmOn() {
  // create 는 이미 있는 알람의 주기를 처음부터 다시 잰다 — 깨어날 때마다 부르면 알람이 영영 안 울릴 수 있어서 없을 때만
  return chrome.alarms.get(IDLE_ALARM).then((a) => {
    if (!a) return chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 0.5 });
  });
}

// ============================================================================
// assemble — 로그 → bundle. 순수 함수 (storage 를 안 만진다).
//   서버 쪽에서 같은 bundle 을 만들려면 이 함수만 옮기면 된다.
// ============================================================================
function assemble(log) {
  let startRec = null, stopRec = null, query = null;
  // tester 는 start 기록에서만 온다. 동의 게이트 이전 로그면 null
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
      // 나중 것이 이긴다: 기록 중 splice 로 order 가 바뀌고 사라진 유닛이 retired:true 로 바뀐다(2-units 헤더).
      //   목록에서 빠진 pid 는 지우지 않는다 — 옛 틱이 참조한다.
      for (const p of r.paragraphs || []) pg.paras.set(p.pid, p);
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
      tester: (startRec && startRec.tester) || null,
      startedAt, endedAt,
      stopReason: stopRec ? stopRec.reason : null,
      focusMs: total,
      searchQuery: query,
      scenario: (startRec && startRec.scenario) || null,   // 읽는 목적 (테스트 모드)
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

// mode = 이 확장이 어느 버전인지(패널 표시용, #19). 기록 로그에는 안 들어간다.
function sessionMsg() {
  return {
    rbc: S.recording ? 'start' : 'stop',
    sessionId: S.sessionId, epoch: S.epoch, query: S.query, mode: VERSION.mode,
    idle: idleInfo(),                                      // 패널의 무동작 시계 표시용 (#26)
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
    // 시작 허락(데이터 수집 버전 = 동의 게이트). 명령 출처(팝업·패널·웹앱)와 무관하게 여기서만 막는다.
    const why = await VERSION.gate();
    if (why) return { ok: false, why };
    // download 모드: 직전 세션 로그는 여기서 버린다. export 는 그 전에 할 것.
    // (server 모드에서는 ACK 안 된 로그를 지우면 안 된다 — 서버 단계에서 바꿀 것)
    await removeLog();

    S = emptyState();
    S.sessionId = crypto.randomUUID();
    S.epoch = Date.now();
    S.recording = true;
    S.query = (m && m.query) || null;
    S.scenario = cleanField(m && m.scenario, 200) || null;
    S.lastActAt = S.epoch;                                 // 시작 버튼 = 움직임
    S.lastActSrc = 'start';
    await idleAlarmOn();
    await put({ k: 'start', t: 0, query: S.query, scenario: S.scenario, mode: VERSION.mode, tester: VERSION.tester() });
    await broadcast(sessionMsg());
    return sessionMsg();
  },

  async stop(m) {
    if (!S.recording) return sessionMsg();
    const reason = (m && m.reason) || 'user';
    await put({ k: 'stop', t: tNow(), reason });
    S.recording = false;
    await saveState();
    await chrome.alarms.clear(IDLE_ALARM);
    // reason 은 방송에만 싣는다 — idle 이면 기록하던 탭이 autostop 이벤트를 남긴다(#26)
    await broadcast(Object.assign(sessionMsg(), { reason }));
    VERSION.onStop(reason);
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
    // 진행 표시용 유닛 수 = 페이지별 pid 합집합 (assemble 과 같은 규칙)
    const known = new Set(S.pagePids[m.pageId] || []);
    for (const p of m.paragraphs || []) known.add(p.pid);
    S.pagePids[m.pageId] = [...known];
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

  // 탭의 입력이 있었다 (#26). 모든 탭 · 프레임이 보낸다 — 기록 중이 아니면 아무것도 안 한다.
  //   탭 · URL 은 보지 않고 저장하지 않는다. 시각만 고친다.
  async activity() {
    // 크롬 밖으로 잡혀 있는데 입력이 왔다: 맥은 다른 앱을 쓰는 중에 뒤에 보이는 크롬 창 위로 마우스만 지나가도 입력이 온다.
    //   그걸 "돌아옴"으로 치면 크롬 밖 시계가 처음부터 다시 잰다 → 크롬 창이 정말 앞에 있을 때만 돌아온 것으로 본다.
    if (S.recording && S.awaySince != null) {
      const w = await chrome.windows.getLastFocused();
      if (!w || !w.focused) return { ok: true };
    }
    await moved(Date.now(), 'input');
    return { ok: true };
  },

  // 패널의 무동작 시계 표시 (#26). 읽기만 한다.
  async idle() {
    return Object.assign({ ok: true, recording: S.recording }, idleInfo());
  },

  // 패널 "빠른 시험" 켜기 · 끄기 (#26, 디버그). 기록 중에만 — 시작할 때마다 꺼지므로 참가자 기록에 남지 않는다.
  //   켜고 끄는 것도 움직임으로 친다(누른 순간부터 잰다).
  async idletest(m) {
    if (S.recording) {
      S.idleTest = !!(m && m.on);
      S.lastActAt = Date.now();
      S.lastActSrc = 'test';
      await saveState();
    }
    return Object.assign({ ok: true, recording: S.recording }, idleInfo());
  },

  // 내보내기 = 로그 → bundle. 실사용 버전에도 둔다(10-31 서현) — 패널 [내보내기] 가 쓴다.
  async export() {
    return assemble(await readLog());
  },

  // 팝업이 1초마다 묻는다. 로그를 읽지 않는다 (S 와 버전 파일의 상태만).
  async status() {
    const pids = Object.values(S.pagePids);
    return Object.assign({
      ok: true,
      mode: VERSION.mode,
      recording: S.recording,
      sessionId: S.sessionId,
      startedAt: S.epoch || null,
      query: S.query,
      scenario: S.scenario,
      pages: pids.length,
      units: pids.reduce((n, a) => n + a.length, 0),
      records: S.seq,
    }, VERSION.status());
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

// 방문 순서: 탭 전환. null = 수집 안 되는 페이지로 감. 탭 전환은 움직임이다(#26).
chrome.tabs.onActivated.addListener(({ tabId }) => serial(async () => {
  await moved(Date.now(), 'tab');
  return visit(tabId, 'tab');
}).catch(idleFail('탭 전환')));

// 방문 순서: 창 전환 (다른 앱으로 가면 windowId = NONE). 무동작 시계의 크롬 안팎도 여기서(#26).
chrome.windows.onFocusChanged.addListener((windowId) => serial(async () => {
  if (!S.recording) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await wentAway(Date.now());
    return visit(null, 'window-blur');
  }
  await moved(Date.now(), 'window');
  const [t] = await chrome.tabs.query({ active: true, windowId });
  if (t) return visit(t.id, 'window');
}).catch(idleFail('창 전환')));

// 무동작 검사 (#26). 리스너는 최상위 동기 등록 — 알람이 꺼진 서비스 워커를 깨운다.
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === IDLE_ALARM) serial(idleCheck).catch(idleFail('알람 검사'));
});
// 브라우저를 다시 켜면 알람이 없을 수 있다(예상). 기록 중이면 다시 건다.
ready.then(() => { if (S.recording) return idleAlarmOn(); }).catch((e) => console.warn('[RBC] 무동작 알람', e));

chrome.tabs.onRemoved.addListener((tabId) => serial(async () => {
  if (S.tabPage[tabId] === undefined) return;
  delete S.tabPage[tabId];
  delete S.tabSeg[tabId];
  await saveState();
}));

// 콘솔 점검용: 서비스 워커 콘솔에서 await RBCBG.handle({ rbc: 'start' })
self.RBCBG = { handle, state: () => S, readLog, assemble };
