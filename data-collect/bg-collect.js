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
 * --- 조건 태그 · 링크 번호 (#24) ----------------------------------------------
 *   조건 태그 = Q1 · Q2 중 하나(필수). 동의 페이지에서 고른다. 다른 값(옛 자유 입력 · 빈 값)이면
 *   동의가 없는 것으로 봐서 다시 고르게 한다 — testId 는 유지된다.
 *   링크 번호 = 이번에 읽는 글의 번호(001~100, 세 자리). 팝업이 start 에 linkNo 로 싣는다. 없으면 시작 거절.
 *   기록 로그 · JSON 에는 넣지 않는다(형식 그대로, 10-31 서현). 'link' 키에 { linkNo, sessionId } 로 두고,
 *   내보내기 페이지가 파일 이름에만 쓴다. sessionId 로 이번 기록의 번호인지 맞춘다.
 * ========================================================================== */
/* global VERSION, handlers, S:writable, emptyState, saveState, removeLog, broadcast, sessionMsg, cleanField */
'use strict';

const K_CONSENT = 'consent';  // 동의 기록. 세션 로그와 따로 산다
const CONSENT_VERSION = 2;    // consent.html 고지문 버전과 같아야 한다 (2 = 참여 번호 추가)

const K_LINK = 'link';        // 이번 기록의 링크 번호 { linkNo, sessionId }. 로그 밖 — JSON 에 안 들어간다
const TAGS = ['Q1', 'Q2'];    // 조건 태그로 고를 수 있는 값 (consent.html 의 선택지와 같아야 한다)
const LINK_MAX = 100;         // 링크 번호 001 ~ LINK_MAX (popup.js 의 목록과 같아야 한다)

let C = null;                 // 동의 기록 { version, testId, participantNo, name, tag, at } | null
let L = null;                 // { linkNo, sessionId } | null

// ============================================================================
// 동의
// ============================================================================
function tagValid(tag) { return TAGS.includes(tag); }
function consentValid() {
  return !!(C && C.version === CONSENT_VERSION && C.testId && C.participantNo && tagValid(C.tag));
}

// '003' 처럼 세 자리 숫자 문자열이고 001 ~ LINK_MAX 안이면 그대로, 아니면 null
function cleanLink(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^\d{3}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= LINK_MAX ? s : null;
}

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

Object.assign(VERSION, {
  mode: 'download',
  ready: chrome.storage.local.get([K_CONSENT, K_LINK]).then((r) => {
    C = r[K_CONSENT] || null;
    L = r[K_LINK] || null;
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
      consent: C ? Object.assign({ valid: consentValid(), tagValid: tagValid(C.tag) }, C) : null,
      consentVersion: CONSENT_VERSION,
      // 이번 세션의 링크 번호. 다른 세션의 것이면 null (파일 이름에 엉뚱한 번호가 붙지 않게)
      linkNo: L && L.sessionId === S.sessionId ? L.linkNo : null,
    };
  },
});

// 기록 시작에 링크 번호를 요구한다. 엔진 start 는 그대로 부르고, 시작에 성공하면 번호를 'link' 키에 둔다.
//   동의가 없으면 엔진 gate 의 'no-consent' 가 먼저 나오도록 동의부터 본다.
const coreStart = handlers.start;
handlers.start = async (m, sender) => {
  if (S.recording || !consentValid()) return coreStart(m, sender);
  const linkNo = cleanLink(m && m.linkNo);
  if (!linkNo) return { ok: false, why: 'no-link' };
  const r = await coreStart(m, sender);
  if (r && r.rbc === 'start') {
    L = { linkNo, sessionId: S.sessionId };
    await chrome.storage.local.set({ [K_LINK]: L });
  }
  return r;
};

Object.assign(handlers, {
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

  // 동의 페이지가 보낸다. version = 그 페이지가 보여준 고지문 버전.
  //   재동의(고지문 버전 변경)는 testId 를 유지한다. 철회 뒤 동의는 새 testId.
  async consent(m) {
    if (!m || m.version !== CONSENT_VERSION) return { ok: false, why: 'consent-version' };
    const participantNo = cleanField(m.participantNo, 20).toUpperCase();   // p01 과 P01 이 갈리지 않게
    if (!participantNo) return { ok: false, why: 'no-participant' };
    const name = cleanField(m.name, 40);
    if (!name) return { ok: false, why: 'no-name' };
    if (!tagValid(m.tag)) return { ok: false, why: 'no-tag' };
    C = {
      version: CONSENT_VERSION,
      testId: (C && C.testId) || newTestId(),
      participantNo,
      name,
      tag: m.tag,
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

// 새로 설치하면 동의 페이지를 연다. 업데이트·확장 새로고침(reason 'update')에서는 안 연다.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('consent.html') });
});

self.RBCBG.consent = () => C;
