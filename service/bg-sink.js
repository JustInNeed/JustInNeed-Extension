/* =============================================================================
 * bg-sink.js — 실사용 버전의 서버 전송 sink (#34). 이번 단계 = 청크 만들기(보내기는 다음 단계).
 *
 * 엔진 · bg-service.js · bg-auth.js 뒤에 올라간다(background.js 의 importScripts 순서).
 * 소유: 자르기 상태 Q ('sink:cur' 키) · 보낼 상자 ('out:<sessionId>:<n 6자리>' 키).
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
 * 자르기는 엔진 serial 안에서만 한다(로그 읽기 · 쓰기가 put 과 꼬이지 않게). 실패는 원문을 Q.err → 팝업 빨간 줄.
 * ========================================================================== */
/* global VERSION, S, REC, serial */
'use strict';

const K_SINK = 'sink:cur';
const OUT = 'out:';                         // 보낼 상자. 키 = 'out:' + sessionId + ':' + n 6자리
const CUT_ALARM = 'rbc-cut';                // 30초마다 자르기 (기록 중 · 마무리 전)
const CUT_MAX_BYTES = 500 * 1024;
const FINAL_WAIT_MS = 5 * 1000;
const SINK_V = 1;                           // payload 모양 번호

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
  };
}

let Q = emptySink();
const sinkReady = chrome.storage.local.get(K_SINK).then((r) => {
  if (r[K_SINK]) Q = Object.assign(emptySink(), r[K_SINK]);
});

function saveSink() { return chrome.storage.local.set({ [K_SINK]: Q }); }

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
  if (recs.length !== keys.length) {
    throw new Error(`로그에서 기록 ${keys.length - recs.length}건이 없음 (seq ${Q.nextSeq}~${S.seq - 1})`);
  }
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
  Q.err = null;
  if (final) {
    Q.finalDone = true;
    await chrome.alarms.clear(CUT_ALARM);
  }
  await saveSink();
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

// put 뒤마다 (엔진 SINKS.server.after → VERSION.after). serial 안이지만 기다리지 않는다 — 자르기는 줄 뒤에 세운다.
function afterPut(r) {
  if (r.k === 'start') {
    Q = Object.assign(emptySink(), {
      outbox: Q.outbox,                                   // 다른 세션의 못 보낸 청크는 그대로
      sessionId: r.sessionId,
      memberId: (r.tester && r.tester.memberId != null) ? r.tester.memberId : null,
      nextSeq: r.seq,
    });
    cutAlarmOn().catch(sinkFail('자르기 알람'));
  } else if (r.sessionId !== Q.sessionId) {
    return;                                               // 자르는 세션이 아님 (엔진이 지난 세션 조각은 받지 않는다)
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
  saveSink().catch(sinkFail('자르기 상태 저장'));
}

Object.assign(VERSION, {
  ready: Promise.all([VERSION.ready, sinkReady]),
  after: afterPut,
  // 새 세션 시작 직전 (엔진 start 안, serial 안): 직전 세션을 마무리하고 나서 로그가 지워지게
  async beforeStart() {
    if (Q.sessionId && !Q.finalDone) await cut(true);
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
    },
  });
};

// 리스너는 최상위 동기 등록 — 알람이 꺼진 서비스 워커를 깨운다
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === CUT_ALARM) serial(() => cut(false)).catch(sinkFail('30초 자르기'));
});

// 다시 깼을 때: 기록 중이면 알람을 다시 걸고, 정지 뒤 마무리 전에 꺼졌으면 지금 마무리
serial(async () => {
  if (!Q.sessionId || Q.finalDone) return;
  if (S.recording) await cutAlarmOn();
  else if (Q.stopped) await cutFinal(Q.sessionId);
}).catch(sinkFail('다시 깼을 때 마무리'));

// 콘솔 점검용: 서비스 워커 콘솔에서 RBCSINK.state() · await RBCSINK.outbox()
self.RBCSINK = {
  state: () => Q,
  outbox: () => chrome.storage.local.get(Q.outbox.map((o) => o.key)),
};
