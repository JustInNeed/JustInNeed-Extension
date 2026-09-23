/* =============================================================================
 * 3-hittest.js — 좌표 → 유닛
 *
 * 소유: rootBox (본문 영역의 가로 범위 캐시)
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
      const rect = charRectAt(n, r.startOffset);
      if (!rect) continue;
      const dy = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0);
      if (dy > tol) continue;
      const u = RBC.units.at(seg.start + r.startOffset);
      if (u) return u;
    }
    return null;
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
    const rect = charRectAt(n, r.startOffset);
    if (!rect) return null;
    const T = CFG.CURSOR_TOL;
    if (x < rect.left - T || x > rect.right + T || y < rect.top - T || y > rect.bottom + T)
      return null;
    return RBC.units.at(seg.start + r.startOffset);
  }

  // [C4] 선택 범위가 걸친 유닛 전부. 명세: "여러 문단 걸치면 모두 1".
  function unitsFromSelection(sel) {
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
      if (u.start < hi && u.end > lo) out.push(u.pid);
      else if (lo === hi && u.start <= lo && lo < u.end) out.push(u.pid);
    }
    return out;
  }

  // ==========================================================================
  // 틱 1회분 샘플
  //   틱마다 필요한 DOM 조회를 여기 한 번에 모은다. 5-recorder 는 이 결과만
  //   받아 쓰고 DOM 을 직접 읽지 않는다 — 측정과 기록을 갈라놓기 위해서다.
  // ==========================================================================
  function sample(cursor) {
    ensureRootBox();
    const centerU = atCenterLine();
    const [visTop, visBot] = visibleRange();
    const cursorU = cursor ? atCursor(cursor.x, cursor.y) : null;
    return { centerU, visTop, visBot, cursorU };
  }

  // ==========================================================================
  // 무효화
  //   스크롤·리사이즈는 4-input 이 직접 부른다(아래 방향이라 허용).
  //   재청킹은 사실 통보라 버스로 온다.
  // ==========================================================================
  function invalidate() { rootBox = null; }

  bus.on('units:changed', invalidate);

  // ==========================================================================
  // 공개
  // ==========================================================================
  RBC.hittest = {
    sample,
    unitsFromSelection,
    streamPosOf,
    locate,                 // 8-overlay 의 rangeForUnit 이 쓴다
    invalidate,
    // 개별 조회 — 디버깅·추후 사용
    atCenterLine,
    atCursor,
    visibleRange,
  };
})();