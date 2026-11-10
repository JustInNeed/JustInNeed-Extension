/* =============================================================================
 * 8-overlay.js — 유닛 경계 오버레이 (디버그 전용)
 *
 * 소유: overlayOn, CSS Custom Highlight 객체, 폴백 레이어, 중앙선 엘리먼트, vis 상자 레이어
 * 의존(직접 호출): 0-core, RBC.stream, RBC.units, RBC.hittest   ← 전부 자기보다 낮은 번호
 * 발행: overlay:changed
 * 구독: cmd:overlay, units:changed, tick:done, viewport:resized, label:mode
 *   평정 · 중요 표시(label:mode on) 동안은 숨긴다 — 오버레이 상자가 평정 상자와 겹쳐 헷갈렸다(2026-10-08).
 *
 * --- 이 파일의 존재 이유 ----------------------------------------------------
 *   유닛이 DOM 요소가 아니라 글자 범위라서 outline을 못 쓴다.
 *   CSS Custom Highlight API로 글자 범위에 직접 색을 칠한다.
 *   미지원 브라우저는 절대배치 박스로 폴백.
 *
 * --- vis 상자 (v3) ----------------------------------------------------------
 *   오버레이를 켜면 매 틱(tick:done) 기록되는 vis 조각 사각형을 테두리 상자로 그린다.
 *   글자 칠하기와 따로 — 상자는 "로그에 남는 좌표 그 자체"라서, 사진 칸이 비고 글자만
 *   덮이는지를 눈으로 확인하는 장치다. 라벨 = #order·k. 갱신이 틱 단위(150ms)라 빠른
 *   스크롤에서는 상자가 살짝 늦게 따라온다 (표시만의 한계, 기록과 무관).
 *
 * --- noise 표시 (#11) --------------------------------------------------------
 *   조각 noise === true 인 글은 빨간 바탕 + 물결 밑줄(rbc-noise), vis 상자도 빨간 점선 + "noise" 라벨.
 *   Readability 가 고른 본문 상자(1-stream article().boxEls)는 보라 굵은 테두리 + "본문 상자" 라벨.
 *   테두리가 기사 본문을 감싸면 상자를 제대로 되찾은 것이고, 사이드바 · 댓글 · 페이지 전체면 잘못 찾은 것.
 *   스트림에서 통째로 뺀 본문 아닌 위젯(1-stream AD_WIDGETS — 광고 · 추천 상자, #51 · #53)은 회색 점선 + "본문 아닌 위젯" 라벨 — 그 안엔 조각이 없어야 맞다.
 *   표(#54): 자료 표(1-stream tables — 표 유닛이 될 표)는 초록 점선 + "자료 표 줄×칸 (판정 이유)", 배치용 표(layouts — 지금처럼
 *   줄글로)는 회색 점점선. 이름표는 오른쪽 위. 페이지 대부분이 초록 상자 하나로 덮이면 배치용 표를 자료 표로 잘못 본 것.
 *   표 유닛(u.kind 'table')은 파랑 · 주황 번갈이 대신 초록으로 칠하고, 표 상자 이름표에 "표 유닛 #order · 줄×칸 · 칸 조각 N".
 *   vis 상자 라벨에 칸 [줄,칸], 커서가 표 유닛 칸 위면 커서 옆에 "줄 r · 칸 c" (tick:done 의 cx · cy, 서버 귀속과 같은 방식).
 *   상자 위치는 틱마다 다시 잰다(상자는 몇 개뿐). Highlight 미지원 폴백에는 noise 칠하기를 안 넣었다(크롬은 지원).
 *
 * --- 판정 기준 --------------------------------------------------------------
 *   manifest의 js 배열에서 이 파일을 빼도 스캔·기록·정지·JSON이 전부 정상이어야
 *   한다. 엔진의 다른 content 파일은 `RBC.overlay` 를 참조하지 않는다. 데이터 수집 버전의 12-label 만
 *   `RBC.overlay &&` 로 있는지 확인하고 rangeForUnit 을 쓴다 — 없어도 동작한다.
 *
 * --- 버스로만 움직인다 --------------------------------------------------------
 *   다시 칠하기 = units:changed · 현재 유닛 표시 = tick:done · 켜고 끄기 = cmd:overlay.
 *   overlayOn 의 소유자는 여기다. 5-recorder 에는 표시용 미러만 둔다
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
  let hlA = null, hlB = null, hlC = null, hlU = null, hlN = null, hlT = null;
  let cellEl = null;                     // 커서 칸 이름표 (#54)
  let fallbackLayer = null, centerLineEl = null;
  let fbRaf = 0;
  let visLayer = null;
  const visPool = [];
  let boxLayer = null;                   // 본문 상자 테두리 (#11)
  const boxPool = [];

  // ==========================================================================
  // 스타일 — 원본 injectStyle() 에서 오버레이 몫만 떼어왔다.
  //          #rbc-panel 규칙은 9-panel.js 가 가져간다.
  // ==========================================================================
  function injectStyle() {
    const s = document.createElement('style');
    s.textContent = `
      ::highlight(rbc-unit-a){ background-color: rgba(59,130,246,.13); }
      ::highlight(rbc-unit-b){ background-color: rgba(245,158,11,.17); }
      ::highlight(rbc-unit-t){ background-color: rgba(34,197,94,.20); }
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
      #rbc-vis{ position:fixed; left:0; top:0; width:0; height:0; overflow:visible;
        z-index:2147483645; pointer-events:none; }
      .rbc-vis-box{ position:absolute; box-sizing:border-box; pointer-events:none;
        border:1.5px solid rgba(37,99,235,.9); }
      .rbc-vis-box.b{ border-color:rgba(217,119,6,.95); }
      .rbc-vis-box > span{ position:absolute; left:-1px; top:-15px; font:10px/14px monospace;
        padding:0 3px; color:#fff; background:rgba(37,99,235,.9); white-space:nowrap; }
      .rbc-vis-box.b > span{ background:rgba(217,119,6,.95); }
      ::highlight(rbc-noise){ background-color: rgba(220,38,38,.38);
        text-decoration: underline wavy 1.5px rgba(185,28,28,.95); }
      .rbc-vis-box.n{ border:2.5px dashed rgba(220,38,38,.95); }
      .rbc-vis-box.n > span{ background:rgba(220,38,38,.95); }
      #rbc-box{ position:fixed; left:0; top:0; width:0; height:0; overflow:visible;
        z-index:2147483644; pointer-events:none; }
      .rbc-art-box{ position:absolute; box-sizing:border-box; pointer-events:none;
        border:4px solid rgba(147,51,234,.9); }
      .rbc-art-box > span{ position:absolute; left:-4px; top:-18px; font:11px/16px monospace;
        padding:0 4px; color:#fff; background:rgba(147,51,234,.95); white-space:nowrap; }
      .rbc-art-box.skip{ border:3px dashed rgba(220,38,38,.95); }
      .rbc-art-box.skip > span{ background:rgba(220,38,38,.95); }
      .rbc-art-box.ad{ border:3px dashed rgba(107,114,128,.95); }
      .rbc-art-box.ad > span{ background:rgba(107,114,128,.95); }
      .rbc-art-box.tbl{ border:3px dashed rgba(22,163,74,.95); }
      .rbc-art-box.tbl > span{ background:rgba(22,163,74,.95); left:auto; right:-4px; }
      .rbc-art-box.lay{ border:2px dotted rgba(107,114,128,.95); }
      .rbc-art-box.lay > span{ background:rgba(107,114,128,.8); left:auto; right:-4px; }
      #rbc-cell{ position:fixed; z-index:2147483646; pointer-events:none; font:12px/18px monospace; padding:0 6px;
        color:#fff; background:rgba(22,163,74,.95); border-radius:3px; white-space:nowrap; display:none; }
    `;
    document.documentElement.appendChild(s);
  }

  // ==========================================================================
  // 유닛 → Range
  // ==========================================================================
  function rangeForUnit(u) { return rangeForSpan(u.start, u.end); }

  // 원문 구간 [start, end) → Range. 유닛 전체 또는 조각 하나(u.spans[k]).
  function rangeForSpan(start, end) {
    const a = RBC.hittest.locate(start);
    const b = RBC.hittest.locate(end);
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
        hlC = new Highlight(); hlU = new Highlight(); hlN = new Highlight(); hlT = new Highlight();
        hlA.priority = 1; hlB.priority = 1; hlT.priority = 1; hlN.priority = 3; hlC.priority = 5; hlU.priority = 9;
        CSS.highlights.set('rbc-unit-a', hlA);
        CSS.highlights.set('rbc-unit-b', hlB);
        CSS.highlights.set('rbc-unit-t', hlT);   // 표 유닛 (#54) 초록
        CSS.highlights.set('rbc-noise', hlN);
        CSS.highlights.set('rbc-center', hlC);
        CSS.highlights.set('rbc-cursor', hlU);
      }
      hlA.clear(); hlB.clear(); hlC.clear(); hlU.clear(); hlN.clear(); hlT.clear();
      if (on) {
        RBC.units.all().forEach((u, i) => {
          const r = rangeForUnit(u);
          if (r) (u.kind === 'table' ? hlT : i % 2 ? hlB : hlA).add(r);
          (u.pieces || []).forEach((p, k) => {
            const sp = u.spans && u.spans[k];
            if (p.noise !== true || !sp) return;
            const rn = rangeForSpan(sp[0], sp[1]);
            if (rn) hlN.add(rn);
          });
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
  // vis 상자 — tick:done 의 vis 를 그대로 그린다 (좌표 = 뷰포트 기준 = fixed 기준)
  // ==========================================================================
  function drawVis(vis) {
    if (!visLayer) {
      visLayer = document.createElement('div');
      visLayer.id = 'rbc-vis';
      document.documentElement.appendChild(visLayer);
    }
    visLayer.style.display = 'block';
    const list = vis || [];
    while (visPool.length < list.length) {
      const d = document.createElement('div');
      d.appendChild(document.createElement('span'));
      visLayer.appendChild(d);
      visPool.push(d);
    }
    for (let i = 0; i < visPool.length; i++) {
      const d = visPool[i];
      const v = list[i];
      if (!v) { d.style.display = 'none'; continue; }
      const [pid, k, top, bottom, left, right] = v;
      const u = RBC.units.byPid(pid);
      const order = u ? u.order : '?';
      const noise = !!(u && u.pieces && u.pieces[k] && u.pieces[k].noise === true);
      d.className = 'rbc-vis-box' + (typeof order === 'number' && order % 2 ? ' b' : '') + (noise ? ' n' : '');
      d.style.cssText = `display:block;left:${left}px;top:${top}px;` +
        `width:${right - left}px;height:${bottom - top}px;`;
      const cell = u && u.pieces && u.pieces[k] && u.pieces[k].cell;
      d.firstChild.textContent = '#' + order + '·' + k + (cell ? ' [' + cell + ']' : '') + (noise ? ' noise' : '');
    }
  }

  function hideVis() { if (visLayer) visLayer.style.display = 'none'; hideCell(); }

  // 커서 칸 (#54): 커서 좌표가 든 vis 조각 상자의 cell 을 커서 옆에 띄운다 — 서버가 cx · cy 와 vis 로 칸을 찾는 방식 그대로.
  //   표 유닛 안인데 칸 밖(표 제목)이면 "칸 없음". 표 밖이면 숨김.
  function drawCell(vis, cx, cy) {
    if (cx == null || cy == null) { hideCell(); return; }
    const v = (vis || []).find(([, , top, bottom, left, right]) => left <= cx && cx < right && top <= cy && cy < bottom);
    const u = v && RBC.units.byPid(v[0]);
    if (!u || u.kind !== 'table') { hideCell(); return; }
    const p = u.pieces && u.pieces[v[1]];
    if (!cellEl) {
      cellEl = document.createElement('div');
      cellEl.id = 'rbc-cell';
      document.documentElement.appendChild(cellEl);
    }
    cellEl.textContent = `표 유닛 #${u.order} · ` + (p && p.cell ? `줄 ${p.cell[0]} · 칸 ${p.cell[1]}` : '칸 없음');
    cellEl.style.cssText = `display:block;left:${cx + 14}px;top:${cy + 14}px;`;
  }

  function hideCell() { if (cellEl) cellEl.style.display = 'none'; }

  // 본문 상자 테두리 — 뷰포트 기준으로 틱마다 다시 잰다.
  function drawBoxes() {
    const a = RBC.stream.article();
    // 본문 상자 뒤에 뺄 칸(광고 자리, #45)을 빨간 점선으로
    const ok = a && a.status === 'ok';
    const nBox = ok ? a.boxEls.length : 0;
    const nSkip = ok ? a.skipEls.length : 0;
    // 그 뒤에 스트림에서 통째로 뺀 본문 아닌 위젯(#51 · #53)을 회색 점선으로 — 판정과 무관하게 늘 그린다
    const nAd = RBC.stream.adWidgets().length;
    // 그 뒤에 표 (#54): 자료 표(= 표 유닛이 될 표) 초록 점선 · 배치용 표 회색 점점선. 이름표는 오른쪽 위(본문 상자 이름표와 안 겹치게)
    const tbls = RBC.stream.tables(), lays = RBC.stream.layouts();
    const els = (ok ? a.boxEls.concat(a.skipEls) : []).concat(RBC.stream.adWidgets(),
      tbls.map(t => t.el), lays.map(l => l.el));
    const nT = nBox + nSkip + nAd;
    if (!boxLayer) {
      boxLayer = document.createElement('div');
      boxLayer.id = 'rbc-box';
      document.documentElement.appendChild(boxLayer);
    }
    boxLayer.style.display = 'block';
    while (boxPool.length < els.length) {
      const d = document.createElement('div');
      d.className = 'rbc-art-box';
      d.appendChild(document.createElement('span'));
      boxLayer.appendChild(d);
      boxPool.push(d);
    }
    for (let i = 0; i < boxPool.length; i++) {
      const d = boxPool[i], el = els[i];
      if (!el || !el.isConnected) { d.style.display = 'none'; continue; }
      const b = el.getBoundingClientRect();
      d.style.cssText = `display:block;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;`;
      if (i >= nT) {
        // 접혀 안 그려지는 표(닫힌 <details> 속 — 나무위키 [ 목록 ] 등)는 크롬이 펼친 자리 사각형을 줘서 화면 아래까지
        //   긴 점선이 됐다(#72). vis 는 3-hittest 가 이미 checkVisibility 로 뺀다 — 테두리도 같은 기준으로 숨긴다.
        if (el.checkVisibility && !el.checkVisibility()) { d.style.display = 'none'; continue; }
        const t = tbls[i - nT];
        d.className = t ? 'rbc-art-box tbl' : 'rbc-art-box lay';
        const tu = t && RBC.units.all().find(x => x.kind === 'table' && x.start <= t.start && t.start < x.end);
        d.firstChild.textContent = !t ? `배치용 표 (${lays[i - nT - tbls.length].why}) = 줄글로`
          : tu ? `표 유닛 #${tu.order} · ${t.rows}×${t.cols} · 칸 조각 ${tu.pieces.filter(p => p.cell).length} (${t.why})`
            : `자료 표 ${t.rows}×${t.cols} (${t.why}) · 표 유닛 없음`;
        continue;
      }
      d.className = i < nBox ? 'rbc-art-box' : i < nBox + nSkip ? 'rbc-art-box skip' : 'rbc-art-box ad';
      d.firstChild.textContent = i < nBox
        ? `본문 상자 (${a.by ? a.by + ' 지정' : a.alt ? `itemprop="${a.alt}" 칸` : 'Readability'}) ${a.boxes[i]}` + (a.decided ? '' : ' · 미판정')
        : i < nBox + nSkip
          ? `광고 칸 제외 = noise (${a.by} 지정) ${a.skips[i - nBox]}` + (a.decided ? '' : ' · 미판정')
          : '본문 아닌 위젯 = 스트림에서 뺌';
    }
  }

  function hideBoxes() { if (boxLayer) boxLayer.style.display = 'none'; }

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
    // 평가 화면(label:mode) 중엔 켜져도 안 칠한다 — 다른 탭 · 패널 켜기로도 켜질 수 있어서(#36 검토)
    const show = overlayOn && !labelHide;
    paint(show);
    if (show) drawBoxes(); else { hideVis(); hideBoxes(); }
    // 5-recorder 의 미러를 갱신시킨다. 거기서 ensureTicking() 이 다시 불린다.
    bus.emit('overlay:changed', { on: overlayOn });
  }

  // ==========================================================================
  // 구독 — 여기가 역방향 호출을 끊은 자리
  // ==========================================================================

  // 패널의 [오버레이] 버튼. 전에는 handleCmd 가 overlayOn 에 직접 대입했다.
  // 이 파일이 없으면 이 이벤트는 듣는 사람이 없고, 그냥 아무 일도 안 일어난다.
  bus.on('cmd:overlay', (m) => setOverlay(!!(m && m.on)));

  let labelHide = false;
  bus.on('label:mode', (d) => {
    labelHide = !!(d && d.on);
    if (!overlayOn) return;
    if (labelHide) { paint(false); hideVis(); hideBoxes(); } else { paint(true); drawBoxes(); }
  });

  bus.on('units:changed', () => { if (overlayOn && !labelHide) { paint(true); drawBoxes(); } });

  bus.on('tick:done', (d) => {
    if (!overlayOn || labelHide || !d) return;
    markCurrent(d.centerU, d.cursorPid);
    drawVis(d.vis);
    drawCell(d.vis, d.cx, d.cy);
    drawBoxes();
  });

  bus.on('viewport:resized', () => { if (overlayOn && !labelHide) paint(true); });

  // ==========================================================================
  // 공개 — 콘솔에서 손으로 켜볼 때 쓰는 통로 + 12-label 의 rangeForUnit(있을 때만 부른다).
  // ==========================================================================
  RBC.overlay = {
    isOn() { return overlayOn; },
    set: setOverlay,
    repaint() { if (overlayOn) paint(true); },
    rangeForUnit,           // 12-label 이 선택한 유닛을 칠할 때 쓴다
  };

  injectStyle();
})();