/* =============================================================================
 * 8-overlay.js — 유닛 경계 오버레이 (디버그 전용)
 *
 * 소유: overlayOn, CSS Custom Highlight 객체, 폴백 레이어, 중앙선 엘리먼트
 * 의존(직접 호출): 0-core, RBC.units, RBC.hittest   ← 전부 자기보다 낮은 번호
 * 발행: overlay:changed
 * 구독: cmd:overlay, units:changed, tick:done, viewport:resized
 *
 * --- 이 파일의 존재 이유 ----------------------------------------------------
 *   유닛이 DOM 요소가 아니라 글자 범위라서 outline을 못 쓴다.
 *   CSS Custom Highlight API로 글자 범위에 직접 색을 칠한다.
 *   미지원 브라우저는 절대배치 박스로 폴백.
 *
 * --- 판정 기준 --------------------------------------------------------------
 *   manifest의 js 배열에서 이 파일을 빼도 스캔·기록·정지·JSON이 전부 정상이어야
 *   한다. content.js 는 이 파일의 존재를 몰라야 하고, 실제로 `RBC.overlay` 를
 *   단 한 군데도 참조하지 않는다.
 *
 * --- v2.2 대비 달라진 점 ----------------------------------------------------
 *   [R2] 전: rescan() 이 paintOverlay() 를 직접 호출  → units:changed 구독
 *   [R5] 전: tick() 이 markCurrent() 를 직접 호출     → tick:done 구독
 *   [R-cmd] 전: handleCmd 가 overlayOn 을 직접 대입   → cmd:overlay 구독
 *   overlayOn 의 소유자도 여기로 옮겼다. content.js 쪽에는 표시용 미러만 둔다
 *   (overlay:changed 로 갱신). 이 파일이 없으면 미러는 영원히 false 로 남고,
 *   그게 정확히 맞는 동작이다.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus } = RBC;

  const HL_OK = typeof CSS !== 'undefined' && CSS.highlights &&
    typeof Highlight !== 'undefined';

  // --- 이 파일이 소유하는 상태 ---
  let overlayOn = false;
  let hlA = null, hlB = null, hlC = null, hlU = null;
  let fallbackLayer = null, centerLineEl = null;
  let fbRaf = 0;

  // ==========================================================================
  // 스타일 — 원본 injectStyle() 에서 오버레이 몫만 떼어왔다.
  //          #rbc-panel 규칙은 9-panel.js 가 가져간다.
  // ==========================================================================
  function injectStyle() {
    const s = document.createElement('style');
    s.textContent = `
      ::highlight(rbc-unit-a){ background-color: rgba(59,130,246,.13); }
      ::highlight(rbc-unit-b){ background-color: rgba(245,158,11,.17); }
      ::highlight(rbc-center){ background-color: rgba(34,197,94,.38); }
      ::highlight(rbc-cursor){ text-decoration: underline 2px solid rgba(37,99,235,.95); }
      #rbc-centerline{ position:fixed; left:0; right:0; height:0;
        border-top:1px dashed rgba(34,197,94,.85);
        z-index:2147483646; pointer-events:none; }
      #rbc-fb{ position:absolute; left:0; top:0; width:0; height:0;
        z-index:2147483645; pointer-events:none; }
      .rbc-fb-box{ position:absolute; pointer-events:none; }
      .rbc-fb-box.a{ background:rgba(59,130,246,.13); }
      .rbc-fb-box.b{ background:rgba(245,158,11,.17); }
    `;
    document.documentElement.appendChild(s);
  }

  // ==========================================================================
  // 유닛 → Range
  // ==========================================================================
  function rangeForUnit(u) {
    const a = RBC.hittest.locate(u.start);
    const b = RBC.hittest.locate(u.end);
    if (!a || !b) return null;
    const r = document.createRange();
    try {
      r.setStart(a.node, Math.min(a.offset, a.node.data.length));
      r.setEnd(b.node, Math.min(b.offset, b.node.data.length));
      if (r.collapsed) return null;
    } catch (e) { return null; }
    return r;
  }

  // ==========================================================================
  // 전체 칠하기
  // ==========================================================================
  function paint(on) {
    if (HL_OK) {
      if (!hlA) {
        hlA = new Highlight(); hlB = new Highlight();
        hlC = new Highlight(); hlU = new Highlight();
        hlA.priority = 1; hlB.priority = 1; hlC.priority = 5; hlU.priority = 9;
        CSS.highlights.set('rbc-unit-a', hlA);
        CSS.highlights.set('rbc-unit-b', hlB);
        CSS.highlights.set('rbc-center', hlC);
        CSS.highlights.set('rbc-cursor', hlU);
      }
      hlA.clear(); hlB.clear(); hlC.clear(); hlU.clear();
      if (on) {
        RBC.units.all().forEach((u, i) => {
          const r = rangeForUnit(u);
          if (r) (i % 2 ? hlB : hlA).add(r);
        });
      }
    } else {
      paintFallback(on);
    }

    if (on && !centerLineEl) {
      centerLineEl = document.createElement('div');
      centerLineEl.id = 'rbc-centerline';
      document.documentElement.appendChild(centerLineEl);
    }
    if (centerLineEl) {
      centerLineEl.style.display = on ? 'block' : 'none';
      centerLineEl.style.top = (CFG.CENTER_RATIO * 100) + 'vh';
    }
  }

  // ==========================================================================
  // 현재 틱 강조 — 중앙선(B채널) 초록, 커서(A채널) 밑줄
  // ==========================================================================
  function markCurrent(centerU, cursorPid) {
    if (!HL_OK || !hlC) return;
    hlC.clear(); hlU.clear();
    if (centerU) { const r = rangeForUnit(centerU); if (r) hlC.add(r); }
    if (cursorPid) {
      const u = RBC.units.byPid(cursorPid);
      if (u) { const r = rangeForUnit(u); if (r) hlU.add(r); }
    }
  }

  // ==========================================================================
  // 폴백 — CSS Custom Highlight 미지원 브라우저
  // ==========================================================================
  function paintFallback(on) {
    if (!fallbackLayer) {
      fallbackLayer = document.createElement('div');
      fallbackLayer.id = 'rbc-fb';
      document.documentElement.appendChild(fallbackLayer);
    }
    fallbackLayer.style.display = on ? 'block' : 'none';
    if (!on) { fallbackLayer.innerHTML = ''; return; }
    if (fbRaf) return;
    fbRaf = requestAnimationFrame(() => {
      fbRaf = 0;
      const H = window.innerHeight;
      const frag = document.createDocumentFragment();
      RBC.units.all().forEach((u, i) => {
        const r = rangeForUnit(u);
        if (!r) return;
        const rects = r.getClientRects();
        if (!rects.length) return;
        if (rects[rects.length - 1].bottom < -H || rects[0].top > 2 * H) return;
        for (const rc of rects) {
          const d = document.createElement('div');
          d.className = 'rbc-fb-box ' + (i % 2 ? 'b' : 'a');
          d.style.cssText = `left:${rc.left + scrollX}px;top:${rc.top + scrollY}px;` +
            `width:${rc.width}px;height:${rc.height}px;`;
          frag.appendChild(d);
        }
      });
      fallbackLayer.innerHTML = '';
      fallbackLayer.appendChild(frag);
    });
  }

  // ==========================================================================
  // 상태 전환 — overlayOn 을 바꾸는 유일한 함수
  // ==========================================================================
  function setOverlay(on) {
    overlayOn = !!on;
    paint(overlayOn);
    // content.js 의 미러를 갱신시킨다. 거기서 ensureTicking() 이 다시 불린다.
    bus.emit('overlay:changed', { on: overlayOn });
  }

  // ==========================================================================
  // 구독 — 여기가 역방향 호출을 끊은 자리
  // ==========================================================================

  // 패널의 [오버레이] 버튼. 전에는 handleCmd 가 overlayOn 에 직접 대입했다.
  // 이 파일이 없으면 이 이벤트는 듣는 사람이 없고, 그냥 아무 일도 안 일어난다.
  bus.on('cmd:overlay', (m) => setOverlay(!!(m && m.on)));

  // [R2] 전: rescan() 안에서 if (overlayOn) paintOverlay(true);
  bus.on('units:changed', () => { if (overlayOn) paint(true); });

  // [R5] 전: tick() 안에서 if (overlayOn) markCurrent(centerU, cursorPid);
  bus.on('tick:done', (d) => { if (overlayOn && d) markCurrent(d.centerU, d.cursorPid); });

  // 전: onResize() 안에서 if (overlayOn) paintOverlay(true);
  bus.on('viewport:resized', () => { if (overlayOn) paint(true); });

  // ==========================================================================
  // 공개 — content.js 는 이걸 안 쓴다. 콘솔에서 손으로 켜볼 때만 쓰는 통로.
  // ==========================================================================
  RBC.overlay = {
    isOn() { return overlayOn; },
    set: setOverlay,
    repaint() { if (overlayOn) paint(true); },
  };

  injectStyle();
})();