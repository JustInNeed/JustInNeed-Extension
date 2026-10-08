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
 * --- 동의 (테스트 참가자) -----------------------------------------------------
 *   동의가 없으면 start 를 거절한다. 강제는 여기 한 곳뿐이다 — 팝업·패널·나중의
 *   웹앱은 요청만 하고, 거절 사유(why: 'no-consent')를 받아서 보여주기만 한다.
 *   동의 기록은 'consent' 키에 둔다. 'rec:' 로 시작하지 않으므로 새 세션 시작 때
 *   로그를 지워도 남는다. version 이 CONSENT_VERSION 과 다르면 없는 것으로 본다
 *   (고지문을 바꾸면 다시 받는다). 동의 페이지는 자기가 보여준 고지문의 version 을
 *   보내고, 여기서 다르면 거절한다 — 옛 페이지로 새 동의가 들어오는 것을 막는다.
 *   참가자 정보(참여 번호·testId·이름·조건 태그)는 start 기록에 복사된다. 그래서 bundle 의
 *   session.tester 도 assemble() 이 로그만 보고 만든다(순수 함수 유지).
 *   참여 번호(participantNo) = 연구자가 정해 준 사람 식별자 (필수, 공백 정리 · 대문자 · 20자).
 *   testId = 이 설치의 난수 ID. 같은 사람이 재설치 · 철회 뒤 재동의하면 testId 는 바뀌고
 *   참여 번호는 같다 → 분석의 사람 키는 참여 번호.
 *   철회(withdraw) = 정지 + 로그 삭제 + 동의 삭제. 다시 동의하면 새 testId.
 *
 * --- 테스트 모드: 읽는 목적 · 라벨 ---------------------------------------------
 *   읽는 목적(scenario)은 기록 시작 전에 팝업에서 받아 start 기록에 싣는다 → session.scenario.
 *   라벨은 팝업 "다 읽었어요" → label 명령 → 지금 보고 있는 탭으로 전달. 라벨 데이터 자체는
 *   그 탭의 timeline 이벤트(type=label)로 들어온다 — 여기서는 전달만 한다.
 *   라벨 [완료] → 그 탭이 stop(reason 'labeled') 을 보낸다 → 정지 + 1.5초 뒤 내보내기 탭 (한 글 = 한 기록).
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
const K_CONSENT = 'consent';  // 동의 기록. 세션 로그와 따로 산다
const CONSENT_VERSION = 2;    // consent.html 고지문 버전과 같아야 한다 (2 = 참여 번호 추가)

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
  };
}

let S = emptyState();
let C = null;                 // 동의 기록 { version, testId, participantNo, name, tag, at } | null
const ready = chrome.storage.local.get([K_SESS, K_CONSENT]).then((r) => {
  if (r[K_SESS]) S = Object.assign(emptyState(), r[K_SESS]);   // 필드가 늘어난 뒤의 옛 상태 대비
  C = r[K_CONSENT] || null;
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
      throw new Error('server sink 미구현');
    },
  },
};
const SINK = SINKS[MODE];

// ============================================================================
// 동의
// ============================================================================
function consentValid() { return !!(C && C.version === CONSENT_VERSION && C.testId && C.participantNo); }

// 헷갈리는 글자(0/O, 1/I/L)를 뺀 32자. 6자리 ≈ 10억 가지라 참가자 수십 명이면 충돌 걱정 없음
const ID_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newTestId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return 't-' + [...b].map((x) => ID_CHARS[x % ID_CHARS.length]).join('');
}

function testerInfo() {
  return { participantNo: C.participantNo, testId: C.testId, name: C.name, tag: C.tag,
           consentVersion: C.version, consentAt: C.at };
}

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
    // 동의 게이트. 명령 출처(팝업·패널·웹앱)와 무관하게 여기서만 막는다.
    if (!consentValid()) return { ok: false, why: 'no-consent' };
    // download 모드: 직전 세션 로그는 여기서 버린다. export 는 그 전에 할 것.
    // (server 모드에서는 ACK 안 된 로그를 지우면 안 된다 — 서버 단계에서 바꿀 것)
    await removeLog();

    S = emptyState();
    S.sessionId = crypto.randomUUID();
    S.epoch = Date.now();
    S.recording = true;
    S.query = (m && m.query) || null;
    S.scenario = cleanField(m && m.scenario, 200) || null;
    await put({ k: 'start', t: 0, query: S.query, scenario: S.scenario, mode: MODE, tester: testerInfo() });
    await broadcast(sessionMsg());
    return sessionMsg();
  },

  async stop(m) {
    if (!S.recording) return sessionMsg();
    const reason = (m && m.reason) || 'user';
    await put({ k: 'stop', t: tNow(), reason });
    S.recording = false;
    await saveState();
    await broadcast(sessionMsg());
    // 테스트 모드: 라벨 [완료]로 끝났으면 바로 파일로 저장한다. 다음 "기록 시작"이 로그를 지우므로
    //   내보내기를 잊으면 데이터가 사라진다. 1.5초 = 정지 방송 뒤 마지막 조각(segend)이 도착할 시간.
    if (reason === 'labeled') {
      setTimeout(() => chrome.tabs.create({ url: chrome.runtime.getURL('consent.html#export') }), 1500);
    }
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

  // 팝업 "다 읽었어요": 지금 보고 있는 탭에 라벨 모드를 켠다 (11-session → primary 의 12-label).
  //   탭이 기록 중인지는 그 탭이 판단한다(아니면 안내 문구). 여기서는 세션만 본다.
  async label() {
    if (!S.recording) return { ok: false, why: 'not-recording' };
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!t) return { ok: false, why: 'no-tab' };
    try {
      await chrome.tabs.sendMessage(t.id, { rbc: 'label' }, { frameId: 0 });
    } catch (e) {
      return { ok: false, why: 'no-content' };      // content script 없음(새로고침 전 · chrome:// 등)
    }
    return { ok: true };
  },

  async export() {
    if (MODE !== 'download') return { ok: false, why: 'not-download-mode' };
    return assemble(await readLog());
  },

  // 팝업이 1초마다 묻는다. 로그를 읽지 않는다 (S 와 C 만).
  async status() {
    const pids = Object.values(S.pagePids);
    return {
      ok: true,
      consent: C ? Object.assign({ valid: consentValid() }, C) : null,
      consentVersion: CONSENT_VERSION,
      recording: S.recording,
      sessionId: S.sessionId,
      startedAt: S.epoch || null,
      query: S.query,
      scenario: S.scenario,
      pages: pids.length,
      units: pids.reduce((n, a) => n + a.length, 0),
      records: S.seq,
    };
  },

  // 동의 페이지가 보낸다. version = 그 페이지가 보여준 고지문 버전.
  //   재동의(고지문 버전 변경)는 testId 를 유지한다. 철회 뒤 동의는 새 testId.
  async consent(m) {
    if (!m || m.version !== CONSENT_VERSION) return { ok: false, why: 'consent-version' };
    const participantNo = cleanField(m.participantNo, 20).toUpperCase();   // p01 과 P01 이 갈리지 않게
    if (!participantNo) return { ok: false, why: 'no-participant' };
    const name = cleanField(m.name, 40);
    if (!name) return { ok: false, why: 'no-name' };
    C = {
      version: CONSENT_VERSION,
      testId: (C && C.testId) || newTestId(),
      participantNo,
      name,
      tag: cleanField(m.tag, 40) || null,
      at: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [K_CONSENT]: C });
    return { ok: true, consent: Object.assign({ valid: true }, C) };
  },

  // 철회: 기록 중이면 정지 방송 → 로그 · 세션 상태 · 동의 전부 삭제.
  //   정지 직후 늦게 오는 조각은 sessionId 가 null 이 됐으므로 stale-session 으로 거절된다.
  async withdraw() {
    if (S.recording) {
      S.recording = false;
      await broadcast(sessionMsg());
    }
    await removeLog();
    S = emptyState();
    await saveState();
    C = null;
    await chrome.storage.local.remove(K_CONSENT);
    return { ok: true };
  },

  // 기록 삭제 (동의는 유지). 기록 중에는 거절 — 정지 먼저.
  async clear() {
    if (S.recording) return { ok: false, why: 'recording' };
    await removeLog();
    S = emptyState();
    await saveState();
    return { ok: true };
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

// 새로 설치하면 동의 페이지를 연다. 업데이트·확장 새로고침(reason 'update')에서는 안 연다.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('consent.html') });
});

// 콘솔 점검용: 서비스 워커 콘솔에서 await RBCBG.handle({ rbc: 'start' })
self.RBCBG = { handle, state: () => S, consent: () => C, readLog, assemble };