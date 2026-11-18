/* =============================================================================
 * bg-collect.js — 데이터 수집(테스트) 버전의 background 부분
 *
 * 엔진(recorder-core/bg-core.js) 뒤에 올라간다(background.js 의 importScripts 순서).
 * 엔진의 VERSION 자리를 채우고, 테스트 전용 명령(동의 · 철회 · 기록 삭제 · 라벨)을 handlers 에 더한다.
 * 소유: 동의 기록 C ('consent' 키)
 *
 * --- 동의 (테스트 참가자) -----------------------------------------------------
 *   동의가 없으면 start 를 거절한다. 강제는 여기 한 곳뿐이다 — 팝업·패널·나중의
 *   웹앱은 요청만 하고, 거절 사유(why: 'no-consent')를 받아서 보여주기만 한다.
 *   동의 기록은 'consent' 키에 둔다. 'rec:' 로 시작하지 않으므로 새 세션 시작 때
 *   로그를 지워도 남는다. version 이 CONSENT_VERSION 과 다르면 없는 것으로 본다
 *   (고지문을 바꾸면 다시 받는다). 동의 페이지는 자기가 보여준 고지문의 version 을
 *   보내고, 여기서 다르면 거절한다 — 옛 페이지로 새 동의가 들어오는 것을 막는다.
 *   참가자 정보(참여 번호·testId·이름)는 start 기록에 복사된다. 그래서 bundle 의
 *   session.tester 도 assemble() 이 로그만 보고 만든다(순수 함수 유지).
 *   참여 번호(participantNo) = 연구자가 정해 준 사람 식별자 (필수, 공백 정리 · 대문자 · 20자).
 *   testId = 이 설치의 난수 ID. 같은 사람이 재설치 · 철회 뒤 재동의하면 testId 는 바뀌고
 *   참여 번호는 같다 → 분석의 사람 키는 참여 번호.
 *   철회(withdraw) = 정지 + 로그 삭제 + 동의 삭제. 다시 동의하면 새 testId.
 *
 * --- 테스트 모드: 읽는 목적 · 라벨 ---------------------------------------------
 *   읽는 목적(scenario)은 기록 시작 전에 팝업에서 받아 start 기록에 싣는다 → session.scenario.
 *   라벨은 팝업 [평가 시작] → label 명령 → 모든 탭으로 전달(#83 — 기록 중인 탭마다 그 글의 평가가 켜진다). 라벨 데이터 자체는
 *   그 탭의 timeline 이벤트(type=label)로 들어온다 — 여기서는 전달만 한다.
 *   글마다 [이 글 평가 끝]은 정지하지 않는다(label:done keep, #83). 마지막 정지 → 내보내기는 청크 6 에서.
 *   (옛 경로: 라벨 [완료] → stop(reason 'labeled') → 정지 + 1.5초 뒤 내보내기 탭 — 코드는 남아 있다)
 *
 * --- 테스트 번호 (#83, 옛 #24 의 링크 번호 자리) --------------------------------------
 *   조건 태그(Q1 · Q2)는 없다 — 질문을 통일했다(11-17 서현). tester.tag 는 키만 남기고 늘 null(형식 그대로).
 *   테스트 번호 = 이번에 푸는 테스트 세트 번호 'test000' ~ 'test199'. 팝업이 start 에 linkNo 로 싣는다(이름은 옛 것 그대로).
 *   없으면 시작 거절.
 *   정답 / 오답 = 평가의 설문 앞 팝업에서 참가자가 고른 값(O · X). 평가 [완료]의 stop(reason 'labeled')에 answer 로 온다.
 *   둘 다 기록 로그 · JSON 에는 넣지 않는다(형식 그대로, 10-31 서현). 'link' 키에 { linkNo, sessionId, answer } 로 두고,
 *   내보내기 페이지가 파일 이름에만 쓴다. sessionId 로 이번 기록의 값인지 맞춘다.
 *
 * --- 평가 목록 (#83) ------------------------------------------------------------------
 *   'eval' 키 = { sessionId, on, pages: [{ pageId, url, title }], done: { pageId: true } }. 로그 밖 — JSON 에 안 들어간다.
 *   pages = 이번 기록에 잡힌 글(page 기록이 온 순서 = 글 1, 2, 3…). 기록 안 하는 사이트는 page 를 안 보내므로 안 들어간다.
 *   done = 그 글의 취소 아닌 label 이벤트가 flush 로 들어왔다. 판정을 따로 두지 않고 기록 그 자체를 본다.
 *   on = [평가 시작]을 눌렀다. 기록 시작 때 새로 만들고, 정지 때 끈다.
 *   목록(evallist)은 글을 보여 주는 탭(S.tabPage)마다 보낸다 — 평가 시작 · 글 하나 끝 · 탭 닫힘 · 탭 전환 때.
 *     탭마다 here(이 탭의 글)를 달리 싣는다. 탭이 없는 글 = 닫힘(다시 열기는 청크 5).
 *   탭 전환 때는 label 명령도 다시 보낸다 — 절전 탭이 [평가 시작]을 놓쳤어도 보는 순간 평가가 켜진다.
 *   evalgo{pageId} = 평가 바의 목록에서 글을 눌렀다 → 그 글의 탭 · 창을 앞으로. 탭이 없으면(닫힘) 그 주소를 새 탭으로 연다(청크 5).
 *   평가 중 합류(청크 5): 평가 중에 hello 를 보낸 탭(새로 연 탭 · 새로고침 · 다시 연 글 · 탭 안 이동)에 label 명령 · 목록을 보낸다.
 *     그 탭의 12-label 이 목록에 있는 글이면 평가로, 없는 글이면 "평가 대상 아님"으로 들어간다 — 어느 쪽이든 틱이 없다.
 *   diff[pageId] = 평가 중에 온 page 기록에서, 그 전까지 이 글에 없던 평정 대상 문단(pid) 수(전부 noise 유닛은 안 셈). 다시 연 글의 내용이 바뀐 경우를 바에 알린다.
 *   보내기는 기다리지 않는다(serial 안의 handler 에서 탭 응답을 기다리면 다음 기록이 밀린다).
 *
 * --- 내보냄 기억 (#40, 11-05 서현) ------------------------------------------------
 *   export 가 성공하면 { sessionId, seq } 를 'exported' 키에 둔다. status.exported = 이 세션을 내보낸 뒤로 기록이 늘지 않음.
 *   팝업은 exported 면 "새로 시작하면 지워집니다" 경고 · 두 번 누르기를 하지 않는다(이미 파일로 나갔으므로).
 *   파일이 실제로 저장됐는지는 모른다(a.download) — 저장 창에서 취소해도 내보낸 것으로 친다(예상: 크롬 기본은 창 없이 저장).
 * ========================================================================== */
/* global VERSION, handlers, S:writable, emptyState, saveState, removeLog, broadcast, sessionMsg, cleanField, skipClearAll, serial */
'use strict';

const K_CONSENT = 'consent';  // 동의 기록. 세션 로그와 따로 산다
const CONSENT_VERSION = 4;    // consent.html 고지문 버전과 같아야 한다 (2 = 참여 번호 추가, 3 = 연구 담당 연락처 · 철회 요청 방법, 4 = 조건 태그 뺌 #83)

const K_LINK = 'link';        // 이번 기록의 { linkNo, sessionId, answer }. 로그 밖 — JSON 에 안 들어간다
const LINK_MAX = 199;         // 테스트 번호 test000 ~ test<LINK_MAX> (popup.js 의 목록과 같아야 한다)
const ANSWERS = ['O', 'X'];   // 정답 · 오답 (12-label 팝업)
const K_EVAL = 'eval';        // 평가 목록 (#83, 맨 위 주석)

let C = null;                 // 동의 기록 { version, testId, participantNo, name, at } | null
let L = null;                 // { linkNo, sessionId, answer } | null
let EV = null;                // 평가 목록 { sessionId, on, pages, done, diff } | null (#83)
const K_EXPORTED = 'exported'; // 마지막으로 내보낸 { sessionId, seq } (#40). 로그 밖 — JSON 에 안 들어간다
let E = null;

// ============================================================================
// 동의
// ============================================================================
function consentValid() {
  return !!(C && C.version === CONSENT_VERSION && C.testId && C.participantNo);
}

// 'test003' 처럼 test + 세 자리 숫자이고 000 ~ LINK_MAX 안이면 그대로, 아니면 null
function cleanLink(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^test\d{3}$/.test(s)) return null;
  return Number(s.slice(4)) <= LINK_MAX ? s : null;
}

// 헷갈리는 글자(0/O, 1/I/L)를 뺀 32자. 6자리 ≈ 10억 가지라 참가자 수십 명이면 충돌 걱정 없음
const ID_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newTestId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return 't-' + [...b].map((x) => ID_CHARS[x % ID_CHARS.length]).join('');
}

function testerInfo() {
  return { participantNo: C.participantNo, testId: C.testId, name: C.name, tag: null,   // 조건 태그 없음(#83), 키는 형식대로
           consentVersion: C.version, consentAt: C.at };
}

Object.assign(VERSION, {
  mode: 'download',
  ready: chrome.storage.local.get([K_CONSENT, K_LINK, K_EXPORTED, K_EVAL]).then((r) => {
    C = r[K_CONSENT] || null;
    L = r[K_LINK] || null;
    EV = r[K_EVAL] || null;
    E = r[K_EXPORTED] || null;
  }),
  async gate() { return consentValid() ? null : 'no-consent'; },
  tester: testerInfo,
  onStop(reason) {
    // 테스트 모드: 라벨 [완료]로 끝났으면 바로 파일로 저장한다. 다음 "기록 시작"이 로그를 지우므로
    //   내보내기를 잊으면 데이터가 사라진다. 1.5초 = 정지 방송 뒤 마지막 조각(segend)이 도착할 시간.
    if (reason === 'labeled') {
      setTimeout(() => chrome.tabs.create({ url: chrome.runtime.getURL('consent.html#export') }), 1500);
    }
  },
  status() {
    return {
      consent: C ? Object.assign({ valid: consentValid() }, C) : null,
      consentVersion: CONSENT_VERSION,
      // 이번 세션의 테스트 번호 · 정답 여부. 다른 세션의 것이면 null (파일 이름에 엉뚱한 값이 붙지 않게)
      linkNo: L && L.sessionId === S.sessionId ? L.linkNo : null,
      answer: L && L.sessionId === S.sessionId ? (L.answer || null) : null,
      // 이 세션을 내보낸 뒤로 기록이 늘지 않았음 → 새로 시작해도 잃는 것이 없다 (#40)
      exported: !!(E && S.sessionId && E.sessionId === S.sessionId && E.seq === S.seq),
    };
  },
});

// 내보내기가 성공하면 어디까지 내보냈는지 기억한다 (#40). 내보내기 자체는 엔진 그대로.
const coreExport = handlers.export;
handlers.export = async (m, sender) => {
  const r = await coreExport(m, sender);
  const e = { sessionId: S.sessionId, seq: S.seq };
  await chrome.storage.local.set({ [K_EXPORTED]: e });
  E = e;                                                  // 저장이 성공한 뒤에만 — 실패하면 내보내기도 실패로 끝나 파일이 안 생긴다
  return r;
};

// 기록 시작에 테스트 번호를 요구한다. 엔진 start 는 그대로 부르고, 시작에 성공하면 번호를 'link' 키에 둔다.
//   동의가 없으면 엔진 gate 의 'no-consent' 가 먼저 나오도록 동의부터 본다.
const coreStart = handlers.start;
handlers.start = async (m, sender) => {
  if (S.recording || !consentValid()) return coreStart(m, sender);
  const linkNo = cleanLink(m && m.linkNo);
  if (!linkNo) return { ok: false, why: 'no-link' };
  const r = await coreStart(m, sender);
  if (r && r.rbc === 'start') {
    L = { linkNo, sessionId: S.sessionId };
    EV = { sessionId: S.sessionId, on: false, pages: [], done: {} };   // #83
    await chrome.storage.local.set({ [K_LINK]: L, [K_EVAL]: EV });
  }
  return r;
};

// 평가 [완료]의 정지에 실려 온 정답 / 오답을 이번 기록의 'link' 칸에 둔다. 정지 자체는 엔진 그대로.
//   감싼 stop 전체가 serial 한 칸 안에서 돌고 내보내기 페이지의 status · export 도 serial 로 줄을 서므로,
//   onStop 이 연 내보내기 탭은 언제나 저장이 끝난 뒤의 값을 읽는다.
const coreStop = handlers.stop;
handlers.stop = async (m, sender) => {
  const was = S.recording;
  const r = await coreStop(m, sender);
  if (was && EV && EV.on) { EV = Object.assign({}, EV, { on: false }); await chrome.storage.local.set({ [K_EVAL]: EV }); }
  if (was && m && m.reason === 'labeled' && L && L.sessionId === S.sessionId) {
    L = Object.assign({}, L, { answer: ANSWERS.includes(m.answer) ? m.answer : null });
    await chrome.storage.local.set({ [K_LINK]: L });
  }
  return r;
};

Object.assign(handlers, {
  // 팝업 [평가 시작] (#83): 모든 탭에 라벨 모드를 켠다 (11-session → primary 의 12-label).
  //   탭이 기록 중인지는 그 탭이 판단한다(기록 안 한 탭은 조용히 무시). 여기서는 세션만 본다.
  //   content script 가 없는 탭(chrome:// · 새로고침 전)은 보내기가 실패한다 — 세어서 돌려준다(팝업이 숫자를 보여 줌).
  async label() {
    if (!S.recording) return { ok: false, why: 'not-recording' };
    if (evOk() && !EV.on) { EV = Object.assign({}, EV, { on: true }); await chrome.storage.local.set({ [K_EVAL]: EV }); }
    const tabs = await chrome.tabs.query({});
    let sent = 0, failed = 0;
    await Promise.all(tabs.map(async (t) => {
      try { await chrome.tabs.sendMessage(t.id, { rbc: 'label' }, { frameId: 0 }); sent++; }
      catch (e) { failed++; }
    }));
    if (!sent) return { ok: false, why: 'no-content' };
    pushList();
    return { ok: true, sent, failed };
  },

  // 평가 바 목록에서 글을 눌렀다 (#83): 그 글의 탭 · 창을 앞으로, 탭이 없으면 그 주소를 새 탭으로. 이번 기록의 글만.
  async evalgo(m) {
    if (!S.recording || !evOk() || !EV.on) return { ok: false, why: 'not-evaluating' };
    const p = EV.pages.find((x) => x.pageId === (m && m.pageId));
    if (!p) return { ok: false, why: 'not-in-list' };
    const tabId = tabOf(p.pageId);
    if (tabId == null) {
      if (!/^https?:/.test(p.url)) return { ok: false, why: 'no-url' };
      await chrome.tabs.create({ url: p.url, active: true });   // 열린 탭이 hello → 아래 hello 감싸기가 평가를 켠다
      return { ok: true, reopened: true };
    }
    const t = await chrome.tabs.update(tabId, { active: true });
    if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
    return { ok: true };
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
    await skipClearAll();                // 기록 안 하는 사이트 탭의 회색 아이콘도 되돌린다 (#49)
    await removeLog();
    S = emptyState();
    await saveState();
    C = null;
    L = null;
    await chrome.storage.local.remove([K_CONSENT, K_LINK]);
    return { ok: true };
  },

  // 기록 삭제 (동의는 유지). 기록 중에는 거절 — 정지 먼저.
  async clear() {
    if (S.recording) return { ok: false, why: 'recording' };
    await removeLog();
    S = emptyState();
    await saveState();
    L = null;
    await chrome.storage.local.remove(K_LINK);
    return { ok: true };
  },
});

// ============================================================================
// 평가 목록 (#83, 맨 위 주석)
// ============================================================================
function evOk() { return !!(EV && EV.sessionId && EV.sessionId === S.sessionId); }

// 글을 보여 주는 탭 (같은 글을 두 탭에 열었으면 먼저 찾은 것)
function tabOf(pageId) {
  for (const [id, p] of Object.entries(S.tabPage)) if (p === pageId) return Number(id);
  return null;
}

function listFor(tabId) {
  const here = S.tabPage[tabId];
  const items = EV.pages.map((p, i) => ({
    no: i + 1, pageId: p.pageId, title: p.title || p.url || p.pageId, done: !!EV.done[p.pageId],
    tabId: tabOf(p.pageId), here: p.pageId === here, diff: (EV.diff && EV.diff[p.pageId]) || 0,
  }));
  return { items, allDone: items.length > 0 && items.every((x) => x.done) };
}

// 평가 중이면 글 탭마다 목록을 보낸다. 기다리지 않는다 — 실패(content 없음 · 고아)는 그 탭만 못 받는다.
function pushList(alsoLabelTab) {
  if (!S.recording || !evOk() || !EV.on) return;
  for (const id of Object.keys(S.tabPage)) {
    const tabId = Number(id);
    if (tabId === alsoLabelTab) chrome.tabs.sendMessage(tabId, { rbc: 'label' }, { frameId: 0 }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { rbc: 'evallist', list: listFor(tabId) }, { frameId: 0 }).catch(() => {});
  }
}

// 글 목록 · 평가 끝 표시는 엔진 page · flush 를 그대로 부른 뒤에 본다(받기 성공한 것만).
const corePage = handlers.page;
handlers.page = async (m, sender) => {
  const before = new Set((m && S.pagePids[m.pageId]) || []);   // 엔진이 합치기 전 = 기록 때 이 글에 있던 문단
  const r = await corePage(m, sender);
  if (!(r && r.ok && evOk())) return r;
  if (!EV.pages.some((p) => p.pageId === m.pageId)) {
    const meta = m.meta || {};
    EV = Object.assign({}, EV, { pages: EV.pages.concat([{ pageId: m.pageId, url: meta.url || '', title: meta.title || '' }]) });
    await chrome.storage.local.set({ [K_EVAL]: EV });
  } else if (EV.on) {
    // 평정 대상만 센다 — 조각이 전부 noise 인 유닛(본문 밖, 12-label 이 평정에서 뺌)은 빼고. 브런치 멤버십 칸의 남은 시간 시계처럼
    //   본문 밖 글자가 바뀌어 pid 가 새로 생기는 경우가 있다(11-18 서현 실측).
    const rated = (x) => !(Array.isArray(x.pieces) && x.pieces.length && x.pieces.every((pc) => pc && pc.noise));
    const n = (m.paragraphs || []).filter((x) => !before.has(x.pid) && rated(x)).length;
    EV = Object.assign({}, EV, { diff: Object.assign({}, EV.diff, { [m.pageId]: n }) });
    await chrome.storage.local.set({ [K_EVAL]: EV });
  }
  pushList();                                   // 다시 연 글은 탭이 생겼다 → 다른 탭 목록의 (닫힘)이 풀린다
  return r;
};

// 평가 중 합류 (청크 5, 맨 위 주석). 응답은 엔진 그대로, 평가 명령 · 목록은 따로 보낸다(기다리지 않음).
const coreHello = handlers.hello;
handlers.hello = async (m, sender) => {
  const r = await coreHello(m, sender);
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (tabId != null && S.recording && evOk() && EV.on) {
    chrome.tabs.sendMessage(tabId, { rbc: 'label' }, { frameId: 0 }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { rbc: 'evallist', list: listFor(tabId) }, { frameId: 0 }).catch(() => {});
  }
  return r;
};
const coreFlush = handlers.flush;
handlers.flush = async (m, sender) => {
  const r = await coreFlush(m, sender);
  const labeled = r && r.ok && evOk() && m && Array.isArray(m.events) &&
    m.events.some((e) => e && e.type === 'label' && !e.cancelled);
  if (labeled && !EV.done[m.pageId]) {
    EV = Object.assign({}, EV, { done: Object.assign({}, EV.done, { [m.pageId]: true }) });
    await chrome.storage.local.set({ [K_EVAL]: EV });
    pushList();
  }
  return r;
};

// 탭이 닫히면 다른 탭의 목록에 "닫힘"이 보이게. 엔진의 onRemoved(S.tabPage 지우기)가 먼저 줄을 선다(파일 순서).
chrome.tabs.onRemoved.addListener(() => serial(async () => pushList()).catch((e) => console.warn('[RBC] 평가 목록', e)));
// 탭 전환: 그 탭에 평가 명령 · 목록을 다시 보낸다(놓친 [평가 시작] 따라잡기).
chrome.tabs.onActivated.addListener(({ tabId }) => serial(async () => pushList(tabId)).catch((e) => console.warn('[RBC] 평가 목록', e)));

// 새로 설치하면 동의 페이지를 연다. 업데이트·확장 새로고침(reason 'update')에서는 안 연다.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('consent.html') });
});

self.RBCBG.consent = () => C;
