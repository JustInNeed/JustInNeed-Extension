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
    const pids = RBC.hittest.unitsFromSelection(sel);
    // [0-5] 본문 스트림 밖의 선택 — 댓글 작성창, 검색창, 로그인 폼 등.
    //   어느 유닛에도 귀속되지 않으니 feature 로는 못 쓰는데, 예전에는 원문 text 만
    //   timeline 에 남았다. 수집 목적에 전혀 기여하지 않으면서 사용자가 입력한
    //   내용만 저장되는, 가장 나쁜 형태였다. 활동으로는 치되 기록하지 않는다.
    if (!pids.length) { bump(); return; }
    // trim: highlight 쪽과 맞춘다. 안 맞추면 같은 선택인데도 두 텍스트가
    //   끝 공백 하나 때문에 달라져서, 오프라인에서 비교가 안 된다.
    bus.emit('sel:copy', { pids, text: sel.toString().trim() });
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
      const pids = RBC.hittest.unitsFromSelection(sel);
      if (!pids.length) { bump(); return; }          // [0-5] 위와 동일
      bus.emit('sel:highlight', { pids, text });
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
  window.addEventListener('scroll', onScroll, { passive: true });
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

    // 틱마다 정확히 한 번만 부를 것. 읽으면서 리셋한다.
    drain() {
      const v = { scrollEvents: scrollEventsSinceTick, mouseEvents: mouseEventsSinceTick };
      scrollEventsSinceTick = 0;
      mouseEventsSinceTick = 0;
      return v;
    },
  };
})();