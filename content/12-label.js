/* =============================================================================
 * 12-label.js — 라벨 모드 (테스트 수집: "다 읽었어요" 뒤 중요한 유닛 클릭)
 *
 * 소유: labeling, selected(pid 집합), hoverPid, 라벨 바 DOM
 * 의존(직접 호출): 0-core, 2-units, 3-hittest, 4-input(scroller), 5-recorder(isRecording), 8-overlay(rangeForUnit)
 * 발행: label:mode({ on }), label:done({ pids, cancelled })
 * 구독: cmd:label, units:changed, record:stopped
 *
 * --- 흐름 ---------------------------------------------------------------------
 *   팝업 "다 읽었어요" → background label → 11-session → 6-frames → primary 의 cmd:label.
 *   그래서 라벨 모드는 본문을 기록 중인 프레임에서만 켜진다 (블로그 PC 면 iframe 안).
 *   켜지면 label:mode{on:true} — 5-recorder 가 틱을 멈춘다(라벨 고르는 시간은 읽기 기록이 아니다).
 *   [완료] → label:done{pids} → 5-recorder 가 label 이벤트를 남긴다 → label:mode{on:false} → 틱 재개.
 *   [취소] · Esc → label:done{pids:[], cancelled:true} (취소도 기록 — 틱 공백의 이유가 남게).
 *   [완료]는 곧 "이 글을 다 읽음" — 11-session 이 세션 정지를 요청하고 background 가 파일로 저장한다
 *   (테스트 모드: 한 글 = 한 기록). [취소]는 정지하지 않는다.
 *
 * --- 클릭 판정 = 조각 상자 ------------------------------------------------------
 *   클릭한 점을 품은 조각 상자(3-hittest.visPieces, 폭 0 제외)의 유닛. 여럿이면 가장 작은 상자.
 *   extract_features 의 A채널 귀속과 같은 규칙이라, 줄 사이 · 줄 끝 여백을 눌러도 그 유닛이 잡힌다.
 *   상자 밖이면 글자 위 판정(atCursor)으로 한 번 더 본다. 숨은 유닛은 상자가 없어 안 잡힌다.
 *
 * --- 페이지 클릭을 막는다 = 투명 가림막 ---------------------------------------------
 *   라벨 모드 동안 화면 전체를 투명한 가림막(#rbc-label-shield)으로 덮고, 클릭은 가림막이 받는다.
 *   유닛 판정은 좌표로만 하므로(조각 상자) 아래 요소를 몰라도 된다.
 *   처음엔 창 capture 단계에서 이벤트를 막았는데 링크로 이동해 버렸다 (2026-10-06 네이버 뉴스 옆 기사).
 *   iframe 안 링크는 바깥 창의 리스너가 못 보고, 사이트가 먼저 등록한 창 리스너도 못 막는다.
 *   가림막은 둘 다 막는다. 창 capture 막기는 이중 안전으로 남긴다.
 *   스크롤: 가림막 위 휠은 문서(window)만 굴린다. 본문이 안쪽 상자(노션)면 안 굴러가므로
 *   휠을 본문 스크롤 주체(4-input.scroller)로 넘긴다.
 *   한계: 본문이 iframe(블로그 PC)이면 가림막은 그 iframe 만 덮는다 — 바깥 페이지 링크는 열려 있다.
 *   선택 · 복사가 생겨도 5-recorder 가 라벨 모드 중에는 기록하지 않는다(이중 안전).
 *
 * --- 표시 ----------------------------------------------------------------------
 *   CSS Custom Highlight(크롬 105+) 로 유닛 글자를 칠한다. 마우스 올림 = 옅게, 선택 = 진하게.
 *   라벨 바는 shadow DOM 안 — 사이트 CSS 가 섞이지 않게.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus } = RBC;

  const HL_OK = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
  const BLOCK = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'contextmenu'];

  // --- 소유 상태 ---
  let labeling = false;
  const selected = new Set();
  let hoverPid = null;
  let host = null, countEl = null, shield = null;
  let hlSel = null, hlHover = null;
  let raf = 0, lastXY = null;

  // ==========================================================================
  // 스타일 (페이지 쪽 — 하이라이트 색 · 커서)
  // ==========================================================================
  function injectStyle() {
    const s = document.createElement('style');
    s.textContent = `
      ::highlight(rbc-label-sel){ background-color: rgba(76,175,63,.42); }
      ::highlight(rbc-label-hover){ background-color: rgba(76,175,63,.16); }
      html.rbc-labeling, html.rbc-labeling *{ cursor: pointer !important; }
    `;
    document.documentElement.appendChild(s);
  }

  // ==========================================================================
  // 판정
  // ==========================================================================
  function pidAt(x, y) {
    let best = null, bestArea = Infinity;
    for (const [pid, , top, bottom, left, right] of RBC.hittest.visPieces()) {
      if (right - left <= 0) continue;
      if (x < left || x > right || y < top || y > bottom) continue;
      const area = (right - left) * (bottom - top);
      if (area < bestArea) { best = pid; bestArea = area; }
    }
    if (best) return best;
    const u = RBC.hittest.atCursor(x, y);
    return u ? u.pid : null;
  }

  function isOurs(e) {
    const path = e.composedPath ? e.composedPath() : [];
    if (host && path.includes(host)) return true;
    if (shield && path.includes(shield)) return true;
    const t = e.target;
    return !!(t && t.closest && t.closest('#' + CFG.PANEL_ID));
  }

  // ==========================================================================
  // 칠하기
  // ==========================================================================
  function paint() {
    if (HL_OK) {
      if (!hlSel) {
        hlSel = new Highlight(); hlHover = new Highlight();
        hlSel.priority = 20; hlHover.priority = 19;
        CSS.highlights.set('rbc-label-sel', hlSel);
        CSS.highlights.set('rbc-label-hover', hlHover);
      }
      hlSel.clear(); hlHover.clear();
      if (labeling) {
        for (const pid of selected) addUnit(hlSel, pid);
        if (hoverPid && !selected.has(hoverPid)) addUnit(hlHover, hoverPid);
      }
    }
    if (countEl) countEl.textContent = `선택 ${selected.size}개`;
  }

  function addUnit(hl, pid) {
    const u = RBC.units.byPid(pid);
    const r = u && RBC.overlay && RBC.overlay.rangeForUnit ? RBC.overlay.rangeForUnit(u) : null;
    if (r) hl.add(r);
  }

  // ==========================================================================
  // 라벨 바 (shadow DOM)
  // ==========================================================================
  function buildBar() {
    host = document.createElement('div');
    host.id = 'rbc-label-bar';
    host.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;' +
      'display:flex;justify-content:center;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .bar{ pointer-events:auto; margin-top:10px; display:flex; align-items:center; gap:12px;
          padding:10px 14px; border-radius:12px; background:#fff; color:#1f2a1c;
          font:14px/1.4 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif;
          box-shadow:0 6px 24px rgba(0,0,0,.18); border:1px solid #d9e8d2; max-width:calc(100vw - 24px); }
        .t b{ display:block; font-size:14px; }
        .t small{ color:#5d6b58; font-size:12px; }
        .n{ font-weight:600; color:#2f7d24; white-space:nowrap; }
        button{ font:inherit; font-size:13px; padding:7px 12px; border-radius:8px; cursor:pointer;
          border:1px solid #cfd8cb; background:#fff; color:#1f2a1c; white-space:nowrap; }
        button.ok{ background:#4caf3f; border-color:#4caf3f; color:#fff; font-weight:600; }
      </style>
      <div class="bar" role="dialog" aria-label="중요한 부분 고르기">
        <div class="t"><b>중요하다고 생각한 부분을 클릭하세요</b>
          <small>여러 개 고를 수 있어요 · 다시 누르면 해제 · Esc 는 취소</small></div>
        <span class="n">선택 0개</span>
        <button class="ok" type="button">완료</button>
        <button class="no" type="button">취소</button>
      </div>`;
    countEl = root.querySelector('.n');
    root.querySelector('.ok').addEventListener('click', () => exit(false));
    root.querySelector('.no').addEventListener('click', () => exit(true));
    document.documentElement.appendChild(host);
  }

  function toast(text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;' +
      'padding:10px 14px;border-radius:10px;background:#1f2a1c;color:#fff;' +
      'font:13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);';
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function buildShield() {
    shield = document.createElement('div');
    shield.id = 'rbc-label-shield';
    shield.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;' +
      'background:transparent;cursor:pointer;';
    shield.addEventListener('mousedown', (e) => e.preventDefault());   // 포커스 · 선택 안 생기게
    shield.addEventListener('click', onShieldClick);
    shield.addEventListener('mousemove', onMove);
    shield.addEventListener('wheel', onWheel, { passive: false });
    shield.addEventListener('contextmenu', (e) => e.preventDefault());
    document.documentElement.appendChild(shield);                    // 바보다 먼저 → 바가 위
  }

  // ==========================================================================
  // 입력
  // ==========================================================================
  function onShieldClick(e) {
    e.preventDefault();
    if (e.button !== 0) return;
    const pid = pidAt(e.clientX, e.clientY);
    if (!pid) return;
    if (selected.has(pid)) selected.delete(pid); else selected.add(pid);
    paint();
  }

  // 가림막 밖에서 온 것(가림막보다 위에 그려진 페이지 요소 등)은 그냥 막는다.
  function onBlock(e) {
    if (isOurs(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onWheel(e) {
    const el = RBC.input.scroller();
    if (!el) return;                                  // window 가 본문: 기본 동작이 문서를 굴린다
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
    el.scrollBy({ left: e.deltaX * k, top: e.deltaY * k });
  }

  function onMove(e) {
    lastXY = [e.clientX, e.clientY];
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const p = lastXY ? pidAt(lastXY[0], lastXY[1]) : null;
      if (p !== hoverPid) { hoverPid = p; paint(); }
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); exit(true); }
  }

  // ==========================================================================
  // 켜기 / 끄기
  // ==========================================================================
  function enter() {
    if (labeling) return;
    if (!RBC.recorder.isRecording()) {
      toast('이 탭은 지금 기록 중이 아니라 라벨을 남길 수 없습니다.');
      return;
    }
    labeling = true;
    selected.clear();
    hoverPid = null;
    bus.emit('label:mode', { on: true });            // 5-recorder: 틱 멈춤
    try { window.getSelection().removeAllRanges(); } catch (e) { /* noop */ }
    buildShield();
    buildBar();
    document.documentElement.classList.add('rbc-labeling');
    for (const t of BLOCK) window.addEventListener(t, onBlock, true);
    window.addEventListener('keydown', onKey, true);
    paint();
  }

  // cancelled: 취소 · Esc. silent: 구간이 이미 닫혀서 남길 곳이 없음.
  function exit(cancelled, silent) {
    if (!labeling) return;
    const order = (pid) => { const u = RBC.units.byPid(pid); return u ? u.order : 1e9; };
    const pids = cancelled ? [] : [...selected].sort((a, b) => order(a) - order(b));
    labeling = false;
    for (const t of BLOCK) window.removeEventListener(t, onBlock, true);
    window.removeEventListener('keydown', onKey, true);
    if (shield) { shield.remove(); shield = null; }
    document.documentElement.classList.remove('rbc-labeling');
    if (host) { host.remove(); host = null; countEl = null; }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    selected.clear();
    hoverPid = null;
    paint();
    if (!silent) bus.emit('label:done', { pids, cancelled: !!cancelled });   // 5-recorder: label 이벤트
    bus.emit('label:mode', { on: false });           // 5-recorder: 틱 재개
    if (!silent && !cancelled) toast(`저장했습니다: ${pids.length}개 · 기록을 마치고 파일로 저장합니다`);
  }

  // ==========================================================================
  // 구독
  // ==========================================================================
  bus.on('cmd:label', () => enter());

  // 재스캔으로 유닛이 바뀌면 사라진 pid 는 빼고 다시 칠한다 (Range 도 새로 만든다).
  bus.on('units:changed', () => {
    if (!labeling) return;
    for (const pid of [...selected]) if (!RBC.units.byPid(pid)) selected.delete(pid);
    paint();
  });

  // 라벨 중에 구간이 닫히면(세션 정지 · 이동) 남길 곳이 없다 — 조용히 끈다.
  bus.on('record:stopped', () => exit(true, true));

  RBC.label = { isOn: () => labeling };

  injectStyle();
})();