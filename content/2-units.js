/* =============================================================================
 * 2-units.js — 청킹 · pid 부여 · 재스캔
 *
 * 소유: units, chunkOpts(가변 청킹 파라미터), 스트림 지역 거울(raw/sig/breaks)
 * 의존(직접 호출): 0-core, 1-stream
 * 발행: units:changed, units:rescanned, units:scanned, units:list
 * 구독: cmd:scan, cmd:chunk, cmd:list, record:started, record:stopped
 *
 * --- 유닛이란 --------------------------------------------------------------
 *   본문 텍스트 스트림의 글자 오프셋 구간 [start, end). DOM 문단이 아니다.
 *   좌표가 아니라 '글자'로 정의되므로 lazy-load / 광고 삽입 / 폰트 로딩으로
 *   레이아웃이 밀려도 정체성이 안 깨진다.
 *   절단 우선순위: 블록/<br> 경계 > 문장 끝 > 공백 > 강제
 *   문장 경계에 스냅하므로 문장이 반토막 나지 않는다 (LLM 단계 보호).
 *
 *   pid   = 유닛 텍스트 앞 160자의 해시. 재스캔해도 같은 글이면 같은 id.
 *   order = 본문 내 순서 (0..n-1 연속).
 *   이 둘이 유닛을 서로 구분하고 줄 세우는 유일한 근거다.
 *
 * --- 조각 pieces (v3, 감사 §8-4) ----------------------------------------------
 *   유닛 = 약 200자 글자 구간. DOM 블록 = <p> <li> <div> 같은 HTML 블록 요소.
 *   조각 = 유닛 중 DOM 블록 하나에 속하는 부분. 짧은 문단은 다음 문단과 합쳐지므로
 *   유닛 하나가 조각 여럿일 수 있다 ("본문 마지막 문장 + 관련기사 제목").
 *
 *   u.pieces = [{ off, chars, linkChars, path, pathCut }, …]   배열 순서 = 조각 번호 k
 *     off, chars = 유닛 text(clean 뒤, UTF-16) 안 위치. 빈틈 · 겹침 없이 text 를 나눈다.
 *     linkChars  = 그중 <a> 안 글자 수 (개수, 비율 아님).
 *     path       = 조각 첫 텍스트 노드의 DOM 블록부터 위로 최대 6단계, 루트 직전에서 멈춤.
 *                  DOM 블록이 루트 자신이거나 루트 밖이면 [].
 *     pathCut    = 6단계에서 잘려 루트에 못 닿았다.
 *   계산 시점 = 청킹할 때. 이미 계산된 유닛은 끝(end)이 그대로면 다시 계산하지 않는다
 *   (DOM 이 나중에 다시 그려져도 pid 가 같으면 기존 값 유지).
 *
 *   원문 → 정리된 text 오프셋 = sig[p] - sig[u.start] 를 charLen 에서 자른 값.
 *   sig 가 clean() 과 같은 규칙(공백 연속 = 1글자, 앞 공백 안 셈)이고 유닛 시작은
 *   항상 공백이 아니므로 성립한다. 끝의 공백은 clean 이 trim 하므로 자른다.
 *   highlight/copy 의 ranges(세트 C)도 이 함수(textOff)를 쓴다.
 *
 *   2026-09-19 의 "rect / DOM 경로 수집 안 함" 결정은 2026-10-01 폐기됐다 (감사 §8).
 *   유닛 전체가 아니라 조각 단위로 남기므로 "유닛은 글자 오프셋 기준"과 충돌하지 않는다.
 *
 * --- BUG-1 배경: 가변 파라미터 분리 ----------------------------------------
 *   TARGET/MIN/MAX/MIN_UNIT 은 패널 슬라이더가 런타임에 바꾼다. 전에는 이게
 *   CFG(불변값 모음) 안에 섞여 있어서, 기록 중에 슬라이더를 건드리면 유닛이
 *   전부 새 pid 를 받고 세션이 조용히 무효가 됐다.
 *   이제 가변분은 여기(chunkOpts)가 소유하고, CFG 의 네 값은 초기 기본값으로만
 *   읽는다. 기록 중 변경 차단은 패널·프레임 양쪽에 그대로 남아 있다.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus } = RBC;
  const { isWs, clean, hash } = RBC.util;

  // --- 이 파일이 소유하는 상태 ---
  let units = [];

  // 가변 청킹 파라미터. CFG 의 네 값은 초기 기본값으로만 쓴다.
  const chunkOpts = {
    target: CFG.TARGET_CHARS,
    min: CFG.MIN_CHARS,
    max: CFG.MAX_CHARS,
    minUnit: CFG.MIN_UNIT_CHARS,
  };

  // 1-stream 소유 상태의 지역 거울. 청킹 루프가 글자 단위로 수만 번 읽기
  // 때문에 매번 접근자 함수를 타면 느려진다. commit 직후 syncStream() 으로만 갱신.
  let raw = '', sig = new Int32Array(1), breaks = new Set();
  function syncStream() {
    raw = RBC.stream.raw();
    sig = RBC.stream.sig();
    breaks = RBC.stream.breaks();
  }

  // 5-recorder 소유 recording 의 읽기 전용 미러.
  // rescan 이 "기록 중이면 기존 pid 를 보존해야 한다"를 판단하는 데만 쓴다.
  let recording = false;
  bus.on('record:started', () => { recording = true; });
  bus.on('record:stopped', () => { recording = false; });

  const SENT_END = new Set(['.', '!', '?', '…', '。', '！', '？']);
  const PATH_MAX = 6;

  // ==========================================================================
  // 청킹
  // ==========================================================================
  function isSentenceBoundary(i) {
    if (i <= 0 || i > raw.length) return false;
    if (!SENT_END.has(raw[i - 1])) return false;
    return i === raw.length || isWs(raw[i]) || raw[i] === '"' || raw[i] === '”';
  }

  function chunkFrom(fromRaw, existing) {
    const out = existing ? existing.slice() : [];
    const N = raw.length;
    let pos = fromRaw;
    while (pos < N && isWs(raw[pos])) pos++;

    const push = (a, b) => {
      const t = clean(raw.slice(a, b));
      if (!t) return;
      if (t.length < chunkOpts.minUnit && out.length) {
        const prev = out[out.length - 1];        // 잔여물은 앞 유닛에 흡수
        prev.end = b;
        prev.text = clean(raw.slice(prev.start, prev.end));
        prev.charLen = prev.text.length;
        return;
      }
      if (t.length < chunkOpts.minUnit) return;
      out.push({ start: a, end: b, text: t, charLen: t.length });
    };

    while (pos < N) {
      const base = sig[pos];
      if (sig[N] - base <= chunkOpts.min) { push(pos, N); break; }

      let cutHard = -1, cutSent = -1, cutWs = -1, forced = -1;
      const target = base + chunkOpts.target;
      const better = (cur, cand) =>
        cur === -1 || Math.abs(sig[cand] - target) < Math.abs(sig[cur] - target) ? cand : cur;

      for (let i = pos + 1; i <= N; i++) {
        const s = sig[i] - base;
        if (s < chunkOpts.min) continue;
        if (s > chunkOpts.max) { forced = i - 1; break; }
        if (breaks.has(i)) cutHard = better(cutHard, i);
        if (isSentenceBoundary(i)) cutSent = better(cutSent, i);
        if (isWs(raw[i - 1]) && !isWs(raw[i])) cutWs = better(cutWs, i);
      }

      let cut = cutHard !== -1 ? cutHard
        : cutSent !== -1 ? cutSent
          : cutWs !== -1 ? cutWs
            : forced !== -1 ? forced : N;
      if (cut <= pos) cut = Math.min(pos + 1, N);

      push(pos, cut);
      pos = cut;
      while (pos < N && isWs(raw[pos])) pos++;
    }
    return out;
  }

  function assignIds(list) {
    const seen = new Map();
    list.forEach((u, i) => {
      const base = 'u' + hash(u.text.slice(0, 160));
      const c = (seen.get(base) || 0) + 1;
      seen.set(base, c);
      u.pid = c === 1 ? base : base + '_' + c;   // 같은 문장이 두 번 나오면 _2
      u.order = i;
    });
    return list;
  }

  // ==========================================================================
  // 조각 (v3)
  // ==========================================================================

  // 원문 스트림 위치 p → 유닛 u 의 text 안 오프셋.
  function textOff(u, p) {
    const q = p < u.start ? u.start : p > u.end ? u.end : p;
    const o = sig[q] - sig[u.start];
    return o < u.charLen ? o : u.charLen;
  }

  // start <= p 인 마지막 seg 의 번호. 없으면 -1.
  function segIndexAt(segs, p) {
    let lo = 0, hi = segs.length - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (segs[m].start <= p) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return ans;
  }

  function pathOf(blk, root) {
    const path = [];
    if (!blk || !root || blk === root || !root.contains(blk)) return { path, cut: false };
    let el = blk;
    while (el && el !== root) {
      if (path.length === PATH_MAX) return { path, cut: true };
      path.push(RBC.stream.attrs(el));
      el = el.parentElement;
    }
    return { path, cut: false };
  }

  function buildPieces(u, segs, root) {
    const runs = [];
    let cur = null;
    for (let i = Math.max(segIndexAt(segs, u.start), 0); i < segs.length; i++) {
      const s = segs[i];
      if (s.start >= u.end) break;
      if (s.start + s.len <= u.start) continue;
      const oa = textOff(u, Math.max(s.start, u.start));
      const ob = textOff(u, Math.min(s.start + s.len, u.end));
      if (!cur || s.blk !== cur.blk) {
        cur = { blk: s.blk, off: oa, end: ob, link: 0 };
        runs.push(cur);
      } else {
        cur.end = ob;
      }
      if (s.link) cur.link += ob - oa;
    }
    // 끝 공백만 있던 조각은 trim 으로 0글자가 된다 → 뺀다 (off 연결은 유지됨)
    return runs.filter(r => r.end > r.off).map((r) => {
      const { path, cut } = pathOf(r.blk, root);
      return { off: r.off, chars: r.end - r.off, linkChars: r.link, path, pathCut: cut };
    });
  }

  function fillPieces(list) {
    const segs = RBC.stream.segs();
    const root = RBC.stream.root();
    for (const u of list) {
      if (u.pieces && u.piecesEnd === u.end) continue;   // 기존 값 유지
      u.pieces = buildPieces(u, segs, root);
      u.piecesEnd = u.end;
    }
    return list;
  }

  // ==========================================================================
  // 재스캔
  //   기록 중에는 기존 pid 를 절대 재배정하지 않는다.
  //   순수 append 면 꼬리만 청킹하고, 본문이 교체됐으면 아예 건드리지 않는다.
  //   사라진 노드는 segFor 미스 → 해당 틱은 null. 틀린 데이터보다 결측이 낫다.
  // ==========================================================================
  function rescan(opts) {
    const preserve = opts && opts.preserve;
    const built = RBC.stream.build();

    if (preserve && recording && units.length) {
      if (built.raw.startsWith(RBC.stream.raw())) {
        const tailFrom = RBC.stream.len();
        RBC.stream.commit(built);
        syncStream();
        const kept = units.map(u => ({ ...u }));
        units = fillPieces(assignIds(chunkFrom(tailFrom, kept)));
        bus.emit('units:rescanned', { mode: 'append', count: units.length });
      } else {
        bus.emit('units:rescanned', { mode: 'disruptive-skipped', count: units.length });
        return units.length;
      }
    } else {
      RBC.stream.commit(built);
      syncStream();
      units = fillPieces(assignIds(chunkFrom(0, null)));
      bus.emit('units:rescanned', { mode: 'full', count: units.length });
    }

    bus.emit('units:changed', { count: units.length });
    return units.length;
  }

  // ==========================================================================
  // 조회
  // ==========================================================================
  function unitAtStreamPos(p) {
    if (p < 0 || !units.length) return null;
    let lo = 0, hi = units.length - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (units[m].start <= p) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    if (ans < 0) return null;
    const u = units[ans];
    return p < u.end ? u : null;
  }

  // ==========================================================================
  // 구독
  // ==========================================================================

  // 스캔은 primary 가 아닌 프레임도 돈다 — primary 선출의 근거가 유닛 개수라서.
  bus.on('cmd:scan', () => {
    const n = rescan({});
    bus.emit('units:scanned', { count: n, chars: RBC.stream.len() });
  });

  // 기록 중 차단은 6-frames 와 9-panel 양쪽에 있다. 여기는 계산만 한다.
  bus.on('cmd:chunk', (m) => {
    chunkOpts.target = m.target;
    chunkOpts.min = Math.round(m.target * 0.55);
    chunkOpts.max = Math.round(m.target * 1.7);
    rescan({});
  });

  bus.on('cmd:list', () => {
    bus.emit('units:list', units.map(u => ({
      order: u.order, pid: u.pid, charLen: u.charLen, text: u.text.slice(0, 44),
    })));
  });

  // ==========================================================================
  // 공개
  // ==========================================================================
  RBC.units = {
    all: () => units,
    count: () => units.length,
    at: unitAtStreamPos,
    byPid: (pid) => units.find(u => u.pid === pid),
    rescan,
    textOff,                             // (unit, 원문 위치) → unit.text 오프셋
    opts: () => ({ ...chunkOpts }),      // 복사본. 밖에서 못 바꾼다.
  };
})();