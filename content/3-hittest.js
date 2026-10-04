/* =============================================================================
 * 3-hittest.js — 좌표 → 유닛
 *
 * 소유: rootBox (본문 영역의 가로 범위 캐시), pieceRanges (조각 Range 캐시), sampleMs (측정 시간)
 * 의존(직접 호출): 0-core, 1-stream, 2-units
 * 발행: 없음
 * 구독: units:changed
 *
 * --- 이 레이어가 하는 일 ----------------------------------------------------
 *   화면의 한 점을 찍어서 "거기 어느 유닛이 있나"를 답한다.
 *   유닛이 DOM 요소가 아니라 글자 범위라서 elementFromPoint 를 못 쓴다.
 *   caretRangeFromPoint 로 텍스트 노드+오프셋을 얻고, 1-stream 의 인덱스로
 *   스트림 오프셋을 구한 뒤, 2-units 에 물어본다.
 *
 *   이 파일이 페이지의 DOM 을 읽는 유일한 hot path 다. 틱마다 돈다.
 *
 * --- 두 채널 ---------------------------------------------------------------
 *   A채널 = 커서 밑 유닛.   커서가 실제로 글자 위에 있을 때만 귀속.
 *                           여백·이미지·sticky 위면 null (결측이 맞다).
 *   B채널 = 뷰포트 49% 중앙선 유닛. GVAM 가정. 정지 독서 중에도 체류가 쌓인다.
 *
 *   [C1] visibleRange 는 체류시간(뷰포트 노출 누적)용. 유닛이 DOM 요소가 아니라
 *        IntersectionObserver 를 못 쓰므로, 뷰포트 상/하단을 찔러 유닛 order
 *        범위를 얻는다. 유닛은 문서 순서대로 연속이라 양끝만 알면 사이는 전부 노출.
 *
 * --- 허용 오차가 비대칭인 이유 ----------------------------------------------
 *   CENTER_Y_TOL(44px) > EDGE_Y_TOL(8px).
 *   중앙선은 여백에 걸려도 가까운 유닛을 잡아야 하고(안 그러면 문단 사이 공백에서
 *   체류가 끊긴다), 가장자리 탐색은 "실제로 보이는 것"이어야 해서 엄격하다.
 *   이 차이 때문에 한 틱만 보면 centerPid 가 visTop..visBot 밖으로 나갈 수 있다.
 *   정상이다. 누적하면 노출시간 >= 체류시간이 성립한다 (check_session.py [8]).
 *
 * --- vis (v3, 감사 §8-1) -----------------------------------------------------
 *   그 틱에 뷰포트와 겹친 유닛 조각 [pid, k, top, bottom, left, right] (자기 프레임 뷰포트 CSS px,
 *   반올림, 자르지 않음). 조각마다 Range 하나의 getBoundingClientRect(). 유닛 외곽을 안 쓰는 이유:
 *   "짧은 문단 + 캡션 + 다음 문단" 유닛이면 사이의 사진까지 덮어 노출이 부풀려진다.
 *   order 가 세로 순서가 아니라서(사이드바) 매 틱 전 조각을 본다.
 *   Range 객체는 units:changed 때 만들고 재사용한다 (live Range 라 DOM 변화를 따라간다).
 *   크기 0 인 조각(숨김 · DOM 에서 빠짐)은 bottom > 0 조건에서 자동으로 빠진다.
 *   sample() 전체 시간을 최근 SAMPLE_WINDOW 틱 보관 → 패널 p95 (> 10ms 면 캐시 방식 검토).
 *
 * --- 성능 주의 (PERF-1) ------------------------------------------------------
 *   최악의 경우 한 틱에 caretRangeFromPoint 가 37회 불린다
 *   (visibleRange 위/아래 각 EDGE_STEPS(8) × nx(2) = 32, 중앙선 5).
 *   정상 텍스트 화면에서는 첫 시도에 맞아 4~6회로 끝나지만, 본문 중간의 큰 이미지
 *   구간·광고 구간에서는 전부 실패하고 32회를 다 돈다.
 *   caretRangeFromPoint 는 히트 테스트라 레이아웃을 강제한다.
 *   측정하려면 sample() 앞뒤를 performance.now() 로 감쌀 것. 여기 한 곳만 보면 된다.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus } = RBC;

  // --- 이 파일이 소유하는 상태 ---
  // 본문 영역의 left/width. 매 탐침마다 getBoundingClientRect 를 부르면
  // 틱마다 강제 레이아웃이 수십 번 일어나므로 캐시한다.
  // 스크롤·리사이즈·재청킹 때 무효화된다.
  let rootBox = null;
  let pieceRanges = null;          // [{ pid, k, r: Range }] — units:changed 때 버림
  const SAMPLE_WINDOW = 200;
  const sampleMs = [];
  const visMs = [];                // 그중 vis(조각 사각형) 몫 — 탐침이 먼저 레이아웃을 확정하므로 순수 측정 비용

  // ==========================================================================
  // 기본 조회
  // ==========================================================================
  function caretAt(x, y) {
    try {
      if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (!p) return null;
        const r = document.createRange();
        r.setStart(p.offsetNode, p.offset);
        r.collapse(true);
        return r;
      }
    } catch (e) { /* noop */ }
    return null;
  }

  // raw 오프셋 → {node, offset}.  8-overlay 의 rangeForUnit 이 쓴다.
  function locate(streamPos) {
    const segs = RBC.stream.segs();
    if (!segs.length) return null;
    let lo = 0, hi = segs.length - 1, ans = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (segs[m].start <= streamPos) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    const s = segs[ans];
    if (!s) return null;
    return { node: s.node, offset: Math.max(0, Math.min(streamPos - s.start, s.len)) };
  }

  // {node, offset} → raw 오프셋.  -1 이면 본문 스트림 밖이다.
  function streamPosOf(node, offset) {
    if (!node || node.nodeType !== 3) return -1;
    const seg = RBC.stream.segFor(node);
    if (!seg) return -1;
    return seg.start + Math.max(0, Math.min(offset, seg.len));
  }

  // 디버그 패널 위의 좌표·선택은 수집 대상이 아니다.
  function inPanel(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('#' + CFG.PANEL_ID));
  }

  // caret 이 텍스트 노드 끝(offset = 길이)에 오면 — 줄 끝 오른쪽 여백을 찔렀을 때 —
  // 실제로 맞은 글자는 마지막 글자다. 사각형도 유닛도 그 글자로 판정해야 한다.
  // 전에는 사각형은 마지막 글자로 보고 유닛은 seg.start + 길이 로 찾아서, 노드가 유닛의
  // 마지막 글자로 끝나면 **다음 유닛**이 잡혔다 (2026-10-03, vis 교차검사 [14] 로 발견).
  function hitOffset(node, offset) {
    const L = node.data.length;
    return offset >= L ? Math.max(0, L - 1) : Math.max(0, offset);
  }

  function charRectAt(node, offset) {
    const L = node.data.length;
    if (!L) return null;
    let a = Math.min(offset, L - 1); if (a < 0) a = 0;
    const r = document.createRange();
    try { r.setStart(node, a); r.setEnd(node, Math.min(a + 1, L)); } catch (e) { return null; }
    const rect = r.getBoundingClientRect();
    return (rect.width || rect.height) ? rect : null;
  }

  function ensureRootBox() {
    if (rootBox) return;
    const root = RBC.stream.root();
    if (!root) return;
    const b = root.getBoundingClientRect();
    rootBox = { left: b.left, width: b.width || window.innerWidth };
  }

  // ==========================================================================
  // 뷰포트 세로 y 를 지나는 유닛.  nx = 가로로 찔러볼 지점 수.
  //   본문 폭 안에서만 찌른다. 사이드바나 여백을 찔러봐야 본문 유닛이 안 나온다.
  // ==========================================================================
  function unitAtViewportY(y, tol, nx) {
    ensureRootBox();
    const left = rootBox ? rootBox.left : 0;
    const width = rootBox ? rootBox.width : window.innerWidth;
    const fr = [0.5, 0.3, 0.7, 0.15, 0.85].slice(0, nx || 5);
    for (const f of fr) {
      const x = left + width * f;
      if (x < 0 || x > window.innerWidth) continue;
      const r = caretAt(x, y);
      if (!r) continue;
      const n = r.startContainer;
      if (n.nodeType !== 3 || inPanel(n)) continue;
      const seg = RBC.stream.segFor(n);
      if (!seg) continue;
      const off = hitOffset(n, r.startOffset);
      const rect = charRectAt(n, off);
      if (!rect) continue;
      const dy = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0);
      if (dy > tol) continue;
      const u = RBC.units.at(seg.start + off);
      if (u) return u;
    }
    return null;
  }

  // ==========================================================================
  // vis — 뷰포트와 겹친 조각
  // ==========================================================================
  // 조각 끝 위치는 "마지막 글자의 뒤"로 잡는다. locate(b) 는 b 가 seg 경계면 다음 노드의
  // offset 0 을 주는데, 그러면 Range 가 다음 DOM 블록에 닿아 사각형이 늘어날 수 있다.
  function locateEnd(p) {
    const L = locate(p - 1);
    return L ? { node: L.node, offset: Math.min(L.offset + 1, L.node.data.length) } : null;
  }

  function buildPieceRanges() {
    const out = [];
    for (const u of RBC.units.all()) {
      const spans = u.spans || [];
      for (let k = 0; k < spans.length; k++) {
        const a = locate(spans[k][0]);
        const b = locateEnd(spans[k][1]);
        if (!a || !b) continue;
        const r = document.createRange();
        try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); } catch (e) { continue; }
        out.push({ pid: u.pid, k, r });
      }
    }
    return out;
  }

  function visPieces() {
    if (!pieceRanges) pieceRanges = buildPieceRanges();
    const vw = window.innerWidth, vh = window.innerHeight;
    const out = [];
    for (const p of pieceRanges) {
      const b = p.r.getBoundingClientRect();
      if (b.bottom > 0 && b.top < vh && b.right > 0 && b.left < vw) {
        out.push([p.pid, p.k, Math.round(b.top), Math.round(b.bottom),
          Math.round(b.left), Math.round(b.right)]);
      }
    }
    return out;
  }

  // 최근 SAMPLE_WINDOW 틱의 sample() 시간. 패널 표시용.
  function stats() {
    const n = sampleMs.length;
    if (!n) return { p95: 0, max: 0, n: 0, visP95: 0, pieces: 0 };
    const r1 = v => Math.round(v * 10) / 10;
    const p95 = (arr) => {
      const a = arr.slice().sort((x, y) => x - y);
      return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
    };
    return {
      p95: r1(p95(sampleMs)), max: r1(Math.max(...sampleMs)), n,
      visP95: r1(p95(visMs)),                       // vis 몫만
      pieces: pieceRanges ? pieceRanges.length : 0, // 매 틱 재는 조각 수
    };
  }

  // B채널: GVAM 중앙선
  function atCenterLine() {
    return unitAtViewportY(window.innerHeight * CFG.CENTER_RATIO, CFG.CENTER_Y_TOL, 5);
  }

  // [C1] 뷰포트에 실제로 보이는 유닛 범위 [최상단 order, 최하단 order].
  //      가장자리가 이미지·여백이면 안쪽으로 조금씩 들어가며 첫 텍스트를 찾는다.
  function visibleRange() {
    const H = window.innerHeight;
    const step = H / CFG.EDGE_STEPS;
    let top = null, bot = null;
    for (let i = 0; i < CFG.EDGE_STEPS && !top; i++) {
      top = unitAtViewportY(4 + i * step, CFG.EDGE_Y_TOL, 2);
    }
    for (let i = 0; i < CFG.EDGE_STEPS && !bot; i++) {
      bot = unitAtViewportY(H - 4 - i * step, CFG.EDGE_Y_TOL, 2);
    }
    return [top ? top.order : null, bot ? bot.order : null];
  }

  // A채널: 커서. 실제로 글자 위에 있을 때만 귀속.
  function atCursor(x, y) {
    const r = caretAt(x, y);
    if (!r) return null;
    const n = r.startContainer;
    if (n.nodeType !== 3 || inPanel(n)) return null;
    const seg = RBC.stream.segFor(n);
    if (!seg) return null;
    const off = hitOffset(n, r.startOffset);
    const rect = charRectAt(n, off);
    if (!rect) return null;
    const T = CFG.CURSOR_TOL;
    if (x < rect.left - T || x > rect.right + T || y < rect.top - T || y > rect.bottom + T)
      return null;
    return RBC.units.at(seg.start + off);
  }

  // [C4] 선택 범위가 걸친 유닛 전부 + 유닛마다 자기 text 안 범위 (v3 ranges, 감사 §8-5).
  //   명세: "여러 문단 걸치면 모두 1". → [[pid, lo, hi], …] (유닛 order 순, lo < hi).
  //   lo/hi 는 유닛 text(공백 정리 뒤, UTF-16) 오프셋 — pieces 와 같은 변환(RBC.units.textOff).
  //   정리 뒤 0글자가 되는 걸침(앞 유닛의 끝 공백만 잡힌 경우, 빈 선택)은 뺀다.
  function rangesFromSelection(sel) {
    if (!sel || sel.rangeCount === 0) return [];
    let r;
    try { r = sel.getRangeAt(0); } catch (e) { return []; }
    let a = streamPosOf(r.startContainer, r.startOffset);
    let b = streamPosOf(r.endContainer, r.endOffset);
    if (a < 0 && b < 0) return [];      // 양끝 다 본문 밖 → 귀속할 유닛 없음
    if (a < 0) a = b;
    if (b < 0) b = a;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const out = [];
    for (const u of RBC.units.all()) {
      if (!(u.start < hi && u.end > lo)) continue;
      const tl = RBC.units.textOff(u, Math.max(lo, u.start));
      const th = RBC.units.textOff(u, Math.min(hi, u.end));
      if (th > tl) out.push([u.pid, tl, th]);
    }
    return out;
  }

  // ==========================================================================
  // 틱 1회분 샘플
  //   틱마다 필요한 DOM 조회를 여기 한 번에 모은다. 5-recorder 는 이 결과만
  //   받아 쓰고 DOM 을 직접 읽지 않는다 — 측정과 기록을 갈라놓기 위해서다.
  // ==========================================================================
  function sample(cursor) {
    const t0 = performance.now();
    ensureRootBox();
    const centerU = atCenterLine();
    const [visTop, visBot] = visibleRange();
    const cursorU = cursor ? atCursor(cursor.x, cursor.y) : null;
    const t1 = performance.now();
    const vis = visPieces();
    const t2 = performance.now();
    sampleMs.push(t2 - t0);
    visMs.push(t2 - t1);
    if (sampleMs.length > SAMPLE_WINDOW) { sampleMs.shift(); visMs.shift(); }
    return { centerU, visTop, visBot, cursorU, vis };
  }

  // ==========================================================================
  // 무효화
  //   스크롤·리사이즈는 4-input 이 직접 부른다(아래 방향이라 허용).
  //   재청킹은 사실 통보라 버스로 온다.
  // ==========================================================================
  function invalidate() { rootBox = null; }

  // 4-input 은 스크롤마다 invalidate() 를 부르므로 조각 Range 는 여기서만 버린다.
  bus.on('units:changed', () => { rootBox = null; pieceRanges = null; });

  // ==========================================================================
  // 공개
  // ==========================================================================
  RBC.hittest = {
    sample,
    rangesFromSelection,
    streamPosOf,
    locate,                 // 8-overlay 의 rangeForUnit 이 쓴다
    invalidate,
    stats,                  // { p95, max, n } — sample() ms, 패널 표시
    visPieces,
    // 개별 조회 — 디버깅·추후 사용
    atCenterLine,
    atCursor,
    visibleRange,
  };
})();