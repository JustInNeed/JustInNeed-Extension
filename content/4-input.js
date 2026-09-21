/* =============================================================================
 * 4-input.js — DOM 이벤트 → 원시 신호
 *
 * 소유: latestCursor, scrollEventsSinceTick, mouseEventsSinceTick,
 *       lastSelText, winFocused, lastActivityAt, lastActivityPing
 * 의존(직접 호출): 0-core, 3-hittest
 * 발행: sel:highlight, sel:copy, visibility, focus, pagehide, activity,
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
  let scrollEventsSinceTick = 0;
  let mouseEventsSinceTick = 0;   // [C3] cursorfreq = 커서이벤트수 ÷ 활성시간
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
    bump();
  }

  function onScroll() {
    scrollEventsSinceTick++;
    RBC.hittest.invalidate();        // 본문 가로 범위 캐시 무효화
    bump();
  }

  function onKey() { bump(); }

  function onResize() {
    RBC.hittest.invalidate();
    bus.emit('viewport:resized');    // 8-overlay 가 다시 칠한다
  }

  function onCopy() {
    const sel = window.getSelection();
    if (!sel || inPanel(sel.anchorNode)) return;
    bus.emit('sel:copy', {
      pids: RBC.hittest.unitsFromSelection(sel),
      text: sel.toString(),
    });
    bump();
  }

  function onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || inPanel(sel.anchorNode)) return;
    const text = sel.toString().trim();
    if (text && text !== lastSelText) {
      lastSelText = text;
      bus.emit('sel:highlight', {
        pids: RBC.hittest.unitsFromSelection(sel),
        text,
      });
      bump();
    } else if (!text) {
      lastSelText = '';
    }
  }

  function onVisibility() {
    bus.emit('visibility', { hidden: document.hidden });
    if (!document.hidden) bump();
  }

  // [C2] 포커스는 최상위 프레임이 소유하고 하위 프레임에 알린다.
  //   여기서 RBC.frames.send() 를 직접 부르면 4 → 6 역방향이 된다.
  //   사실만 알리고, 프레임 밖으로 내보내는 건 6-frames 가 구독해서 한다.
  function onWinFocus() { if (IS_TOP) { bump(); bus.emit('focus:broadcast', { on: true }); } }
  function onWinBlur() { if (IS_TOP) bus.emit('focus:broadcast', { on: false }); }

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
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });
  document.addEventListener('keydown', onKey, { passive: true });
  document.addEventListener('copy', onCopy, true);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onWinFocus);
  window.addEventListener('blur', onWinBlur);
  window.addEventListener('pagehide', onPageHide);

  // ==========================================================================
  // 공개
  // ==========================================================================
  RBC.input = {
    cursor: () => latestCursor,
    focused: () => winFocused,
    idleMs: () => Date.now() - lastActivityAt,
    bump,

    // 틱마다 정확히 한 번만 부를 것. 읽으면서 리셋한다.
    drain() {
      const v = { scrollEvents: scrollEventsSinceTick, mouseEvents: mouseEventsSinceTick };
      scrollEventsSinceTick = 0;
      mouseEventsSinceTick = 0;
      return v;
    },
  };
})();