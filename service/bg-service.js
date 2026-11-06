/* =============================================================================
 * bg-service.js — 실사용 버전의 background 부분 (#19 빈 껍데기)
 *
 * 엔진(recorder-core/bg-core.js) 뒤에 올라간다(background.js 의 importScripts 순서).
 * 테스트 기능이 없다 — 동의 · 참여 번호 · 끝 질문 · 평정 · 설문(10-30 서현). 시작 허락 조건 = 로그인(bg-auth.js).
 * 내보내기(패널 [내보내기])는 엔진 명령이라 그대로 쓴다(10-31 서현).
 *
 * 지금 하는 것: mode 'server'. 로그인 · 시작 허락 · tester 는 bg-auth.js(#30), 자르기 · 보내기는 bg-sink.js(#34).
 *   엔진 start 는 여전히 직전 로그를 지운다 — 그 전에 bg-sink 가 남은 기록을 보낼 상자로 옮긴다.
 *
 * --- 수집 제외 URL (#49) ---------------------------------------------------------
 *   사용자가 웹 설정에서 켠 "수집 제외 URL"(BE GET /settings/collection/excluded-urls, isExcluded 인 것만)을
 *   엔진의 기록 안 할 주소 규칙(VERSION.skipRules, why 'excluded')으로 준다. 맞춰 보는 건 탭(0-core skipMatch).
 *   받은 목록은 'excl' 키에 회원 id 와 같이 둔다 — 서비스 워커가 쉬었다 깨도 · 다음 세션 첫 탭도 바로 쓰게.
 *   지금 로그인한 회원의 목록일 때만 쓴다(로그아웃 · 다른 회원 = 규칙 없음).
 *   다시 받는 때: 로그인이 바뀜 · 기록 중 탭이 규칙을 물었는데 받은 지 EXCL_MAX_AGE_MS 가 지남(기록 시작 포함).
 *     기록 안 할 때는 받지 않는다(그때는 규칙을 쓸 일이 없다). 그래서 기록 중 웹에서 바꾼 것은 최대 1분쯤 뒤에 먹는다.
 *   목록이 바뀌었고 기록 중이면 세션 방송을 다시 보낸다 → 탭이 새 규칙으로 다시 맞춰 본다(이미 열린 구간은 그대로, 11-session 헤더).
 *   실패하면 옛 목록을 그대로 쓰고 원문을 skipInfo.err → 디버그 패널 · 서비스 워커 콘솔(조용히 삼키지 않는다).
 * ========================================================================== */
/* global VERSION, S, serial, broadcast, sessionMsg, A, authed, authReady */
'use strict';

const EXCL_PATH = '/settings/collection/excluded-urls';
const K_EXCL = 'excl';                       // { memberId, urls: [표시형 url], at(마지막으로 받은 때), err }
const EXCL_MAX_AGE_MS = 60 * 1000;          // 기록 중 다시 받는 간격 (실패해도 이만큼 쉬고 다시)
let exclTried = 0;                          // 마지막으로 받으려 한 때 (메모리 — 서비스 워커가 깨면 기록 중 첫 물음에 한 번 받음)

let X = { memberId: null, urls: [], at: 0, err: null };
const exclReady = chrome.storage.local.get(K_EXCL).then((r) => { if (r[K_EXCL]) X = Object.assign(X, r[K_EXCL]); });

let exclBusy = null;
function refreshExcluded() {
  if (!exclBusy) exclBusy = fetchExcluded().finally(() => { exclBusy = null; });
  return exclBusy;
}
async function fetchExcluded() {
  exclTried = Date.now();
  await exclReady;
  await authReady;
  if (!A) return;
  const who = A.memberId;
  const before = JSON.stringify([X.memberId, X.urls]);
  try {
    const d = await authed(EXCL_PATH);
    const list = d && Array.isArray(d.excludedUrls) ? d.excludedUrls : null;
    if (!list) throw new Error(`GET ${EXCL_PATH}: 응답에 excludedUrls 가 없음`);
    if (!A || A.memberId !== who) return;                     // 기다리는 사이 로그아웃 · 다른 회원 — 버림
    X = { memberId: who, urls: list.filter((i) => i && i.isExcluded && typeof i.url === 'string').map((i) => i.url),
      at: Date.now(), err: null };
  } catch (e) {
    X = Object.assign({}, X, { err: `수집 제외 URL 받기 실패: ${(e && e.message) || e}` });   // 옛 목록은 그대로
    console.warn('[RBC]', X.err);
  }
  await chrome.storage.local.set({ [K_EXCL]: X });
  if (JSON.stringify([X.memberId, X.urls]) !== before) {
    await serial(() => (S.recording ? broadcast(sessionMsg()) : null));
  }
}

function exclMine() { return !!A && X.memberId === A.memberId; }

Object.assign(VERSION, {
  mode: 'server',
  skipRules() {
    if (S.recording && A && Date.now() - exclTried > EXCL_MAX_AGE_MS) {
      refreshExcluded().catch((e) => console.warn('[RBC] 수집 제외 URL', e));
    }
    return exclMine() ? X.urls.map((url) => ({ url, why: 'excluded' })) : [];
  },
  skipInfo() {
    return { kind: '수집 제외 URL', n: exclMine() ? X.urls.length : 0, at: exclMine() ? X.at : 0,
      err: X.err, mine: exclMine() };
  },
});

// 로그인이 바뀌면(연결 · 로그아웃 · 다른 회원) 다시 받는다. 리스너는 최상위 동기 등록.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.auth) refreshExcluded().catch((e) => console.warn('[RBC] 수집 제외 URL', e));
});
