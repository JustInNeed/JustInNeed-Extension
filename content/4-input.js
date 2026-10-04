/* =============================================================================
 * 4-input.js — DOM 이벤트 → 원시 신호
 *
 * 소유: latestCursor, 틱 사이 카운터(scroll · scrollOther · mouse · mdx · mdy · edits),
 *       scrollerEl(본문 스크롤 주체), lastSelText, winFocused, lastActivityAt, lastActivityPing
 * 의존(직접 호출): 0-core, 1-stream(root), 2-units, 3-hittest(locate) — 스크롤 주체 판정
 * 발행: sel:highlight({ranges,text}), sel:copy({ranges,text}), visibility, focus, pagehide, activity,
 *       viewport:resized
 * 구독: cmd:focus, cmd:activity
 *
 * --- 이 레이어가 하는 일 ----------------------------------------------------
 *   브라우저 이벤트를 받아 "무슨 일이 있었다"만 남긴다.
 *   timeline 에 쓰지 않는다 — 그건 5-recorder 의 일이다.
 *   전에는 onCopy / onSelectionChange / onVisibility 가 timeline.push 를
 *   직접 했는데, 그러면 기록 여부 판단이 두 파일로 흩어진다.
 *
 * --- drain() 이 왜 있나 -----------------------------------------------------
 *   전에는 tick() 이 scrollEventsSinceTick / mouseEventsSinceTick 을 읽고
 *   직접 0 으로 되돌렸다. 남의 변수를 리셋하면 "누가 언제 비웠는지"를 추적할 수
 *   없고, 나중에 틱을 둘로 나누면 카운터가 조용히 반토막 난다.
 *   이제 소유자가 읽기+리셋을 한 번에 제공하고, 부르는 쪽은 한 번만 부른다.
 *   v3: 틱을 건너뛸 때와 기록을 시작할 때도 5-recorder 가 drain() 을 부르고 값을 버린다
 *   (안 부르면 공백 동안 쌓인 값이 다음 틱에 섞인다 — 감사 §8 공통 규칙).
 *
 * --- 스크롤 (v3, 감사 §8-6) ---------------------------------------------------
 *   리스너는 document capture 하나. 요소 스크롤은 bubble 하지 않지만 capture 로는 잡힌다.
 *   window 리스너를 같이 두면 창 스크롤이 두 번 세진다.
 *   대상이 document 이거나 **첫 유닛과 마지막 유닛의 텍스트 노드를 둘 다 품은 요소**면 본문 스크롤 →
 *   scrollEvents, 그 대상을 스크롤 주체로 기억. 나머지(코드 블록 가로 · 캐러셀 · 사이드바)는
 *   scrollOther. 패널 안 스크롤은 세지 않는다. 유닛이 없으면 target.contains(root) 로 대신한다.
 *   원래 규칙(target.contains(root))은 "스크롤 상자가 루트를 품는다"는 전제였는데, 노션은 루트
 *   (main.notion-frame) **안에** 스크롤 상자가 있어서 전부 scrollOther 로 빠졌다 (2026-10-04 실측,
 *   [15] 조각 +69px vs scrollY 0). "본문 글자를 움직이는가"로 바꾸면 두 구조가 다 잡힌다.
 *   첫 스크롤 전 주체는 seedScroller(): 첫 · 마지막 유닛 텍스트 노드의 공통 조상(유닛이 없으면 루트)
 *   에서 위로 올라가 overflow-y 가 auto/scroll/overlay 이고 내용이 넘치는 첫 요소. 없으면 window(null).
 *
 * --- 커서 이동량 (v3, 감사 §8-7) · 편집 (§8-9b) --------------------------------
 *   mdx/mdy = mousemove 마다 직전 위치 대비 |dx| · |dy| 누적. 150ms 표본 사이 왕복을 보존한다.
 *   edits = input 이벤트 개수만. 내용 · 대상 · 종류는 절대 안 남긴다. 패널 안 제외.
 *
 * --- 포커스 소유권 [C2] -----------------------------------------------------
 *   iframe 안에서 document.hasFocus() 는 그 프레임 내부에 포커스가 있어야 true라,
 *   그냥 읽기만 하는 동안 false 가 되어버린다. 그래서 포커스는 최상위 프레임이
 *   소유하고 하위 프레임에 브로드캐스트한다(cmd:focus).
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus, IS_TOP } = RBC;

  // --- 이 파일이 소유하는 상태 ---
  let latestCursor = null;
  let scrollEventsSinceTick = 0;  // 본문 스크롤
  let scrollOtherSinceTick = 0;   // 본문을 안 움직이는 스크롤 (v3)
  let mouseEventsSinceTick = 0;   // [C3] cursorfreq = 커서이벤트수 ÷ 활성시간
  let mdxSinceTick = 0, mdySinceTick = 0;   // v3: Σ|dx|, Σ|dy|
  let editsSinceTick = 0;         // v3: input 이벤트 개수
  let lastMove = null;            // 직전 mousemove 위치 (drain 해도 유지 — 이동량의 기준점)
  let scrollerEl = null;          // 본문 스크롤 주체. null = window
  let lastSelText = '';
  let winFocused = true;          // [C2] 최상위 프레임이 소유, 하위로 브로드캐스트
  let lastActivityAt = Date.now();
  let lastActivityPing = 0;

  // 디버그 패널 위의 선택·복사는 수집 대상이 아니다.
  // (3-hittest 안에도 같은 판정이 있지만 그쪽은 좌표 탐침 필터용이라 쓰임이 다르다)
  function inPanel(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('#' + CFG.PANEL_ID));
  }

  // ==========================================================================
  // 활동 기록 [C5] — 30분 무동작 자동 종료의 입력
  // ==========================================================================
  function bump() {
    lastActivityAt = Date.now();
    // 최상위 프레임의 활동을 primary 프레임에 알린다(사용자는 top 에서 스크롤하는데
    // 기록은 iframe 이 하는 경우 — 네이버 블로그 — 가 있으므로).
    if (IS_TOP && Date.now() - lastActivityPing > CFG.ACTIVITY_PING_MS) {
      lastActivityPing = Date.now();
      bus.emit('activity');          // [R12] 전: send('activity') 직접 호출
    }
  }

  // ==========================================================================
  // 리스너
  // ==========================================================================
  function onMouseMove(e) {
    latestCursor = { x: e.clientX, y: e.clientY };
    mouseEventsSinceTick++;          // [C3]
    if (lastMove) {
      mdxSinceTick += Math.abs(e.clientX - lastMove.x);
      mdySinceTick += Math.abs(e.clientY - lastMove.y);
    }
    lastMove = { x: e.clientX, y: e.clientY };
    bump();
  }

  // 첫 유닛 · 마지막 유닛의 시작 텍스트 노드. 유닛이 없으면 null.
  function bodyNodes() {
    const us = RBC.units.all();
    if (!us.length) return null;
    const a = RBC.hittest.locate(us[0].start);
    const b = RBC.hittest.locate(us[us.length - 1].start);
    return a && b ? [a.node, b.node] : null;
  }

  // 이 요소가 스크롤되면 본문 글자가 움직이는가.
  function movesBody(t) {
    if (!t || !t.contains) return false;
    const ns = bodyNodes();
    if (ns) return t.contains(ns[0]) && t.contains(ns[1]);
    const root = RBC.stream.root();
    return !!(root && t.contains(root));
  }

  // document capture — 창 스크롤(target = document)과 요소 스크롤을 한 곳에서 받는다.
  function onScroll(e) {
    const t = e.target;
    RBC.hittest.invalidate();        // 본문 가로 범위 캐시 무효화
    if (t !== document && inPanel(t)) return;
    if (t === document) {
      scrollEventsSinceTick++;
      scrollerEl = null;             // window
    } else if (movesBody(t)) {
      scrollEventsSinceTick++;
      scrollerEl = t;
    } else {
      scrollOtherSinceTick++;
    }
    bump();
  }

  // 첫 스크롤 전의 주체: 본문 글자의 공통 조상에서 위로, 실제로 세로 스크롤되는 첫 요소.
  // 구간 시작 때 5-recorder 가 부른다. getComputedStyle 이 조상 수만큼 — 틱 경로가 아니다.
  // body · html 에서 멈춘다: 보통 페이지는 그 overflow 가 뷰포트로 넘어가서 실제 주체가 window 다
  // (여기서 html 을 고르면 경로만 달라지고 값은 같은 가짜 주체가 생긴다). body 가 진짜 스크롤 상자인
  // 드문 구조는 첫 스크롤 이벤트(target = body, contains(root))가 바로잡는다.
  function seedScroller() {
    scrollerEl = null;
    let el = RBC.stream.root();
    const ns = bodyNodes();
    if (ns) {
      const r = document.createRange();
      try {
        r.setStart(ns[0], 0); r.setEnd(ns[1], 0);
        const c = r.commonAncestorContainer;
        el = c.nodeType === 1 ? c : c.parentElement;
      } catch (e) { /* 순서가 뒤집혔거나 분리된 노드 → 루트에서 시작 */ }
    }
    while (el && el !== document.body && el !== document.documentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight) {
        scrollerEl = el;
        break;
      }
      el = el.parentElement;
    }
    return scrollerEl;
  }

  // 기억한 주체가 DOM 에서 빠졌으면(SPA 리렌더) 다시 찾는다.
  function scroller() {
    if (scrollerEl && !scrollerEl.isConnected) seedScroller();
    return scrollerEl;
  }

  function onInput(e) {
    if (inPanel(e.target)) return;
    editsSinceTick++;
  }

  function onKey() { bump(); }

  function onResize() {
    RBC.hittest.invalidate();
    bus.emit('viewport:resized');    // 8-overlay 가 다시 칠한다
  }

  function onCopy() {
    const sel = window.getSelection();
    if (!sel || inPanel(sel.anchorNode)) return;
    const ranges = RBC.hittest.rangesFromSelection(sel);
    // [0-5] 본문 스트림 밖의 선택 — 댓글 작성창, 검색창, 로그인 폼 등.
    //   어느 유닛에도 귀속되지 않으니 feature 로는 못 쓰는데, 예전에는 원문 text 만
    //   timeline 에 남았다. 수집 목적에 전혀 기여하지 않으면서 사용자가 입력한
    //   내용만 저장되는, 가장 나쁜 형태였다. 활동으로는 치되 기록하지 않는다.
    if (!ranges.length) { bump(); return; }
    // trim: highlight 쪽과 맞춘다. 안 맞추면 같은 선택인데도 두 텍스트가
    //   끝 공백 하나 때문에 달라져서, 오프라인에서 비교가 안 된다.
    bus.emit('sel:copy', { ranges, text: sel.toString().trim() });
    bump();
  }

  // [BUG-3] selectionchange 는 드래그 중 글자 수만큼 발화한다.
  //   전에는 그때마다 이벤트를 쌓아서, 한 문장 선택이 수십 개의 highlight 로
  //   남았다. has_highlight 는 존재 여부라 모델 결과는 같지만, timeline 이
  //   부풀고 highlight_text 가 "한" || "한 문" || "한 문장" 꼴이 된다.
  //
  //   단순 디바운스만으로는 부족했다. 드래그 도중 타이머보다 오래 멈추면
  //   그 시점의 부분 선택이 먼저 기록되고, 드래그를 마저 끝내면 전체 선택이
  //   또 기록된다. 실측에서 31자/32자 두 건으로 확인됐다.
  //   그래서 마우스 버튼이 눌려 있는 동안에는 아예 보지 않고, mouseup 에서만 본다.
  //   예비 타이머를 두었다가 실패한 적이 있다. 드래그 도중 그 시간보다 오래 멈추면
  //   타이머가 먼저 터져 부분 선택이 샜다(실측 31자/32자). 드래그 중에는 시간이
  //   얼마가 지나든 "아직 안 끝난 것"이 맞으므로, 타이머를 걸지 않는 게 정답이다.
  //   mouseup 을 놓치는 경우(창 밖에서 버튼을 뗌)는 다음 클릭에서 복구된다.
  //   키보드 선택(shift+화살표)은 mouseup 이 없으므로 디바운스가 담당한다.
  const SELECTION_SETTLE_MS = 200;     // 키보드 선택이 멎었다고 볼 시간
  let selTimer = null;
  let dragging = false;

  function onMouseDown() { dragging = true; }

  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    clearTimeout(selTimer);
    flushSelection();                  // 드래그가 끝난 이 시점이 진짜 선택이다
  }

  function onSelectionChange() {
    clearTimeout(selTimer);
    if (dragging) return;              // 드래그가 끝날 때(mouseup)만 본다
    selTimer = setTimeout(flushSelection, SELECTION_SETTLE_MS);
  }

  function flushSelection() {
    const sel = window.getSelection();
    if (!sel || inPanel(sel.anchorNode)) return;
    const text = sel.toString().trim();
    if (text && text !== lastSelText) {
      lastSelText = text;
      const ranges = RBC.hittest.rangesFromSelection(sel);
      if (!ranges.length) { bump(); return; }        // [0-5] 위와 동일
      bus.emit('sel:highlight', { ranges, text });
      bump();
    } else if (!text) {
      lastSelText = '';
    }
  }

  function onVisibility() {
    bus.emit('visibility', { hidden: document.hidden });
    if (!document.hidden) bump();
    if (IS_TOP) setTimeout(pollFocus, 0);
  }

  // [C2] 포커스는 최상위 프레임이 소유하고 하위 프레임에 알린다.
  //   여기서 RBC.frames.send() 를 직접 부르면 4 → 6 역방향이 된다.
  //   사실만 알리고, 프레임 밖으로 내보내는 건 6-frames 가 구독해서 한다.
  //
  //   focus/blur 이벤트를 그대로 믿으면 안 된다. 최상위 프레임은 포커스가
  //   자기 iframe 안으로 들어갈 때도 blur 를 받는데, 그건 창을 떠난 게 아니다.
  //   그대로 브로드캐스트하면 본문이 iframe 인 사이트(네이버 블로그 #mainFrame)
  //   에서 사용자가 본문을 클릭하는 순간 기록이 멈춘다.
  //   실측: focus 시간이 8초에서 정지, 패널(최상위)을 클릭할 때만 재개.
  //
  //   document.hasFocus() 는 하위 브라우징 컨텍스트에 포커스가 있어도 true 라서
  //   "이 탭이 활성인가"와 정확히 일치한다. 그래서 이벤트는 '지금 확인해봐라'
  //   는 신호로만 쓰고, 판단은 항상 hasFocus() 로 한다.
  const FOCUS_POLL_MS = 400;
  let lastFocusSent = null;

  function pollFocus() {
    if (!IS_TOP) return;
    const on = !document.hidden && document.hasFocus();
    if (on === lastFocusSent) return;
    lastFocusSent = on;
    if (on) bump();
    bus.emit('focus:broadcast', { on });
  }

  // blur 직후에는 hasFocus() 가 아직 갱신 전일 수 있어 한 틱 미룬다.
  function onWinFocus() { if (IS_TOP) setTimeout(pollFocus, 0); }
  function onWinBlur() { if (IS_TOP) setTimeout(pollFocus, 0); }

  function setFocus(on) {
    if (winFocused === on) return;
    winFocused = on;
    bus.emit('focus', { focused: on });
  }

  function onPageHide() { bus.emit('pagehide'); }   // [C7]

  // ==========================================================================
  // 구독
  // ==========================================================================
  bus.on('cmd:focus', (m) => setFocus(!!m.on));       // [C2] 상위 프레임의 브로드캐스트
  bus.on('cmd:activity', () => { lastActivityAt = Date.now(); });   // [C5]

  // ==========================================================================
  // 등록
  //   전에는 init() 이 했다. 리스너 등록은 이 파일의 일이고, 이 시점(document_idle)
  //   에 document 는 이미 존재하므로 여기서 바로 건다.
  // ==========================================================================
  if (IS_TOP) winFocused = !document.hidden && document.hasFocus();

  document.addEventListener('mousemove', onMouseMove, { passive: true });
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });   // v3: window 리스너 삭제
  document.addEventListener('input', onInput, true);                                 // v3: edits
  window.addEventListener('resize', onResize, { passive: true });
  document.addEventListener('keydown', onKey, { passive: true });
  document.addEventListener('copy', onCopy, true);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onWinFocus);
  window.addEventListener('blur', onWinBlur);
  window.addEventListener('pagehide', onPageHide);

  // [C2] 이벤트만으로는 못 잡는 전이가 있다 — 다른 창으로 alt-tab, 주소창 클릭,
  //   iframe 안팎 이동. 판단 자체가 싼 호출이라 주기적으로 확인하고,
  //   값이 바뀔 때만 브로드캐스트한다(lastFocusSent). 최상위에서만 돈다.
  if (IS_TOP) setInterval(pollFocus, FOCUS_POLL_MS);

  // ==========================================================================
  // 공개
  // ==========================================================================
  RBC.input = {
    cursor: () => latestCursor,
    focused: () => winFocused,
    idleMs: () => Date.now() - lastActivityAt,
    bump,

    scroller,               // 본문 스크롤 주체 요소. null = window
    seedScroller,           // 구간 시작 때 5-recorder 가 부른다

    // 틱마다 정확히 한 번만 부를 것. 읽으면서 리셋한다.
    // 틱을 건너뛸 때 · 기록 시작 때도 불러서 버린다 (5-recorder).
    drain() {
      const v = {
        scrollEvents: scrollEventsSinceTick, scrollOther: scrollOtherSinceTick,
        mouseEvents: mouseEventsSinceTick,
        mdx: Math.round(mdxSinceTick), mdy: Math.round(mdySinceTick),
        edits: editsSinceTick,
      };
      scrollEventsSinceTick = 0; scrollOtherSinceTick = 0;
      mouseEventsSinceTick = 0;
      mdxSinceTick = 0; mdySinceTick = 0;
      editsSinceTick = 0;
      return v;
    },
  };
})();