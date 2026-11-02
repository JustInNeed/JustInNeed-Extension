/* =============================================================================
 * bg-sink.js — 실사용 버전의 서버 전송 sink (#34). 기록 로그를 30초 청크로 잘라 보낼 상자에 넣고, 서버로 보낸다.
 *
 * 엔진 · bg-service.js · bg-auth.js 뒤에 올라간다(background.js 의 importScripts 순서).
 * 소유: 자르기 상태 Q ('sink:cur' 키, 보낼 상자 목록만 'sink:out' 키에 따로 — 기록마다 저장하는 Q 를 작게) ·
 *       보낼 상자 내용 ('out:<sessionId>:<n 6자리>' 키).
 *       둘 다 'rec:' 로 시작하지 않으므로 새 세션 시작 때 로그를 지워도 남는다.
 *
 * --- 자르기 (11-01 · 11-02 서현) -------------------------------------------------
 *   기록 중 30초마다(알람) 아직 안 자른 기록을 전부 잘라 청크로 만든다. 자르기 ≠ 보내기 — 못 보내도 계속 자른다.
 *   안 자른 기록이 500KB 를 넘으면 30초를 기다리지 않고 그 자리에서 자른다(page 기록 하나가 274KB 까지 봤음).
 *   청크 하나는 500KB 이하로 채운다. 기록 하나가 500KB 를 넘으면 그 기록 혼자 한 청크.
 *   크기 = 기록 JSON 의 UTF-8 바이트(한글 3바이트). 청크 바깥 칸만큼 조금 넘을 수 있다.
 *
 * --- 청크 모양 (BE POST /sessions/chunks 요청 그대로, BE #116 · segId 삭제 뒤) ----------
 *   { sessionId, n, final, maxN, stopReason, payload: { v, memberId, fromSeq, toSeq, cutAt, records } }
 *   n       = 세션 안 청크 번호, 1부터 빈틈없이. 마지막 청크에만 final:true · maxN(=그 n) · stopReason
 *   records = 기록 로그 줄 그대로(seq 순). 청크들을 n 순서로 이으면 seq 0 부터 빈틈없는 로그 = 내보내기와 같은 로그
 *   fromSeq · toSeq = 이 청크의 첫 · 끝 seq. 기록이 없는 마지막 청크는 둘 다 null
 *   memberId = 세션 시작 기록의 tester.memberId (시작 때 로그인한 회원)
 *
 * --- 세션 끝 -------------------------------------------------------------------
 *   정지 기록이 오면 FINAL_WAIT_MS 기다렸다 마지막 청크를 자른다 — 정지 직전 조각(flush)이 늦게 온다.
 *   그 전에 새 세션을 시작하면 시작이 직전 로그를 지우기 전에(beforeStart) 마지막 청크를 자른다.
 *   마지막 청크 뒤에 같은 세션 기록이 또 오면 청크에 넣지 못한다 → 수를 세어 팝업에 띄운다(late, 조용히 버리지 않는다).
 *   서비스 워커가 기다리는 사이 꺼졌으면 다시 깰 때 마무리한다.
 *
 *
 * --- 보내기 ----------------------------------------------------------------------
 *   보낼 상자를 만든 순서(세션 순 · n 순)대로 하나씩 POST /sessions/chunks (bg-auth 의 authed — 401 이면 재발급 한 번).
 *   201(처음) · 200(이미 받음) 이면 그 청크를 상자에서 지운다. 실패하면 그 자리에서 멈추고(뒤 번호를 먼저 보내지 않는다)
 *   원문을 Q.sendErr → 팝업 빨간 줄, SEND_ALARM(30초)에 다시. 상자가 비면 알람을 끈다.
 *   보내는 때: 청크를 자른 직후 · 30초 알람 · 로그인이 바뀜 · 서비스 워커가 깸.
 *   네트워크는 엔진 serial 밖에서 기다린다(그동안 기록 조각이 막히면 안 된다). 상자 목록을 고칠 때만 serial 안.
 *
 * --- 회원 규칙 (11-02 서현, §6) ---------------------------------------------------
 *   청크의 memberId = 지금 로그인한 회원일 때만 보낸다. 로그아웃 중이면 안 보내고 둔다.
 *   다른 회원이 로그인해 있으면 그 전 회원 청크는 바로 지운다. 못 보낸 청크는 자른 지 3일(KEEP_MS) 지나면 지운다.
 *   지운 수는 Q.dropped → 팝업 회색 줄 (조용히 버리지 않는다).
 *
 * 자르기는 엔진 serial 안에서만 한다(로그 읽기 · 쓰기가 put 과 꼬이지 않게). 실패는 원문을 Q.err → 팝업 빨간 줄.
 * ========================================================================== */
/* global VERSION, S, REC, serial, A, K_AUTH, authed */
'use strict';

const K_SINK = 'sink:cur';
const K_OUTLIST = 'sink:out';               // Q.outbox 만 따로 (바뀔 때만 저장)
const OUT = 'out:';                         // 보낼 상자. 키 = 'out:' + sessionId + ':' + n 6자리
const CUT_ALARM = 'rbc-cut';                // 30초마다 자르기 (기록 중 · 마무리 전)
const CUT_MAX_BYTES = 500 * 1024;
const FINAL_WAIT_MS = 5 * 1000;
const SINK_V = 1;                           // payload 모양 번호
const SEND_ALARM = 'rbc-send';              // 보낼 상자가 비지 않은 동안 30초마다 다시 보내기
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;    // 못 보낸 청크 보관 기간 (11-02 서현)

const utf8 = new TextEncoder();
function bytesOf(v) { return utf8.encode(JSON.stringify(v)).length; }

function emptySink() {
  return {
    sessionId: null,     // 지금 자르는 세션 (로그의 주인)
    memberId: null,      // 그 세션 시작 기록의 tester.memberId
    nextSeq: 0,          // 아직 안 자른 첫 기록 seq
    n: 0,                // 마지막으로 만든 청크 번호
    pendingBytes: 0,     // 안 자른 기록 크기 어림 (500KB 판정용)
    stopped: false,      // 정지 기록을 봤음
    stopReason: null,
    finalDone: false,    // 마지막 청크까지 만듦
    late: 0,             // 마지막 청크 뒤에 와서 청크에 넣지 못한 기록 수
    lastCutAt: null,
    outbox: [],          // 보낼 상자 목록 [{ key, sessionId, n, memberId, final, records, bytes, cutAt }] — 내용은 'out:' 키에
    err: null,           // 마지막 실패 원문 (팝업 빨간 줄). 다음 자르기가 성공하면 지운다
    lastSent: null,      // 마지막으로 보낸 청크 { sessionId, n, at, duplicate }
    sendErr: null,       // 마지막 보내기 실패 원문 (팝업 빨간 줄). 다음에 하나라도 보내면 지운다
    dropped: { other: 0, expired: 0, missing: 0 },   // 보내지 않고 지운 청크 수 (다른 회원 · 3일 지남 · 내용 없음)
  };
}

let Q = emptySink();
const sinkReady = chrome.storage.local.get([K_SINK, K_OUTLIST]).then((r) => {
  const q = r[K_SINK] || {};
  Q = Object.assign(emptySink(), q, { outbox: r[K_OUTLIST] || q.outbox || [] });   // q.outbox = 따로 두기 전 상태
});

function saveSink() {
  const { outbox, ...rest } = Q;   // eslint-disable-line no-unused-vars
  return chrome.storage.local.set({ [K_SINK]: rest });
}
function saveOutbox() { return chrome.storage.local.set({ [K_OUTLIST]: Q.outbox }); }

function sinkFail(where) {
  return (e) => {
    Q.err = `${where}: ${(e && e.message) || e}`;
    console.warn('[RBC] 서버 전송', Q.err);
    saveSink().catch((e2) => console.warn('[RBC] 자르기 상태 저장 실패', e2));
  };
}

function cutAlarmOn() {
  return chrome.alarms.get(CUT_ALARM).then((a) => {
    if (!a) return chrome.alarms.create(CUT_ALARM, { periodInMinutes: 0.5 });
  });
}

// 기록을 500KB 이하 청크들로 나눈다. 넘는 기록 하나는 혼자.
function pack(recs) {
  const groups = [];
  let cur = [], size = 0;
  for (const r of recs) {
    const b = bytesOf(r);
    if (cur.length && size + b > CUT_MAX_BYTES) { groups.push({ recs: cur, bytes: size }); cur = []; size = 0; }
    cur.push(r); size += b;
  }
  if (cur.length) groups.push({ recs: cur, bytes: size });
  return groups;
}

// 안 자른 기록을 전부 청크로. final 이면 마지막 청크 표시(기록이 없어도 빈 마지막 청크 하나).
//   serial 안에서만 부른다.
async function cut(final) {
  if (!Q.sessionId || Q.finalDone || Q.sessionId !== S.sessionId) return;
  const keys = [];
  for (let i = Q.nextSeq; i < S.seq; i++) keys.push(REC + String(i).padStart(8, '0'));
  const got = keys.length ? await chrome.storage.local.get(keys) : {};
  const recs = keys.map((k) => got[k]).filter(Boolean);
  // 로그에 구멍(put 저장 실패)이 있으면 있는 것만 자르고 원문을 남긴다 — 멈추면 새 시작까지 막힌다(#34 검토)
  const holes = recs.length !== keys.length
    ? `로그에 없는 기록 ${keys.length - recs.length}건을 빼고 자름 (seq ${Q.nextSeq}~${S.seq - 1})` : null;
  const groups = pack(recs);
  if (!groups.length && !final) return;
  if (!groups.length) groups.push({ recs: [], bytes: 0 });

  const cutAt = new Date().toISOString();
  const items = {}, metas = [];
  let n = Q.n;
  groups.forEach((g, i) => {
    n++;
    const last = final && i === groups.length - 1;
    const body = {
      sessionId: Q.sessionId, n, final: last, maxN: last ? n : null, stopReason: last ? Q.stopReason : null,
      payload: {
        v: SINK_V, memberId: Q.memberId,
        fromSeq: g.recs.length ? g.recs[0].seq : null,
        toSeq: g.recs.length ? g.recs[g.recs.length - 1].seq : null,
        cutAt, records: g.recs,
      },
    };
    const key = OUT + Q.sessionId + ':' + String(n).padStart(6, '0');
    items[key] = body;
    metas.push({ key, sessionId: Q.sessionId, n, memberId: Q.memberId, final: last, records: g.recs.length, bytes: g.bytes, cutAt });
  });
  // 청크를 먼저 쓰고 상태를 고친다 — 사이에 꺼지면 다음 자르기가 같은 번호로 같은 내용을 다시 쓴다
  await chrome.storage.local.set(items);
  Q.n = n;
  Q.nextSeq = S.seq;
  Q.pendingBytes = 0;
  Q.lastCutAt = cutAt;
  Q.outbox = Q.outbox.concat(metas);
  Q.err = holes;
  if (final) {
    Q.finalDone = true;
    await chrome.alarms.clear(CUT_ALARM);
  }
  await saveOutbox();
  await saveSink();
  kickSend();                                             // 기다리지 않는다 — 보내기는 serial 밖
}

// 정지 뒤 기다렸다가 · 새 시작 전 · 다시 깼을 때: 그 세션의 마지막 청크
async function cutFinal(sessionId) {
  if (Q.sessionId !== sessionId || Q.finalDone) return;
  await cut(true);
}

function scheduleFinal(sessionId) {
  setTimeout(() => {
    serial(() => cutFinal(sessionId)).catch(sinkFail('정지 뒤 마지막 청크'));
  }, FINAL_WAIT_MS);
}

// put 뒤마다 (엔진 SINKS.server.after → VERSION.after). serial 안 — put 이 상태 저장까지 기다린다(꺼져도 세션 · 정지를 놓치지 않게).
//   자르기는 줄 뒤에 세운다(여기서 기다리면 멈춘다).
function afterPut(r) {
  if (r.k === 'start') {
    Q = Object.assign(emptySink(), {
      outbox: Q.outbox,                                   // 다른 세션의 못 보낸 청크 · 보내기 상태는 그대로
      lastSent: Q.lastSent, sendErr: Q.sendErr, dropped: Q.dropped,
      err: Q.err,                                         // 지난 세션 마무리 실패 원문도 다음 자르기까지 보이게
      sessionId: r.sessionId,
      memberId: (r.tester && r.tester.memberId != null) ? r.tester.memberId : null,
      nextSeq: r.seq,
    });
    cutAlarmOn().catch(sinkFail('자르기 알람'));
  } else if (r.sessionId !== Q.sessionId) {
    return undefined;                                     // 자르는 세션이 아님 (엔진이 지난 세션 조각은 받지 않는다)
  } else if (Q.finalDone) {
    Q.late++;
  } else {
    Q.pendingBytes += bytesOf(r);
    if (r.k === 'stop') {
      Q.stopped = true;
      Q.stopReason = r.reason || null;
      scheduleFinal(r.sessionId);
    }
    if (Q.pendingBytes > CUT_MAX_BYTES) serial(() => cut(false)).catch(sinkFail('500KB 자르기'));
  }
  return saveSink().catch(sinkFail('자르기 상태 저장'));
}

// ============================================================================
// 보내기
// ============================================================================
// 상자 목록에서 지운다 (serial 안). why = 'sent' | 'other' | 'expired' | 'missing'
async function dropOut(keys, why) {
  if (!keys.length) return;
  await chrome.storage.local.remove(keys);
  Q.outbox = Q.outbox.filter((o) => !keys.includes(o.key));
  if (why !== 'sent') Q.dropped = Object.assign({}, Q.dropped, { [why]: (Q.dropped[why] || 0) + keys.length });
  await saveOutbox();
  await saveSink();
}

// 회원 규칙 · 보관 기간 (serial 안). 다른 회원이 로그인해 있으면 그 전 회원 청크를, 3일 지난 청크를 지운다.
async function prune() {
  const now = Date.now();
  const me = A ? A.memberId : null;
  const expired = Q.outbox.filter((o) => now - Date.parse(o.cutAt) > KEEP_MS).map((o) => o.key);
  await dropOut(expired, 'expired');
  if (me == null) return;
  await dropOut(Q.outbox.filter((o) => o.memberId !== me).map((o) => o.key), 'other');
}

function sendAlarmSync() {
  if (!Q.outbox.length) return chrome.alarms.clear(SEND_ALARM);
  return chrome.alarms.get(SEND_ALARM).then((a) => {
    if (!a) return chrome.alarms.create(SEND_ALARM, { periodInMinutes: 0.5 });
  });
}

// 한 번 돌기: 지금 회원의 청크를 만든 순서대로, 실패하면 멈춤
async function sendRound() {
  await serial(prune);
  for (;;) {
    const me = A ? A.memberId : null;
    const next = me == null ? null : Q.outbox.find((o) => o.memberId === me);
    if (!next) break;
    const body = (await chrome.storage.local.get(next.key))[next.key];
    if (!body) {
      // 목록에는 있는데 내용이 없다 — 보낼 수 없으므로 목록에서 빼고 원문을 남긴다
      Q.sendErr = `보낼 청크 내용이 없음 (${next.key}) — 목록에서 뺌`;
      await serial(() => dropOut([next.key], 'missing'));
      continue;
    }
    // 내용을 읽는 사이 로그인이 바뀌었으면 고르기부터 다시 — 남의 계정으로 보내지 않게(#34 검토). 아래 authed 까지 기다림 없음
    if (!A || A.memberId !== next.memberId) continue;
    let res;
    try {
      res = await authed('/sessions/chunks', { method: 'POST', body });
    } catch (e) {
      Q.sendErr = `청크 #${next.n}: ${(e && e.message) || e}`;
      await saveSink();
      break;
    }
    Q.lastSent = { sessionId: next.sessionId, n: next.n, at: new Date().toISOString(), duplicate: !!(res && res.duplicate) };
    Q.sendErr = null;
    await serial(() => dropOut([next.key], 'sent'));
  }
  await sendAlarmSync();
}

// 보내기는 동시에 하나만. 도는 중에 또 부르면 끝난 뒤 한 번 더 돈다.
let sendRun = null, sendAgain = false;
function kickSend() {
  if (sendRun) { sendAgain = true; return sendRun; }
  sendRun = (async () => {
    do { sendAgain = false; await sendRound(); } while (sendAgain);
  })().catch((e) => {
    Q.sendErr = `보내기: ${(e && e.message) || e}`;
    console.warn('[RBC] 서버 전송', Q.sendErr);
    return saveSink().catch((e2) => console.warn('[RBC] 자르기 상태 저장 실패', e2));
  }).finally(() => { sendRun = null; });
  return sendRun;
}

Object.assign(VERSION, {
  ready: Promise.all([VERSION.ready, sinkReady]),
  after: afterPut,
  // 새 세션 시작 직전 (엔진 start 안, serial 안): 직전 세션을 마무리하고 나서 로그가 지워지게
  //   실패해도 시작은 막지 않는다 — 막으면 다음 시작도 같은 이유로 영영 막힌다. 원문은 팝업 빨간 줄(#34 검토)
  async beforeStart() {
    if (!Q.sessionId || Q.finalDone || Q.sessionId !== S.sessionId) return;
    try {
      await cut(true);
    } catch (e) {
      Q.finalDone = true;
      sinkFail('새 시작 전 마지막 청크 — 지난 세션 끝 청크를 못 만듦')(e);
    }
  },
});

const sinkAuthStatus = VERSION.status;
VERSION.status = function status() {
  const live = Q.sessionId && Q.sessionId === S.sessionId && !Q.finalDone;
  return Object.assign(sinkAuthStatus(), {
    sink: {
      queued: Q.outbox.length,
      queuedBytes: Q.outbox.reduce((a, o) => a + o.bytes, 0),
      lastN: Q.n,
      lastCutAt: Q.lastCutAt,
      uncut: live ? S.seq - Q.nextSeq : 0,
      finalDone: Q.finalDone,
      late: Q.late,
      err: Q.err,
      lastSent: Q.lastSent,
      sendErr: Q.sendErr,
      waiting: Q.outbox.length && !A ? '로그아웃 중이라 보내지 않고 둠' : null,
      dropped: Q.dropped,
    },
  });
};

// 리스너는 최상위 동기 등록 — 알람이 꺼진 서비스 워커를 깨운다
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === CUT_ALARM) serial(() => cut(false)).catch(sinkFail('30초 자르기'));
  else if (a.name === SEND_ALARM) kickSend();
});

// 로그인이 바뀌면(연결 · 로그아웃 · 재발급) — bg-auth 가 'auth' 키에 저장한다. 다른 회원 청크 정리 + 보내기
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch[K_AUTH]) kickSend();
});

// 다시 깼을 때: 기록 중이면 알람을 다시 걸고, 정지 뒤 마무리 전에 꺼졌으면 지금 마무리.
//   엔진 세션과 자르는 세션이 다르면(있어선 안 됨) 조용히 넘기지 않고 원문을 남긴다.
serial(async () => {
  if (S.sessionId && S.sessionId !== Q.sessionId) {
    Q.err = `자르는 세션(${Q.sessionId})과 기록 세션(${S.sessionId})이 다름 — 이 기록 세션은 서버로 가지 않음`;
    return saveSink();
  }
  if (!Q.sessionId || Q.finalDone) return undefined;
  if (S.recording) return cutAlarmOn();
  return cutFinal(Q.sessionId);
}).catch(sinkFail('다시 깼을 때 마무리'));
kickSend();                                               // 다시 깼을 때 남은 청크 보내기

// 콘솔 점검용: 서비스 워커 콘솔에서 RBCSINK.state() · await RBCSINK.outbox()
self.RBCSINK = {
  state: () => Q,
  outbox: () => chrome.storage.local.get(Q.outbox.map((o) => o.key)),
};
