/* =============================================================================
 * bg-auth.js — 실사용 버전 로그인 (#30). 확장 전용 토큰.
 *
 * 엔진 · bg-service.js 뒤에 올라간다(background.js 의 importScripts 순서).
 * 소유: 로그인 기록 A ('auth' 키) — 'rec:' 로 시작하지 않으므로 새 세션 시작 때 로그를 지워도 남는다.
 *
 * --- 흐름 (BE 담당 안내문 · BE #101) -------------------------------------------
 *   팝업 [로그인하러 가기] → login 명령 → 웹 연결 페이지(WEB_CONNECT)를 새 탭으로 연다.
 *   웹에 로그인되면 웹이 POST /auth/extension-code 로 1회용 코드(60초)를 받아
 *   chrome.runtime.sendMessage(확장 ID, { type: 'JIN_CONNECT', code }) 로 보낸다.
 *   확장은 POST /auth/token { code } → 자기 전용 access · refresh 토큰 → GET /members/me 로 회원 id.
 *   웹의 토큰을 같이 쓰지 않는다 — refresh 토큰이 1회용이라 한쪽이 재발급하면 다른 쪽이 로그아웃된다.
 *
 * --- 웹이 보내는 메시지 (onMessageExternal) -------------------------------------
 *   JIN_STATUS  → { loggedIn, memberId, version }
 *   JIN_CONNECT → { ok, memberId }       코드를 토큰으로 바꿔 저장
 *   JIN_LOGOUT  → { ok }                 토큰 삭제 + 서버에 로그아웃 알림(실패해도 지움)
 *   보낸 곳(sender.origin)이 WEB_ORIGINS 가 아니면 거절. manifest externally_connectable 과 같은 목록.
 *   실패하면 { ok: false, why: 원문 } 을 돌려주고 팝업에도 원문을 띄운다(조용히 삼키지 않는다).
 *
 * --- 기록과의 관계 -------------------------------------------------------------
 *   로그인 안 했으면 기록 시작 거절(why 'no-login', §6 10-31 팀).
 *   start 기록의 tester = { testId: "<회원 id>" } — AI 가 session.tester.testId 를 사용자 구분으로 읽는다(11-01 서현).
 *   기록 중에 로그아웃 · 다른 회원으로 연결돼도 기록은 멈추지 않는다. 그 세션의 tester 는 시작 때 값 그대로.
 *
 * 토큰은 content script · 웹 · 콘솔 · 로그로 내보내지 않는다. status 에는 회원 id 만 싣는다.
 * 아직 안 하는 것(청크 2): 401 → 재발급 · 팝업 로그아웃 · 로그인 뒤 웹 탭 닫고 원래 탭으로.
 * ========================================================================== */
/* global VERSION, handlers */
'use strict';

const API_BASE = 'https://api.justinneed.xyz';                    // manifest host_permissions 와 같아야 한다
const WEB_BASE = 'https://just-in-need-fe.vercel.app';
const WEB_CONNECT = WEB_BASE + '/extension/connect';              // 웹 연결 페이지 (웹 레포에 만들 것, 청크 3)
const WEB_ORIGINS = [WEB_BASE, 'http://localhost:3000'];          // manifest externally_connectable 과 같아야 한다
const K_AUTH = 'auth';

let A = null;          // { accessToken, refreshToken, memberId, at } | null
let authErr = null;    // 마지막 실패 원문 (팝업 표시용). 성공하면 지운다

const authReady = chrome.storage.local.get(K_AUTH).then((r) => { A = r[K_AUTH] || null; });

// 로그인 일은 서로 줄을 세운다(연결 · 로그아웃이 겹치지 않게). 엔진 serial 과는 따로 —
//   네트워크를 기다리는 동안 기록 조각(flush)이 막히면 안 된다.
let authChain = authReady;
function authSerial(fn) {
  const p = authChain.then(fn);
  authChain = p.catch(() => {});
  return p;
}

// 서버 응답은 { success, data, message } 로 감싸져 있다. 실패면 상태 코드 + 서버 문구를 그대로 담아 던진다.
async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error(`${method} ${path}: 서버에 닿지 못함 (${e.message || e})`);
  }
  // 본문이 JSON 이 아니면(예: Spring CORS 거절 "Invalid CORS request") 그 글자를 그대로 오류에 싣는다
  const text = await res.text().catch((e) => `(본문 못 읽음: ${e.message || e})`);
  let j = null;
  try { j = JSON.parse(text); } catch (e) { j = null; }
  if (!res.ok || !j || j.success === false) {
    throw new Error(`${method} ${path}: ${res.status} ${(j && j.message) || text.slice(0, 200) || res.statusText || '응답 본문 없음'}`);
  }
  return j.data;
}

async function connect(code) {
  const c = typeof code === 'string' ? code.trim() : '';
  if (!c) throw new Error('연결 코드가 비어 있음');
  const t = await api('/auth/token', { method: 'POST', body: { code: c } });
  if (!t || !t.accessToken || !t.refreshToken) throw new Error('POST /auth/token: 응답에 토큰이 없음');
  const me = await api('/members/me', { token: t.accessToken });
  if (!me || me.id == null) throw new Error('GET /members/me: 응답에 회원 id 가 없음');
  A = { accessToken: t.accessToken, refreshToken: t.refreshToken, memberId: me.id, at: new Date().toISOString() };
  await chrome.storage.local.set({ [K_AUTH]: A });
  authErr = null;
  return A.memberId;
}

// 토큰은 먼저 지운다. 서버 알림이 실패해도(만료 · 오프라인) 확장은 로그아웃 상태 — 실패 원문은 팝업에.
async function logout() {
  const old = A;
  A = null;
  await chrome.storage.local.remove(K_AUTH);
  authErr = null;
  if (!old) return;
  try {
    await api('/auth/logout', { method: 'POST', token: old.accessToken, body: { refreshToken: old.refreshToken } });
  } catch (e) {
    authErr = `로그아웃은 됐지만 서버 알림 실패: ${e.message}`;
  }
}

Object.assign(VERSION, {
  ready: authReady,
  async gate() { return A ? null : 'no-login'; },
  tester() { return A ? { testId: String(A.memberId) } : null; },
  status() {
    return { login: A ? { memberId: A.memberId, at: A.at } : null, loginErr: authErr };
  },
});

Object.assign(handlers, {
  // 팝업 [로그인하러 가기]: 웹 연결 페이지를 새 탭으로. 로그인 자체는 웹이 JIN_CONNECT 로 끝낸다.
  async login() {
    await chrome.tabs.create({ url: WEB_CONNECT });
    return { ok: true };
  },
});

const EXTERNAL = {
  async JIN_STATUS() {
    return { loggedIn: !!A, memberId: A ? A.memberId : null, version: chrome.runtime.getManifest().version };
  },
  async JIN_CONNECT(m) {
    return { ok: true, memberId: await connect(m.code) };
  },
  async JIN_LOGOUT() {
    await logout();
    return { ok: true };
  },
};

// 리스너는 최상위 동기 등록 (service worker 가 깨어날 때 받으려면).
chrome.runtime.onMessageExternal.addListener((m, sender, reply) => {
  if (!WEB_ORIGINS.includes(sender.origin)) {
    reply({ ok: false, why: `허용 안 된 곳에서 온 메시지: ${sender.origin}` });
    return false;
  }
  const fn = EXTERNAL[m && m.type];
  if (!fn) {
    reply({ ok: false, why: `모르는 메시지: ${m && m.type}` });
    return false;
  }
  authSerial(() => fn(m)).then(reply, (e) => {
    authErr = `${m.type}: ${e.message || e}`;
    reply({ ok: false, memberId: null, why: authErr });
  });
  return true;                                    // 비동기 응답
});
