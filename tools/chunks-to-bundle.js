#!/usr/bin/env node
/* =============================================================================
 * chunks-to-bundle.js — 서버가 받은 청크 → bundle (#34 견본 도구)
 *
 * 서버(BE)가 청크를 합칠 때의 정답을 만든다. 확장의 진짜 assemble()(recorder-core/bg-core.js)을 그대로 돌린다.
 *   1) 청크를 n 순서로 놓고 검사: n 1..maxN 빈틈 · final 하나(맨 끝) · 세션 id 하나 · memberId 하나 · fromSeq/toSeq 이어짐
 *      빠진 청크가 있으면 합치지 않는다(page 기록이 앞 청크에만 있어서 — docs/raw-data-audit.md §1 "서버 청크")
 *   2) records 를 이어 붙여 로그 → assemble() → bundle
 *   3) --export 를 주면 확장 [내보내기] 파일과 비교해 "같음" / 다른 곳
 *
 * 쓰는 법 (레포 루트에서):
 *   node tools/chunks-to-bundle.js --db b461a576                       로컬 시험 DB 에서 그 세션 청크를 읽음 (세션 id 앞부분)
 *   node tools/chunks-to-bundle.js chunks.json                         청크 JSON 배열 파일 (요청 본문 모양 또는 DB 줄 모양)
 *     --export data/rbc_NOID_b461a576_….json                           내보내기 파일과 비교
 *     -o expected-bundle.json                                          만든 bundle 을 파일로 (BE 테스트 정답)
 *   --db 는 docker 컨테이너 justinneed-postgres(BE docker-compose)의 session_raw_chunks 를 읽는다.
 *
 * 끝 코드: 0 = 검사 통과(+ 비교했으면 같음), 1 = 검사 실패 · 다름 · 오류
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function args(argv) {
  const o = { file: null, db: null, exp: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') o.db = argv[++i];
    else if (a === '--export') o.exp = argv[++i];
    else if (a === '-o') o.out = argv[++i];
    else if (!o.file) o.file = a;
    else throw new Error(`모르는 인자: ${a}`);
  }
  if (!o.file === !o.db) throw new Error('청크 파일 하나 또는 --db <세션 id 앞부분> 하나를 주세요');
  return o;
}

// DB 줄 모양(collector_session_id · is_final · max_n · stop_reason)도 요청 본문 모양으로 맞춘다
function norm(c) {
  return {
    sessionId: c.sessionId != null ? c.sessionId : c.collector_session_id,
    n: c.n,
    final: c.final != null ? !!c.final : !!c.is_final,
    maxN: c.maxN !== undefined ? c.maxN : c.max_n,
    stopReason: c.stopReason !== undefined ? c.stopReason : c.stop_reason,
    payload: typeof c.payload === 'string' ? JSON.parse(c.payload) : c.payload,
    userId: c.userId !== undefined ? c.userId : c.user_id,
  };
}

function fromDb(prefix) {
  if (!/^[0-9a-f-]{4,36}$/i.test(prefix)) throw new Error(`세션 id 앞부분 모양이 아님: ${prefix}`);
  const sql = "select coalesce(json_agg(json_build_object('sessionId', collector_session_id, 'n', n, 'final', is_final," +
    " 'maxN', max_n, 'stopReason', stop_reason, 'userId', user_id, 'payload', payload) order by n), '[]')" +
    ` from session_raw_chunks where collector_session_id like '${prefix}%'`;
  let out;
  try {
    out = execFileSync('docker', ['exec', 'justinneed-postgres', 'psql', '-U', 'postgres', '-d', 'justinneed', '-At', '-c', sql],
      { encoding: 'utf8', maxBuffer: 1 << 30 });
  } catch (e) {
    throw new Error(`로컬 DB 를 읽지 못함 (docker 가 켜져 있나?): ${(e.stderr || e.message || '').trim()}`);
  }
  const rows = JSON.parse(out);
  const ids = [...new Set(rows.map((r) => r.sessionId))];
  if (ids.length > 1) throw new Error(`'${prefix}' 로 시작하는 세션이 ${ids.length}개 — 더 길게 주세요: ${ids.join(', ')}`);
  return rows;
}

// 검사. 문제 목록(빈 배열 = 통과)
function inspect(chunks) {
  const bad = [];
  if (!chunks.length) return ['청크가 없음'];
  const ids = new Set(chunks.map((c) => c.sessionId));
  if (ids.size !== 1) bad.push(`세션 id 가 ${ids.size}개: ${[...ids].join(', ')}`);
  const members = new Set(chunks.map((c) => c.payload && c.payload.memberId));
  if (members.size !== 1) bad.push(`memberId 가 ${members.size}개: ${[...members].join(', ')}`);
  // DB 에서 읽었으면: 저장한 회원(토큰) = 청크 안 memberId 여야 함 — 다르면 남의 계정으로 저장된 것
  const wrong = chunks.filter((c) => c.userId != null && c.payload && c.userId !== c.payload.memberId);
  if (wrong.length) bad.push(`저장 회원(user_id) ≠ 청크 memberId: n ${wrong.map((c) => `${c.n}(${c.userId}≠${c.payload.memberId})`).join(', ')}`);
  const finals = chunks.filter((c) => c.final);
  const last = chunks[chunks.length - 1];
  if (finals.length !== 1 || !last.final) bad.push(`final 청크가 맨 끝에 하나여야 함 (지금 ${finals.length}개, 맨 끝 n ${last.n} final=${last.final})`);
  const maxN = last.final ? last.maxN : null;
  if (last.final && maxN !== last.n) bad.push(`마지막 청크 maxN ${maxN} ≠ n ${last.n}`);
  const want = maxN || last.n;
  const have = new Set(chunks.map((c) => c.n));
  const missing = [];
  for (let i = 1; i <= want; i++) if (!have.has(i)) missing.push(i);
  if (missing.length) bad.push(`빠진 청크 n: ${missing.join(', ')} — 합치지 않고 기다려야 함`);
  if (have.size !== chunks.length) bad.push('같은 n 이 두 번 있음');
  let prev = -1;
  for (const c of chunks) {
    const p = c.payload || {}, r = p.records || [];
    if (!r.length) { if (p.fromSeq != null || p.toSeq != null) bad.push(`n ${c.n}: 기록이 없는데 fromSeq/toSeq 가 있음`); continue; }
    if (p.fromSeq !== prev + 1) bad.push(`n ${c.n}: fromSeq ${p.fromSeq} ≠ 앞 청크 toSeq + 1 (${prev + 1})`);
    if (p.fromSeq !== r[0].seq || p.toSeq !== r[r.length - 1].seq) bad.push(`n ${c.n}: fromSeq/toSeq 가 records 의 seq 와 다름`);
    for (let i = 1; i < r.length; i++) if (r[i].seq !== r[i - 1].seq + 1) { bad.push(`n ${c.n}: records 안 seq 가 끊김 (${r[i - 1].seq} → ${r[i].seq})`); break; }
    prev = p.toSeq;
  }
  return bad;
}

// 확장의 진짜 assemble() — bg-core.js 를 vm 에 올린다 (chrome 은 최상위 등록만 받는 빈 껍데기)
function loadAssemble() {
  const noop = { addListener() {} };
  const chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    alarms: { get: async () => null, create: async () => {}, clear: async () => {}, onAlarm: noop },
    runtime: { onMessage: noop }, tabs: { onActivated: noop, onRemoved: noop },
    windows: { onFocusChanged: noop, WINDOW_ID_NONE: -1 },
  };
  const ctx = { chrome, console, crypto: require('crypto').webcrypto };
  ctx.self = ctx;
  vm.createContext(ctx);
  const file = path.join(ROOT, 'recorder-core', 'bg-core.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return (log) => JSON.parse(JSON.stringify(ctx.RBCBG.assemble(log)));   // vm 바깥 객체로
}

// 다른 곳 최대 limit 개 (경로 · 두 값)
function diff(a, b, at = '', out = [], limit = 10) {
  if (out.length >= limit) return out;
  if (a === b) return out;
  const ta = Array.isArray(a) ? 'array' : typeof a, tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb || a === null || b === null || ta !== 'object' && ta !== 'array') {
    out.push(`${at || '(전체)'}: 청크 쪽 ${short(a)} / 내보내기 쪽 ${short(b)}`);
    return out;
  }
  if (ta === 'array' && a.length !== b.length) out.push(`${at}: 길이 청크 쪽 ${a.length} / 내보내기 쪽 ${b.length}`);
  const keys = ta === 'array' ? [...Array(Math.min(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) diff(a[k], b[k], ta === 'array' ? `${at}[${k}]` : (at ? `${at}.${k}` : k), out, limit);
  return out;
}
function short(v) { const s = JSON.stringify(v); return s === undefined ? '(없음)' : s.length > 80 ? s.slice(0, 77) + '…' : s; }

function main() {
  const o = args(process.argv.slice(2));
  const raw = o.db ? fromDb(o.db) : JSON.parse(fs.readFileSync(o.file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('청크 파일은 JSON 배열이어야 함');
  const chunks = raw.map(norm).sort((a, b) => a.n - b.n);
  const recs = chunks.reduce((n, c) => n + ((c.payload && c.payload.records) || []).length, 0);
  console.log(`세션 ${chunks[0] ? chunks[0].sessionId : '-'} · 청크 ${chunks.length}개 · 기록 ${recs}건`);

  const bad = inspect(chunks);
  if (bad.length) {
    console.log('검사 실패 — 합치지 않음:');
    bad.forEach((b) => console.log('  ✗ ' + b));
    return 1;
  }
  console.log('  ✓ 검사 통과 (n 빈틈없음 · final 맨 끝 · seq 이어짐)');

  const log = chunks.flatMap((c) => c.payload.records);
  const bundle = loadAssemble()(log);
  const s = bundle.session;
  console.log(`  bundle: 글 ${bundle.pages.length}개 · 기록 ${s.records}건 · 정지 ${s.stopReason} · focusMs ${s.focusMs} · tester ${JSON.stringify(s.tester)}`);
  if (o.out) {
    fs.writeFileSync(o.out, JSON.stringify(bundle));
    console.log(`  만듦: ${o.out}`);
  }
  if (!o.exp) return 0;

  const ex = JSON.parse(fs.readFileSync(o.exp, 'utf8'));
  const d = diff(bundle, ex);
  if (!d.length) {
    console.log(`  ✓ 내보내기 파일과 같음 (${path.basename(o.exp)})`);
    return 0;
  }
  console.log(`  ✗ 내보내기 파일과 다름 — 처음 ${d.length}곳:`);
  d.forEach((x) => console.log('    ' + x));
  return 1;
}

try {
  process.exit(main());
} catch (e) {
  console.error('오류: ' + (e && e.message || e));
  process.exit(1);
}
