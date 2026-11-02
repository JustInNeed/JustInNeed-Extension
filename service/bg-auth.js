/* =============================================================================
 * bg-auth.js — 실사용 버전 로그인 (#30). 확장 전용 토큰.
 *
 * 엔진 · bg-service.js 뒤에 올라간다(background.js 의 importScripts 순서).
 * 소유: 로그인 기록 A ('auth' 키) — 'rec:' 로 시작하지 않으므로 새 세션 시작 때 로그를 지워도 남는다.
 *       로그인 탭 기록 ('auth:tab' 키) — 팝업 버튼이 연 웹 탭과 돌아갈 탭.
 *
 * --- 흐름 (BE 담당 안내문 · BE #101) -------------------------------------------
 *   팝업 [로그인하러 가기] → login 명령 → 지금 탭을 기억하고 웹 연결 페이지(WEB_CONNECT)를 새 탭으로 연다.
 *   웹에 로그인되면 웹이 POST /auth/extension-code 로 1회용 코드(60초)를 받아
 *   chrome.runtime.sendMessage(확장 ID, { type: 'JIN_CONNECT', code }) 로 보낸다.
 *   확장은 POST /auth/token { code } → 자기 전용 access · refresh 토큰 → GET /members/me 로 회원 id.
 *   웹의 토큰을 같이 쓰지 않는다 — refresh 토큰이 1회용이라 한쪽이 재발급하면 다른 쪽이 로그아웃된다.
 *   연결이 그 로그인 탭에서 왔으면: 잠깐 뒤 그 탭을 닫고 → 기억한 탭으로 돌아가고 → 팝업을 연다.
 *
 * --- 웹이 보내는 메시지 (onMessageExternal) -------------------------------------
 *   JIN_STATUS  → { loggedIn, memberId, version }
 *   JIN_CONNECT → { ok, memberId }       코드를 토큰으로 바꿔 저장
 *   JIN_LOGOUT  → { ok }                 토큰 삭제 + 서버에 로그아웃 알림(실패해도 지움)
 *   보낸 곳(sender.origin)이 WEB_ORIGINS 가 아니면 거절. manifest externally_connectable 과 같은 목록.
 *   실패하면 { ok: false, why: 원문 } 을 돌려주고 팝업에도 원문을 띄운다(조용히 삼키지 않는다).
 *
 * --- 토큰 재발급 (안내문 "API 호출과 재발급") -----------------------------------
 *   로그인이 필요한 호출은 authed() 로만. 401 이면 재발급 한 번 → 원래 요청 다시 한 번.
 *   재발급은 동시에 하나만(refreshing 약속을 같이 기다린다) — 둘이 같은 refresh 토큰을 내면 하나가 실패한다.
 *   재발급 응답의 access · refresh 를 둘 다 저장한다(refresh 도 새 값).
 *   재발급이 401 = 로그인이 끝남(만료 · 웹에서 로그아웃 → 서버가 토큰 묶음 삭제) → 토큰 삭제, 로그아웃 상태.
 *   네트워크 오류 · 5xx = 토큰을 지우지 않는다. 다음 확인 때 다시.
 *   팝업이 열릴 때마다 whoami 명령으로 GET /members/me 를 불러 로그인이 아직 살아 있는지 확인한다.
 *
 * --- 기록과의 관계 -------------------------------------------------------------
 *   로그인 안 했으면 기록 시작 거절(why 'no-login', §6 10-31 팀).
 *   start 기록의 tester = { memberId: <회원 id, 숫자> } — BE 가 쓰는 이름 그대로(11-02 서현). 데이터 수집 버전의 tester 와 칸이 다르다.
 *   AI 는 지금 session.tester.testId 를 읽으므로 AI 담당이 memberId 를 읽게 바꿔야 한다(서현이 알림).
 *   기록 중에 로그아웃 · 다른 회원으로 연결돼도 기록은 멈추지 않는다. 그 세션의 tester 는 시작 때 값 그대로.
 *
 * 토큰은 content script · 웹 · 콘솔 · 로그로 내보내지 않는다. status 에는 회원 id 만 싣는다.
 * 네트워크를 기다리는 일은 엔진 serial 밖(authSerial)에서 한다 — 그동안 기록 조각(flush)이 막히면 안 된다.
 *   그래서 팝업의 whoami · logout 명령은 일을 걸어 두고 바로 답한다. 결과는 팝업이 1초마다 읽는 status 에 나온다.
 * ========================================================================== */
/* global VERSION, handlers */
'use strict';

const API_BASE = 'https://api.justinneed.xyz';                    // manifest host_permissions 와 같아야 한다
const WEB_BASE = 'https://just-in-need-fe.vercel.app';
const WEB_CONNECT = WEB_BASE + '/extension/connect';              // 웹 연결 페이지 (웹 레포에 만들 것, 청크 3)
const WEB_ORIGINS = [WEB_BASE, 'http://localhost:3000'];          // manifest externally_connectable 과 같아야 한다
const K_AUTH = 'auth';
const K_LOGIN_TAB = 'auth:tab';    // { loginTabId, returnTabId, returnWindowId } — 서비스 워커가 쉬어도 남게 storage 에
const RETURN_DELAY_MS = 1200;      // 연결 뒤 로그인 탭을 닫기까지 — 웹이 "연결됐어요"를 보여 줄 틈

let A = null;          // { accessToken, refreshToken, memberId, at, checkedAt } | null
let authErr = null;    // 마지막 실패 원문 (팝업 빨간 줄). 성공하면 지운다
let authNote = null;   // 실패는 아니지만 알릴 것 (팝업 회색 줄) — 예: 팝업을 저절로 못 엶

const authReady = chrome.storage.local.get(K_AUTH).then((r) => { A = r[K_AUTH] || null; });

// 로그인 일은 서로 줄을 세운다(연결 · 확인 · 로그아웃이 겹치지 않게). 엔진 serial 과는 따로.
let authChain = authReady;
function authSerial(fn) {
  const p = authChain.then(fn);
  authChain = p.catch(() => {});
  return p;
}

// 서버 응답은 { success, data, message } 로 감싸져 있다. 실패면 상태 코드 + 서버 문구를 그대로 담아 던진다.
//   e.status = HTTP 상태 (서버에 닿지 못했으면 0)
async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw Object.assign(new Error(`${method} ${path}: 서버에 닿지 못함 (${e.message || e})`), { status: 0 });
  }
  // 본문이 JSON 이 아니면(예: Spring CORS 거절 "Invalid CORS request") 그 글자를 그대로 오류에 싣는다
  const text = await res.text().catch((e) => `(본문 못 읽음: ${e.message || e})`);
  let j = null;
  try { j = JSON.parse(text); } catch (e) { j = null; }
  if (!res.ok || !j || j.success === false) {
    const msg = `${method} ${path}: ${res.status} ${(j && j.message) || text.slice(0, 200) || res.statusText || '응답 본문 없음'}`;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return j.data;
}

async function saveAuth() {
  if (A) await chrome.storage.local.set({ [K_AUTH]: A });
  else await chrome.storage.local.remove(K_AUTH);
}

// 재발급 — 동시에 하나만. 기다리는 쪽은 같은 약속을 받는다.
let refreshing = null;
function refreshTokens() {
  if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}
async function doRefresh() {
  const was = A;
  if (!was) throw new Error('재발급: 로그인 안 됨');
  let t;
  try {
    t = await api('/auth/refresh', { method: 'POST', body: { refreshToken: was.refreshToken } });
  } catch (e) {
    // 401 = 로그인이 끝남 → 로그아웃 상태. 네트워크 · 5xx 는 토큰을 남기고 오류만 올린다.
    if (e.status === 401 && A === was) {
      A = null;
      await saveAuth();
      throw new Error(`로그인이 끝났어요(재발급 거절) — 다시 로그인해 주세요. ${e.message}`);
    }
    throw e;
  }
  if (!t || !t.accessToken || !t.refreshToken) throw new Error('POST /auth/refresh: 응답에 토큰이 없음');
  // 재발급을 기다리는 사이 로그아웃 · 다른 회원 연결이 끝났으면 새 토큰은 버린다
  if (A !== was) throw new Error('재발급 중에 로그인 상태가 바뀜 — 새 토큰을 버림');
  A = Object.assign({}, was, { accessToken: t.accessToken, refreshToken: t.refreshToken });
  await saveAuth();
}

// 로그인이 필요한 호출. 401 이면 재발급 한 번 → 다시 한 번 (두 번째 401 은 그대로 오류).
async function authed(path, opts = {}) {
  if (!A) throw new Error(`${path}: 로그인 안 됨`);
  try {
    return await api(path, Object.assign({}, opts, { token: A.accessToken }));
  } catch (e) {
    if (e.status !== 401) throw e;
  }
  await refreshTokens();
  return api(path, Object.assign({}, opts, { token: A.accessToken }));
}

async function connect(code) {
  const c = typeof code === 'string' ? code.trim() : '';
  if (!c) throw new Error('연결 코드가 비어 있음');
  const t = await api('/auth/token', { method: 'POST', body: { code: c } });
  if (!t || !t.accessToken || !t.refreshToken) throw new Error('POST /auth/token: 응답에 토큰이 없음');
  const me = await api('/members/me', { token: t.accessToken });
  if (!me || me.id == null) throw new Error('GET /members/me: 응답에 회원 id 가 없음');
  const now = new Date().toISOString();
  A = { accessToken: t.accessToken, refreshToken: t.refreshToken, memberId: me.id, at: now, checkedAt: now };
  await saveAuth();
  authErr = null;
  return A.memberId;
}

// 로그인이 아직 살아 있나 (팝업이 열릴 때). 실패 원문은 authErr — 401 끝 = 이미 로그아웃 상태가 됨.
async function check() {
  if (!A) return;
  try {
    const me = await authed('/members/me');
    if (A && me && me.id === A.memberId) {
      A = Object.assign({}, A, { checkedAt: new Date().toISOString() });
      await saveAuth();
      authErr = null;
    } else if (A) {
      authErr = `로그인 확인: 서버의 회원 id(${me && me.id})가 저장된 값(${A.memberId})과 다름`;
    }
  } catch (e) {
    authErr = `로그인 확인 실패: ${e.message || e}`;
  }
}

// 토큰은 먼저 지운다. 서버 알림이 실패해도(만료 · 오프라인) 확장은 로그아웃 상태 — 실패 원문은 팝업에.
async function logout() {
  const old = A;
  A = null;
  await saveAuth();
  authErr = null;
  authNote = null;
  if (!old) return;
  try {
    await api('/auth/logout', { method: 'POST', token: old.accessToken, body: { refreshToken: old.refreshToken } });
  } catch (e) {
    authErr = `로그아웃은 됐지만 서버 알림 실패: ${e.message}`;
  }
}

// 팝업 버튼이 연 로그인 탭에서 연결이 왔으면: 그 탭을 닫고 원래 탭으로 돌아가 팝업을 연다.
//   다른 탭(사용자가 웹을 직접 연 경우)에서 온 연결이면 아무것도 안 한다 — 남의 탭을 닫지 않는다.
async function returnFromLogin(tab) {
  const r = (await chrome.storage.local.get(K_LOGIN_TAB))[K_LOGIN_TAB];
  if (!r || !tab || tab.id !== r.loginTabId) return;
  await chrome.storage.local.remove(K_LOGIN_TAB);
  await new Promise((res) => setTimeout(res, RETURN_DELAY_MS));
  try {
    await chrome.tabs.remove(tab.id).catch(() => {});      // 사용자가 먼저 닫았으면 없음 — 그대로 진행
    if (r.returnTabId != null) {
      await chrome.tabs.update(r.returnTabId, { active: true });
      await chrome.windows.update(r.returnWindowId, { focused: true });
    }
  } catch (e) {
    authNote = `로그인은 됐지만 원래 탭으로 못 돌아갔어요 (${e.message || e})`;
    return;
  }
  try {
    await chrome.action.openPopup();
  } catch (e) {
    authNote = `로그인됐어요. 팝업은 저절로 못 열었어요 — 확장 아이콘을 눌러 확인하세요 (${e.message || e})`;
  }
}

Object.assign(VERSION, {
  ready: authReady,
  async gate() { return A ? null : 'no-login'; },
  tester() { return A ? { memberId: A.memberId } : null; },
  status() {
    return {
      login: A ? { memberId: A.memberId, at: A.at, checkedAt: A.checkedAt || null } : null,
      loginErr: authErr,
      loginNote: authNote,
    };
  },
});

Object.assign(handlers, {
  // 팝업 [로그인하러 가기]: 지금 탭을 기억하고 웹 연결 페이지를 새 탭으로. 로그인 자체는 웹이 JIN_CONNECT 로 끝낸다.
  async login() {
    const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const t = await chrome.tabs.create({ url: WEB_CONNECT });
    await chrome.storage.local.set({ [K_LOGIN_TAB]: {
      loginTabId: t.id, returnTabId: cur ? cur.id : null, returnWindowId: cur ? cur.windowId : null,
    } });
    authNote = null;
    return { ok: true };
  },
  // 팝업이 열릴 때: 로그인 확인을 걸어 두고 바로 답한다 (결과는 status 로)
  async whoami() {
    authSerial(check).catch((e) => { authErr = `로그인 확인 실패: ${e.message || e}`; });
    return { ok: true };
  },
  // 팝업 [로그아웃]
  async logout() {
    authSerial(logout).catch((e) => { authErr = `로그아웃 실패: ${e.message || e}`; });
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
  authSerial(() => fn(m)).then((r) => {
    reply(r);
    if (m.type === 'JIN_CONNECT') {
      returnFromLogin(sender.tab).catch((e) => { authNote = `원래 탭으로 돌아가기 실패: ${e.message || e}`; });
    }
  }, (e) => {
    authErr = `${m.type}: ${e.message || e}`;
    reply({ ok: false, memberId: null, why: authErr });
  });
  return true;                                    // 비동기 응답
});
