/* =============================================================================
 * 2-units.js — 청킹 · pid 부여 · 재스캔
 *
 * 소유: units, retired(기록 중 사라진 유닛), chunkOpts(가변 청킹 파라미터), 스트림 지역 거울(raw/sig/breaks)
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
 *   u.spans  = 조각마다 원문 구간 [a, b) (pieces 와 같은 순서). 내부용 — 3-hittest 가 조각
 *              Range(vis 사각형)를 만들 때 쓴다. paragraphs() 가 필드를 골라 내보내므로 JSON 에 안 나감.
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
 * --- 기록 중 본문이 바뀌면: splice (0-B, 2026-10-08) -----------------------------
 *   전: 기록 중 재스캔에서 새 스트림이 옛 스트림의 단순 연장(append)이 아니면 아무것도 안 바꾸고
 *   'disruptive-skipped' 만 남겼다 → 그 세션은 학습 제외. 노션 코드 블록처럼 본문 중간이 늦게
 *   렌더되는 흔한 패턴에서 세션이 통째로 버려졌다.
 *   지금: 옛 · 새 스트림의 공통 앞부분 P 와 공통 뒷부분 S 를 찾아
 *     - 앞부분에 완전히 든 유닛(end ≤ P)은 그대로 (pid · 오프셋 불변)
 *     - 뒷부분에 완전히 든 유닛(start ≥ 옛길이 − S)은 pid 그대로, 오프셋만 delta 이동
 *     - 그 사이만 새 스트림에서 다시 청킹 [a, E). E = 첫 뒷부분 유닛의 새 시작 → 경계가 강제로 맞물린다
 *     - 다시 청킹한 유닛의 글이 옛 유닛과 같으면 pid 도 같다(pid = 글 해시). 다르면 새 pid.
 *     - 옛 유닛 중 새 목록에 없는 것 = retired. 버리지 않고 남긴다 — timeline 이 이미 그 pid 를
 *       참조하고 있어서 meta.paragraphs 에 없으면 pid 정합성이 깨진다.
 *   order: 살아 있는 유닛 0..n-1, retired 는 그 뒤 n.. (paragraphs 전체가 0..N-1 연속 — [7]).
 *   한계: 바뀐 곳이 여러 군데면 첫 변경 ~ 마지막 변경 사이를 한 덩어리로 다시 청킹한다. 그 사이의
 *   변하지 않은 문단도 경계가 같게 잘리면 같은 pid, 아니면 새 pid 가 된다.
 *   벽(1-stream walls, 2026-10-08): 부모가 다른 블록 사이는 합치지 않는다. 노션 토글을 열면 새 블록이
 *   다른 부모 아래 끼므로 기존 유닛(토글 제목 등)은 글이 그대로 → pid 그대로, 새 블록만 새 유닛이 된다.
 *   전에는 짧은 토글 제목 여러 개가 한 유닛으로 합쳐져 있다가, 사이에 토글 내용이 끼면 그 유닛 글이 바뀌어
 *   같은 글이 두 버전(32자 · 210자)으로 두 줄 남았다. 대가: 벽마다 끊기니 짧은 유닛(제목 한 줄 등)이 생긴다.
 *   사라진 유닛에는 after(사라질 때 바로 앞 유닛 pid)를 남긴다 — 글 순서 복원용.
 *
 * --- 끼어든 글 둘레 벽 · 이름 이어받기 (일반 사이트, 2026-10-08) -------------------------
 *   벽이 없는 일반 사이트에서 합쳐진 유닛 한가운데로 글이 끼면(본문 중간 광고 · 늦은 렌더), 그 유닛이 다시 잘려
 *   같은 글이 두 버전으로 남았다(시험 글 시뮬레이션: [P4] 가 두 유닛에). 이제
 *     (1) 바뀐 구간을 문단 경계까지 넓혀 양끝에 벽(dynWalls)을 세운다 → 끼어든 글은 따로 유닛, 앞뒤 글은 그 벽에서 끊긴다.
 *         끼어든 글이 다시 빠져도 벽이 남아 앞뒤 유닛 경계가 그대로 → 같은 유닛 · 같은 pid.
 *     (2) 다시 자른 첫 유닛이 옛 유닛과 같은 자리에서 시작하면 옛 pid 를 이어받는다(같은 글 덩어리의 앞부분).
 *   대가: 이어받은 유닛은 옛 유닛보다 짧아질 수 있고, 옛 유닛의 그 전 틱은 이 유닛 몫이 된다(조금 넓게 귀속).
 *   전에 우연히 비슷하게 동작한 경우가 있었다 — pid 가 글 앞 160자 해시라 뒷부분만 바뀌면 같은 pid 가 나왔다.
 *   이제 그건 우연이 아니라 규칙이다.
 *   단, 문단 안쪽 변경(인라인 광고 · 글자 수정)이 옛 유닛 하나 안에서 끝나면 나누지 않고 그 유닛을 제자리에서 고친다
 *   (pid · 경계 그대로, 글만 바뀜 — 이벤트 inline: true). 문단을 통째로 끼우거나 뺄 때만 위 벽 방식을 쓴다.
 *   전: 광고가 P8 문장에 끼자 [P5-P8] 이 [P5-P7] + [P8 광고] 로 쪼개졌다(2026-10-08 실측).
 *   pid 가 유지된 유닛의 조각(pieces)은 다시 계산될 수 있다(뒷부분 유닛은 항상) — 그 전 틱의 vis 조각
 *   번호 k 는 옛 조각 기준. 같은 글이면 조각 구성도 대개 같다.
 *   자체 검증 check = [bad, uncover] (selfCheck). [0, 0] = 유닛이 새 원문을 빈틈 · 겹침 없이 정확히 덮음.
 *   ※ "처음부터 다시 자른 결과"와는 일부러 다르다 — 짧은 문단이 합쳐지는 글에서 중간 삽입 뒤를 전부 다시 자르면
 *     뒤 유닛 경계가 전부 밀려 pid 가 대부분 바뀐다(node 시뮬레이션: 12문단 중 7개). 그걸 막는 게 splice 다.
 *   rootChanged: build() 가 루트를 다른 요소로 골랐다 = 기록 영역이 바뀜. 데이터가 섞이므로 [6] FAIL.
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
  let retired = [];               // 기록 중 splice 로 사라진 유닛 (export 용, 전체 재스캔 때 비움)

  // 가변 청킹 파라미터. CFG 의 네 값은 초기 기본값으로만 쓴다.
  const chunkOpts = {
    target: CFG.TARGET_CHARS,
    min: CFG.MIN_CHARS,
    max: CFG.MAX_CHARS,
    minUnit: CFG.MIN_UNIT_CHARS,
  };

  // 1-stream 소유 상태의 지역 거울. 청킹 루프가 글자 단위로 수만 번 읽기
  // 때문에 매번 접근자 함수를 타면 느려진다. commit 직후 syncStream() 으로만 갱신.
  let raw = '', sig = new Int32Array(1), breaks = new Set(), walls = [];
  let siteWalls = [];             // 1-stream 이 준 벽 (노션 토글 둘레)
  let dynWalls = [];              // 기록 중 끼어든 글 둘레에 세운 벽 (splice, 전체 재스캔 때 비움)
  function syncStream() {
    raw = RBC.stream.raw();
    sig = RBC.stream.sig();
    breaks = RBC.stream.breaks();
    siteWalls = RBC.stream.walls ? RBC.stream.walls() : [];
    mergeWalls();
  }

  function mergeWalls() {
    walls = dynWalls.length
      ? [...new Set(siteWalls.concat(dynWalls))].filter(w => w > 0 && w < raw.length).sort((x, y) => x - y)
      : siteWalls;
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

  // toRaw: 여기서 끊는다(splice 의 E). 생략하면 끝까지.
  // 벽(1-stream 헤더): 청킹은 벽을 넘지 않는다. 벽 사이 구간마다 따로 200자 언저리로 자르고,
  //   벽 바로 앞 짧은 꼬리(15자 미만)도 벽 너머로 붙이지 않고 그 자체로 유닛이 된다(노션 토글 제목 등).
  //   그래서 벽 안쪽 글이 그대로면 다시 잘라도 같은 유닛 · 같은 pid 가 나온다.
  function nextWall(p, N) {
    let lo = 0, hi = walls.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (walls[m] <= p) lo = m + 1; else hi = m; }
    return lo < walls.length && walls[lo] < N ? walls[lo] : N;
  }

  // toRaw: 여기서 끊는다(splice 의 E). 생략하면 끝까지.
  function chunkFrom(fromRaw, existing, toRaw) {
    const out = existing ? existing.slice() : [];
    const N = toRaw == null ? raw.length : toRaw;
    let pos = fromRaw;
    let segStart = pos;                          // 지금 벽 구간의 시작 — 잔여물 흡수는 이 안에서만

    const push = (a, b) => {
      const t = clean(raw.slice(a, b));
      if (!t) return;
      if (t.length < chunkOpts.minUnit) {
        const prev = out.length ? out[out.length - 1] : null;
        // 벽이 없는 페이지(일반 사이트)는 예전 그대로: 앞 유닛에 흡수, 앞 유닛이 없으면 버림.
        // 벽이 있는 페이지(노션)는 같은 벽 구간 안에서만 흡수하고, 아니면 짧아도 그대로 유닛.
        if (prev && (!walls.length || prev.start >= segStart)) {
          prev.end = b;
          prev.text = clean(raw.slice(prev.start, prev.end));
          prev.charLen = prev.text.length;
          return;
        }
        if (!walls.length) return;
      }
      out.push({ start: a, end: b, text: t, charLen: t.length });
    };

    while (pos < N) {
      while (pos < N && isWs(raw[pos])) pos++;
      if (pos >= N) break;
      const W = nextWall(pos, N);                // 이 벽 구간의 끝
      segStart = pos;
      while (pos < W) {
        const base = sig[pos];
        if (sig[W] - base <= chunkOpts.min) { push(pos, W); pos = W; break; }

        let cutHard = -1, cutSent = -1, cutWs = -1, forced = -1;
        const target = base + chunkOpts.target;
        const better = (cur, cand) =>
          cur === -1 || Math.abs(sig[cand] - target) < Math.abs(sig[cur] - target) ? cand : cur;

        for (let i = pos + 1; i <= W; i++) {
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
              : forced !== -1 ? forced : W;
        if (cut <= pos) cut = Math.min(pos + 1, W);

        push(pos, cut);
        pos = cut;
        while (pos < W && isWs(raw[pos])) pos++;
      }
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
      const ra = Math.max(s.start, u.start), rb = Math.min(s.start + s.len, u.end);
      const oa = textOff(u, ra);
      const ob = textOff(u, rb);
      if (!cur || s.blk !== cur.blk) {
        cur = { blk: s.blk, off: oa, end: ob, link: 0, ra, rb };
        runs.push(cur);
      } else {
        cur.end = ob;
        cur.rb = rb;
      }
      if (s.link) cur.link += ob - oa;
    }
    // 끝 공백만 있던 조각은 trim 으로 0글자가 된다 → 뺀다 (off 연결은 유지됨)
    const kept = runs.filter(r => r.end > r.off);
    return {
      pieces: kept.map((r) => {
        const { path, cut } = pathOf(r.blk, root);
        return { off: r.off, chars: r.end - r.off, linkChars: r.link, path, pathCut: cut };
      }),
      spans: kept.map(r => [r.ra, r.rb]),
    };
  }

  function fillPieces(list) {
    const segs = RBC.stream.segs();
    const root = RBC.stream.root();
    for (const u of list) {
      if (u.pieces && u.piecesEnd === u.end) continue;   // 기존 값 유지
      const b = buildPieces(u, segs, root);
      u.pieces = b.pieces;
      u.spans = b.spans;
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
  // 기록 중 본문 교체(disruptive-skipped) 진단 — 무엇이 바뀌었나.
  //   옛 raw 와 새 raw 가 처음 달라지는 위치와 그 앞뒤 글자를 남긴다.
  //   한 번 disruptive 가 나면 스트림을 커밋하지 않으므로 뒤 재스캔도 같은 옛 raw 와
  //   비교된다 → 원인은 첫 번째 이벤트의 diff 다.
  const DIFF_CTX = 40;
  function rawDiff(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    const clean = RBC.util.clean;
    const u = unitAtStreamPos(i);
    return {
      at: i, unit: u ? u.order : null, oldLen: a.length, newLen: b.length,
      ctx: clean(a.slice(Math.max(0, i - DIFF_CTX), i)),
      old: clean(a.slice(i, i + DIFF_CTX)),
      new: clean(b.slice(i, i + DIFF_CTX)),
    };
  }

  // 공통 앞 · 뒷부분 길이. 뒷부분은 앞부분과 겹치지 않게.
  function commonEnds(a, b) {
    const m = Math.min(a.length, b.length);
    let P = 0;
    while (P < m && a.charCodeAt(P) === b.charCodeAt(P)) P++;
    let S = 0;
    while (S < m - P && a.charCodeAt(a.length - 1 - S) === b.charCodeAt(b.length - 1 - S)) S++;
    return { P, S };
  }

  // 기록 중 본문 변경: 바뀐 구간만 다시 청킹한다 (헤더 "splice"). built 는 이미 만든 새 스트림.
  // 문단 안쪽 변경인가: 끼어든(빠진) 글의 양끝이 둘 다 문단 경계면 문단 단위 변경, 아니면 문단 안쪽(인라인 광고 · 글 수정).
  //   공통 앞부분이 끼어든 글 첫 글자와 우연히 겹칠 수 있어 P 에서 조금 앞까지 경계 쌍을 찾는다.
  function isBlockChange(P, delta, brk, len) {
    if (!delta) return false;
    const d = Math.abs(delta);
    for (let t = P; t >= Math.max(0, P - 64); t--) {
      if (brk.has(t) && (brk.has(t + d) || t + d === len)) return true;
    }
    return false;
  }

  function splice(built) {
    const oldRaw = RBC.stream.raw();
    const oldBreaks = RBC.stream.breaks();
    const diff = rawDiff(oldRaw, built.raw);          // 진단 (커밋 전 옛 유닛 기준)
    const { P, S } = commonEnds(oldRaw, built.raw);
    const oL = oldRaw.length;
    const delta = built.raw.length - oL;

    // (A) 문단 안쪽 변경이 옛 유닛 하나 안에서 끝나면: 그 유닛을 제자리에서 고친다 (pid · 경계 그대로, 글만 바뀜).
    //   광고 span 이 문장 안에 끼거나 글자가 바뀐 경우. 나누지도, 새 유닛으로 갈아끼우지도 않는다 — 같은 문단이니까.
    const pureIns = P + S === oL, pureDel = P + S === built.raw.length;
    const block = (pureIns && isBlockChange(P, delta, built.breaks, built.raw.length))
      || (pureDel && isBlockChange(P, delta, oldBreaks, oL));
    if (!block) {
      const k = units.findIndex(u => u.start <= P && oL - S <= u.end);
      if (k >= 0) {
        RBC.stream.commit(built);
        syncStream();
        dynWalls = dynWalls.map(w => (w >= oL - S ? w + delta : w));
        mergeWalls();
        const u = units[k];
        const fixed = units.map((x, i) => {
          if (i < k) return x;
          if (i === k) {
            const end = x.end + delta;
            const text = clean(raw.slice(x.start, end));
            return { ...x, end, text, charLen: text.length, pieces: null, piecesEnd: -1 };
          }
          return { ...x, start: x.start + delta, end: x.end + delta };
        });
        units = fillPieces(fixed);
        units.forEach((x, i) => { x.order = i; });
        return { diff, kept: units.length, added: 0, retired: 0, region: [u.start, u.end + delta], inline: true };
      }
    }

    let i = 0;
    while (i < units.length && units[i].end <= P) i++;          // 앞부분 유닛 [0, i)
    let j = units.length;
    while (j > i && units[j - 1].start >= oL - S) j--;          // 뒷부분 유닛 [j, n)

    const a = i < j ? Math.min(units[i].start, P) : (i > 0 ? units[i - 1].end : 0);
    const old = units;
    const head = old.slice(0, i);
    const mid = old.slice(i, j);
    const tail = old.slice(j).map(u => ({ ...u, start: u.start + delta, end: u.end + delta }));

    RBC.stream.commit(built);
    syncStream();

    // 끼어든 글 둘레에 벽 (헤더 "끼어든 글 둘레 벽"). 바뀐 구간 [P, 새길이 − S) 를 문단 경계로 넓혀 양끝에 벽.
    //   옛 벽: 바뀐 구간 앞은 그대로, 뒤는 delta 만큼 이동, 안쪽은 버림.
    //   공통 앞부분이 끼어든 글 첫 글자와 우연히 겹치면 P 가 실제 시작보다 뒤로 밀리고, 끝도 같은 만큼 밀린다
    //   ("[P4]" 앞에 "[INS-A]" 가 끼면 "[" 하나가 겹침). 그래서 끝은 (P − lo) 만큼 당겨서 문단 경계를 찾는다.
    let lo = 0;
    for (const b of breaks) if (b <= P && b > lo) lo = b;
    const insEnd = raw.length - S - (P - lo);
    let hi = raw.length;
    for (const b of breaks) if (b >= insEnd && b < hi) hi = b;
    dynWalls = dynWalls.filter(w => w <= P || w >= oL - S).map(w => (w >= oL - S ? w + delta : w))
      .concat([lo, hi]);
    mergeWalls();

    const E = tail.length ? tail[0].start : raw.length;
    const fresh = E > a ? chunkFrom(a, null, E) : [];
    // 이름 이어받기: 다시 자른 첫 유닛이 옛 유닛과 같은 자리에서 시작하면 그 pid 를 이어받는다.
    //   (끼어든 글 앞부분 = 옛 유닛의 앞부분 — 같은 글 덩어리로 본다. 옛 유닛의 그 전 틱은 이 유닛 몫이 된다.)
    //   단, 옛 유닛의 시작이 바뀐 구간보다 앞이어야 한다(그 앞부분 글이 그대로 남아 있음). 바뀐 구간에서 시작한 옛 유닛
    //   (끼어들었던 글이 빠진 경우 등)은 이어받지 않고 사라진 유닛으로 남긴다.
    const inherit = mid.length && fresh.length && fresh[0].start === mid[0].start && mid[0].start < lo
      ? mid[0].pid : null;

    // pid: 같은 글이면 같은 해시. 앞 · 뒷부분 pid 와 겹치면 _2, _3 …
    const taken = new Set(head.map(u => u.pid).concat(tail.map(u => u.pid)));
    for (const u of fresh) {
      if (inherit && u === fresh[0] && !taken.has(inherit)) { u.pid = inherit; taken.add(inherit); continue; }
      const base = 'u' + hash(u.text.slice(0, 160));
      let pid = base, c = 1;
      while (taken.has(pid)) pid = base + '_' + (++c);
      u.pid = pid;
      taken.add(pid);
    }
    const alive = new Set(fresh.map(u => u.pid));
    const gone = mid.filter(u => !alive.has(u.pid));
    // after = 사라질 때 바로 앞 유닛의 pid. 나중에 글 순서로 다시 놓을 때 쓴다(위치 번호는 그 뒤 삽입으로 밀리므로).
    const prevPid = (u) => { const k = old.indexOf(u); return k > 0 ? old[k - 1].pid : null; };
    retired = retired.filter(u => !alive.has(u.pid) && !taken.has(u.pid))
      .concat(gone.map(u => ({ ...u, retired: true, after: prevPid(u) })));

    units = fillPieces(head.concat(fresh, tail));
    units.forEach((u, k) => { u.order = k; });

    const keptMid = mid.length - gone.length;
    return {
      diff,
      kept: head.length + tail.length + keptMid,
      added: fresh.length - keptMid,
      retired: gone.length,
      region: [a, E],
    };
  }

  // splice 자체 검증 (헤더 splice). 상태는 안 바꾼다.
  //   bad      = 글이 원문 구간과 다르거나(clean(raw[start,end]) ≠ text) 앞 유닛과 겹치는 유닛 수, pid 중복 수
  //   uncover  = 어느 유닛에도 안 든 원문 글자 수(공백 제외) — 맨 앞 15자 미만 잔여물 정도만 정상
  //   둘 다 0 이면 유닛이 새 원문을 빈틈 · 겹침 없이 정확히 덮는다.
  function selfCheck() {
    let bad = 0, uncover = 0, prevEnd = 0;
    const seen = new Set();
    for (const u of units) {
      if (u.start < prevEnd) bad++;
      if (clean(raw.slice(u.start, u.end)) !== u.text) bad++;
      if (seen.has(u.pid)) bad++;
      seen.add(u.pid);
      for (let i = prevEnd; i < u.start; i++) if (!isWs(raw[i])) uncover++;
      prevEnd = Math.max(prevEnd, u.end);
    }
    for (let i = prevEnd; i < raw.length; i++) if (!isWs(raw[i])) uncover++;
    return [bad, uncover];
  }

  function rescan(opts) {
    const t0 = performance.now();                  // 재스캔 비용 측정 (이벤트 ms, 패널 · [6] 표시)
    const preserve = opts && opts.preserve;
    const prevRoot = RBC.stream.root();
    const prevSel = (RBC.stream.rootInfo() || {}).sel || null;
    const built = RBC.stream.build();
    // build() 가 루트를 다시 고른다. 기록 중 루트가 바뀌면 앞 구간과 다른 영역을 기록하게 된다 — 크게 남긴다.
    const rootChanged = !!(prevRoot && prevRoot !== RBC.stream.root());
    const rootTo = (RBC.stream.rootInfo() || {}).sel || null;

    if (preserve && recording && units.length) {
      if (!rootChanged && built.raw === RBC.stream.raw()) {
        // 글은 그대로, DOM 만 바뀜 (노션 블록 손잡이 · 호버 UI 등). 노드가 새것일 수 있으니 스트림만 교체하고
        // 유닛 · 기록은 건드리지 않는다. 전에는 이것도 append 로 처리돼 page 기록(유닛 목록 전체)을 매번 보냈다.
        RBC.stream.commit(built);
        syncStream();
        bus.emit('units:rescanned', { mode: 'same', count: units.length, root: rootTo,
          ms: Math.round(performance.now() - t0) });
      } else if (built.raw.startsWith(RBC.stream.raw())) {
        const tailFrom = RBC.stream.len();
        RBC.stream.commit(built);
        syncStream();
        const kept = units.map(u => ({ ...u }));
        units = fillPieces(assignIds(chunkFrom(tailFrom, kept)));
        bus.emit('units:rescanned', { mode: 'append', count: units.length, root: rootTo,
          ms: Math.round(performance.now() - t0) });
      } else {
        const r = splice(built);
        const chk = selfCheck();
        const ev = {
          mode: 'splice', count: units.length, diff: r.diff,
          kept: r.kept, added: r.added, retired: r.retired, inline: !!r.inline,
          check: chk, root: rootTo, ms: Math.round(performance.now() - t0),
        };
        if (rootChanged) { ev.rootChanged = true; ev.rootFrom = prevSel; }
        bus.emit('units:rescanned', ev);
      }
    } else {
      RBC.stream.commit(built);
      syncStream();
      retired = [];
      dynWalls = [];
      mergeWalls();
      units = fillPieces(assignIds(chunkFrom(0, null)));
      bus.emit('units:rescanned', { mode: 'full', count: units.length, root: rootTo,
        ms: Math.round(performance.now() - t0) });
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
    all: () => units,                    // 살아 있는 유닛만
    retired: () => retired,              // 기록 중 splice 로 사라진 유닛 (export 용)
    count: () => units.length,
    at: unitAtStreamPos,
    byPid: (pid) => units.find(u => u.pid === pid),
    rescan,
    textOff,                             // (unit, 원문 위치) → unit.text 오프셋
    opts: () => ({ ...chunkOpts }),      // 복사본. 밖에서 못 바꾼다.
  };
})();