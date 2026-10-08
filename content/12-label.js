/* =============================================================================
 * 12-label.js — 라벨 모드 v2 (테스트 수집: 끝 도달 질문 → 문단 평정 → 중요 유닛 → 설문)
 *
 * 소유: phase, 평정 · 표시 · 설문 값, 끝 도달 판정 상태, 라벨 바 · 가림막 DOM
 * 의존(직접 호출): 0-core, 2-units, 3-hittest, 4-input(scroller), 5-recorder(isRecording),
 *                 6-frames(isPrimary), 8-overlay(rangeForUnit)
 * 발행: label:mode({ on }), label:ask({ answer, shownMs }), label:done({ cancelled, trigger, ratings, ... })
 * 구독: cmd:label, tick:done, units:changed, record:started, record:stopped
 *
 * 명세: 라벨_명세_v2.md. 단계(phase):
 *   null(읽기) → 'ask'(다 읽었나요?) → 'rate'(문단 평정) → 'mark'(중요 유닛) → 'survey'(설문) → [완료]
 *   팝업 "다 읽었어요"(cmd:label) 는 ask 를 건너뛰고 rate 부터 (trigger 'popup').
 *
 * --- 틱 정지 ------------------------------------------------------------------
 *   ask 카드가 떠 있는 동안은 계속 기록한다 — 카드를 무시하고 읽는 사람이 많다 (2026-10-07 실측 피드백).
 *   [아직] · Esc → label:ask{answer, shownMs} (5-recorder 가 labelask 이벤트, startT = t − shownMs).
 *   [예] → label:ask{answer:'yes'} → label:mode{on:true} — 여기서부터 틱 · 선택 · 복사를 멈춘다.
 *   [완료] · [취소] → label:done{...} → label:mode{on:false}.
 *   [완료]는 곧 "이 글을 다 읽음" — 11-session 이 세션 정지를 요청한다(한 글 = 한 기록). [취소]는 정지 안 함.
 *
 * --- 끝 도달 판정 ---------------------------------------------------------------
 *   "끝" = 본문 마지막 유닛(숨지 않은 유닛 중 order 최대). 문서 맨 아래가 아니다 — 뉴스는 본문 아래가 길다.
 *   "도달" = 그 유닛의 윗변이 화면 아래 가장자리보다 위 (보이는 중이거나 이미 지나침). 참가자는 어디가
 *   마지막 유닛인지 모르니, 화면에 남아 있지 않아도 지나쳤으면 묻는다. 도달 상태가 연속 1초면 묻는다.
 *   [아직] 뒤에는 15초가 지나야 다시 묻고, 또 [아직]이면 간격을 두 배로. 구간이 새로 열리면 초기화.
 *   primary 프레임에서만 (본문을 기록하는 프레임).
 *
 * --- 숨은 유닛 = 평정 대상 아님 -----------------------------------------------------
 *   유닛 Range 의 사각형 중 폭 · 높이 > 0 인 것이 없으면 숨은 유닛 → excluded. 화면에 띄울 수 없어서다.
 *
 * --- 클릭 판정 · 가림막 (v1 그대로) ----------------------------------------------------
 *   rate · mark · survey 동안 화면 전체를 투명한 가림막(#rbc-label-shield)으로 덮는다 — 링크로 이동하지 않게
 *   (2026-10-06 네이버 뉴스 옆 기사). 유닛 판정은 좌표로만: 클릭 점을 품은 조각 상자(가장 작은 것),
 *   없으면 atCursor. extract_features A채널 귀속과 같은 규칙. ask 카드 단계는 가림막 없음.
 *   한계: 본문이 iframe(블로그 PC)이면 가림막은 그 iframe 만 덮는다.
 *
 * --- 표시 ----------------------------------------------------------------------
 *   CSS Custom Highlight(크롬 105+). rate: 평정한 유닛은 값별 옅은 색, 지금 유닛은 초록 테두리 상자 +
 *   나머지 화면을 아주 옅게 어둡게(스포트라이트), 유닛이 바뀌면 짧게 페이드인 — 색만으로는 "지금 유닛"이
 *   평정 색과 헷갈렸고, 깜빡임은 눈이 아팠다(2026-10-07). mark: 선택 진하게 · 마우스 올림 옅게.
 *   라벨 바는 화면 아래에서 조금 띄움, shadow DOM.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus } = RBC;

  const HL_OK = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
  const BLOCK = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'contextmenu'];

  const RATES = [   // 저장값 · 버튼 · 키 (명세 §3)
    ['skip', '안 읽음'], ['skim', '훑어봄'], ['read', '적당히 읽음'], ['focus', '집중해서 읽음'],
    ['unsure', '기억 안 남'],
  ];
  const SURVEY = [  // 명세 §5. 객관식만
    ['gain', '이 글에서 원하던 정보를 얻었나요?',
      [['yes', '얻었다'], ['partly', '일부만'], ['no', '못 얻었다']]],
    ['interest', '이 글 주제에 얼마나 관심이 있나요?',
      [[1, '전혀 없음'], [2, '조금'], [3, '어느 정도'], [4, '많음']]],
    ['familiarity', '이 주제를 읽기 전에 얼마나 알고 있었나요?',
      [[1, '처음 봄'], [2, '조금 앎'], [3, '어느 정도 앎'], [4, '잘 앎']]],
  ];
  const END_HOLD_MS = 1000;      // 마지막 유닛이 연속으로 보여야 하는 시간
  const ASK_BACKOFF0 = 15000;    // [아직] 뒤 첫 재질문 간격 (반복마다 두 배)

  // --- 소유 상태 ---
  let phase = null;              // null | 'ask' | 'rate' | 'mark' | 'survey'
  let trigger = null;            // 'end' | 'popup'
  let t0 = 0;                    // 라벨 시작 (performance.now). ask 부터면 카드가 뜬 때
  let askT = 0;                  // 질문 카드가 뜬 때
  let modeOn = false;            // label:mode 를 켰나 (ask 단계는 안 켬)
  let phaseT = 0;                // 지금 단계 시작
  let phaseMs = null;            // { ask, rate, mark, survey }
  let targets = [];              // 평정 대상 pid (order 순)
  let excluded = [];
  let idx = 0;                   // rate: 지금 유닛
  const ratings = new Map();     // pid → 값
  let ratingLog = [];            // [pid, 값, t0 부터 ms]
  const marks = new Set();
  let survey = {};
  let zeroOk = false;            // mark: 0개로 넘어가기 확인
  let hoverPid = null;

  // 끝 도달
  let lastPid = null, lastPidDirty = true, lastRange = null;
  let endSince = 0, nextAskAt = 0, backoff = ASK_BACKOFF0;

  // DOM
  let host = null, root = null, shield = null, curBox = null, boxRaf = 0;
  const HL = {};
  let raf = 0, lastXY = null;

  // ==========================================================================
  // 스타일 (페이지 쪽)
  // ==========================================================================
  function injectStyle() {
    const s = document.createElement('style');
    s.textContent = `
      ::highlight(rbc-r-skip){ background-color: rgba(120,120,120,.18); }
      ::highlight(rbc-r-skim){ background-color: rgba(66,140,220,.18); }
      ::highlight(rbc-r-read){ background-color: rgba(76,175,63,.20); }
      ::highlight(rbc-r-focus){ background-color: rgba(46,125,36,.36); }
      ::highlight(rbc-r-unsure){ background-color: rgba(150,90,200,.20); }
      ::highlight(rbc-m-sel){ background-color: rgba(76,175,63,.42); }
      ::highlight(rbc-m-hover){ background-color: rgba(76,175,63,.16); }
      html.rbc-labeling, html.rbc-labeling *{ cursor: pointer !important; }
      #rbc-label-cur{ position:fixed; pointer-events:none; z-index:2147483646; box-sizing:border-box;
        border:2px solid rgba(46,157,35,.85); border-radius:10px;
        box-shadow:0 0 0 4px rgba(46,157,35,.12), 0 0 0 100vmax rgba(20,28,18,.07); }
      #rbc-label-cur.in{ animation: rbc-label-in .18s ease-out; }
      @keyframes rbc-label-in{ from{ opacity:0; transform:scale(.985); } to{ opacity:1; transform:none; } }
    `;
    document.documentElement.appendChild(s);
  }

  // ==========================================================================
  // 유닛
  // ==========================================================================
  function unitRange(pid) {
    const u = RBC.units.byPid(pid);
    return u && RBC.overlay && RBC.overlay.rangeForUnit ? RBC.overlay.rangeForUnit(u) : null;
  }

  function isShown(u) {
    const r = RBC.overlay && RBC.overlay.rangeForUnit ? RBC.overlay.rangeForUnit(u) : null;
    if (!r) return false;
    for (const b of r.getClientRects()) if (b.width > 0 && b.height > 0) return true;
    return false;
  }

  function splitUnits() {
    const all = RBC.units.all().slice().sort((a, b) => a.order - b.order);
    const t = [], x = [];
    for (const u of all) (isShown(u) ? t : x).push(u.pid);
    return { t, x };
  }

  function getLastPid() {
    if (lastPidDirty) {
      lastPidDirty = false;
      const { t } = splitUnits();
      lastPid = t.length ? t[t.length - 1] : null;
      lastRange = lastPid ? unitRange(lastPid) : null;
    }
    return lastPid;
  }

  // 마지막 유닛에 도달했나: 윗변이 화면 아래 가장자리보다 위 (보이는 중 · 지나침 둘 다)
  function reachedEnd() {
    if (!getLastPid() || !lastRange) return false;
    let top = Infinity;
    for (const b of lastRange.getClientRects()) if (b.width > 0 && b.height > 0) top = Math.min(top, b.top);
    return top < window.innerHeight;
  }

  // 지금 유닛 테두리 상자 — rate 단계 동안 매 프레임 위치를 맞춘다 (스크롤 · 부드러운 이동 중에도)
  function startBox() {
    if (!curBox) {
      curBox = document.createElement('div');
      curBox.id = 'rbc-label-cur';
      document.documentElement.appendChild(curBox);
    }
    if (boxRaf) return;
    const step = () => {
      boxRaf = 0;
      if (phase !== 'rate' || !curBox) return;
      const r = targets[idx] ? unitRange(targets[idx]) : null;
      const b = r ? r.getBoundingClientRect() : null;
      if (b && b.width > 0) {
        curBox.style.display = '';
        curBox.style.left = (b.left - 6) + 'px';
        curBox.style.top = (b.top - 5) + 'px';
        curBox.style.width = (b.width + 12) + 'px';
        curBox.style.height = (b.height + 10) + 'px';
      } else {
        curBox.style.display = 'none';
      }
      boxRaf = requestAnimationFrame(step);
    };
    boxRaf = requestAnimationFrame(step);
  }

  function stopBox() {
    if (boxRaf) { cancelAnimationFrame(boxRaf); boxRaf = 0; }
    if (curBox) { curBox.remove(); curBox = null; }
  }

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

  function scrollToUnit(pid) {
    const r = unitRange(pid);
    if (!r) return;
    const b = r.getBoundingClientRect();
    const dy = b.top - window.innerHeight * 0.25;
    if (Math.abs(dy) < 4) return;
    const el = RBC.input.scroller();
    (el || window).scrollBy({ top: dy, behavior: 'smooth' });
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
  function hl(name) {
    if (!HL[name]) {
      HL[name] = new Highlight();
      HL[name].priority = name === 'rbc-m-sel' ? 21 : 20;
      CSS.highlights.set(name, HL[name]);
    }
    return HL[name];
  }

  function paint() {
    if (!HL_OK) return;
    for (const k of Object.keys(HL)) HL[k].clear();
    const add = (name, pid) => { const r = unitRange(pid); if (r) hl(name).add(r); };
    if (phase === 'rate') {
      for (const [pid, v] of ratings) add('rbc-r-' + v, pid);
    } else if (phase === 'mark') {
      for (const pid of marks) add('rbc-m-sel', pid);
      if (hoverPid && !marks.has(hoverPid)) add('rbc-m-hover', hoverPid);
    }
  }

  // ==========================================================================
  // 라벨 바 (shadow DOM, 화면 아래)
  // ==========================================================================
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function buildBar() {
    host = document.createElement('div');
    host.id = 'rbc-label-bar';
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
      'display:flex;justify-content:center;pointer-events:none;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .bar{ pointer-events:auto; margin-bottom:56px; padding:12px 16px; border-radius:12px; background:#fff;
          color:#1f2a1c; font:14px/1.45 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif;
          box-shadow:0 6px 24px rgba(0,0,0,.2); border:1px solid #d9e8d2; max-width:calc(100vw - 24px); }
        .hd{ display:flex; align-items:baseline; gap:10px; margin-bottom:8px; }
        .hd b{ font-size:14px; } .hd small{ color:#5d6b58; font-size:12px; }
        .n{ margin-left:auto; font-weight:600; color:#2f7d24; white-space:nowrap; font-variant-numeric:tabular-nums; }
        .row{ display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
        .q{ margin:6px 0 2px; font-size:13px; }
        .sp{ flex:1; min-width:8px; }
        .warn{ color:#7a5b0c; font-size:12.5px; margin-top:6px; }
        button{ font:inherit; font-size:13px; padding:7px 11px; border-radius:8px; cursor:pointer;
          border:1px solid #cfd8cb; background:#fff; color:#1f2a1c; white-space:nowrap; }
        button kbd{ font:11px ui-monospace,monospace; color:#7a8576; margin-right:4px; }
        button.on{ background:#e3f2dd; border-color:#4caf3f; font-weight:600; }
        button.ok{ background:#4caf3f; border-color:#4caf3f; color:#fff; font-weight:600; }
        button:disabled{ opacity:.45; cursor:default; }
        .r-skip.on{ background:#ececec; border-color:#888; } .r-skim.on{ background:#e3eefb; border-color:#428cdc; }
        .r-unsure.on{ background:#f0e6f8; border-color:#965ac8; }
      </style>
      <div class="bar" role="dialog" aria-label="읽기 평가"></div>`;
    root.querySelector('.bar').addEventListener('click', onBarClick);
    document.documentElement.appendChild(host);
  }

  function render() {
    if (!root) return;
    const bar = root.querySelector('.bar');
    let h = '';
    if (phase === 'ask') {
      h = `<div class="hd"><b>이 글을 다 읽었나요?</b><small>예를 누르면 짧은 평가가 시작돼요 (1~2분)</small></div>
        <div class="row"><button class="ok" data-a="yes">예, 다 읽었어요</button>
        <button data-a="no">아직이요</button></div>`;
    } else if (phase === 'rate') {
      const pid = targets[idx];
      const cur = pid ? ratings.get(pid) : null;
      const done = ratings.size >= targets.length;   // 보이는 유닛이 0개인 글도 넘어갈 수 있게
      h = `<div class="hd"><b>초록 상자 안 부분을 어떻게 읽었나요?</b>
          <small>누르면 다음으로 넘어가요 · ← 이전 · 다른 부분을 클릭하면 그곳으로 · Esc 취소</small>
          <span class="n">${Math.min(idx + 1, targets.length)} / ${targets.length}</span></div>
        <div class="row">${RATES.map(([v, t], i) =>
          `<button class="r-${v}${cur === v ? ' on' : ''}" data-r="${v}"><kbd>${i + 1}</kbd>${t}</button>`).join('')}
          <span class="sp"></span>
          <button data-a="prev"${idx > 0 ? '' : ' disabled'}>이전</button>
          <button class="ok" data-a="next"${done ? '' : ' disabled'}>다음 단계</button>
          <button data-a="cancel">취소</button></div>`;
    } else if (phase === 'mark') {
      h = `<div class="hd"><b>가장 중요하거나 기억하고 싶은 부분을 눌러 표시하세요</b>
          <small>여러 개 가능 · 다시 누르면 해제 · 새로 읽지 말고 기억나는 대로</small>
          <span class="n">선택 ${marks.size}개</span></div>
        <div class="row"><span class="sp"></span>
          <button data-a="back">이전 단계</button>
          <button class="ok" data-a="next">${!marks.size && zeroOk ? '그대로 넘어가기' : '다음 단계'}</button>
          <button data-a="cancel">취소</button></div>
        ${!marks.size && zeroOk ? '<div class="warn">하나도 고르지 않았어요. 그대로 넘어갈까요?</div>' : ''}`;
    } else if (phase === 'survey') {
      const all = SURVEY.every(([k]) => survey[k] != null);
      h = `<div class="hd"><b>마지막으로 세 가지만 골라 주세요</b></div>
        ${SURVEY.map(([k, q, opts]) => `<div class="q">${esc(q)}</div><div class="row">${opts.map(([v, t]) =>
          `<button class="${survey[k] === v ? 'on' : ''}" data-k="${k}" data-v="${v}">${esc(t)}</button>`).join('')}</div>`).join('')}
        <div class="row" style="margin-top:10px"><span class="sp"></span>
          <button data-a="back">이전 단계</button>
          <button class="ok" data-a="done"${all ? '' : ' disabled'}>완료</button>
          <button data-a="cancel">취소</button></div>`;
    }
    bar.innerHTML = h;
  }

  function onBarClick(e) {
    const b = e.target.closest && e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.r) return rate(b.dataset.r);
    if (b.dataset.k) {
      const opt = SURVEY.find(([k]) => k === b.dataset.k)[2].find(([v]) => String(v) === b.dataset.v);
      survey[b.dataset.k] = opt[0];
      return render();
    }
    switch (b.dataset.a) {
      case 'yes': return answerAsk('yes');
      case 'no': return answerAsk('no');
      case 'prev': return move(idx - 1);
      case 'next':
        if (phase === 'rate') return go('mark');
        if (phase === 'mark') {
          if (!marks.size && !zeroOk) { zeroOk = true; return render(); }
          return go('survey');
        }
        return undefined;
      case 'back': return go(phase === 'survey' ? 'mark' : 'rate');
      case 'done': return exit(false);
      case 'cancel': return exit(true);
      default: return undefined;
    }
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

  // ==========================================================================
  // 가림막 (rate · mark · survey)
  // ==========================================================================
  function buildShield() {
    if (shield) return;
    shield = document.createElement('div');
    shield.id = 'rbc-label-shield';
    shield.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;' +
      'background:transparent;cursor:pointer;';
    shield.addEventListener('mousedown', (e) => e.preventDefault());   // 포커스 · 선택 안 생기게
    shield.addEventListener('click', onShieldClick);
    shield.addEventListener('mousemove', onMove);
    shield.addEventListener('wheel', onWheel, { passive: false });
    shield.addEventListener('contextmenu', (e) => e.preventDefault());
    document.documentElement.insertBefore(shield, host);               // 바보다 먼저 → 바가 위
    document.documentElement.classList.add('rbc-labeling');
    for (const t of BLOCK) window.addEventListener(t, onBlock, true);
    try { window.getSelection().removeAllRanges(); } catch (e) { /* noop */ }
  }

  function removeShield() {
    if (!shield) return;
    for (const t of BLOCK) window.removeEventListener(t, onBlock, true);
    shield.remove(); shield = null;
    document.documentElement.classList.remove('rbc-labeling');
  }

  function onShieldClick(e) {
    e.preventDefault();
    if (e.button !== 0) return;
    const pid = pidAt(e.clientX, e.clientY);
    if (!pid) return;
    if (phase === 'rate') {
      const i = targets.indexOf(pid);
      if (i >= 0) move(i, true);
    } else if (phase === 'mark') {
      if (marks.has(pid)) marks.delete(pid); else marks.add(pid);
      zeroOk = false;
      paint(); render();
    }
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
    if (phase !== 'mark') return;
    lastXY = [e.clientX, e.clientY];
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const p = lastXY ? pidAt(lastXY[0], lastXY[1]) : null;
      if (p !== hoverPid) { hoverPid = p; paint(); }
    });
  }

  function onKey(e) {
    if (!phase) return;
    let used = true;
    if (e.key === 'Escape') {
      if (phase === 'ask') answerAsk('cancel'); else exit(true);
    } else if (phase === 'rate' && e.key >= '1' && e.key <= String(RATES.length)) {
      rate(RATES[Number(e.key) - 1][0]);
    } else if (phase === 'rate' && e.key === 'ArrowLeft') {
      move(idx - 1);
    } else if (phase === 'rate' && e.key === 'ArrowRight') {
      move(idx + 1);
    } else {
      used = false;
    }
    if (used) { e.preventDefault(); e.stopPropagation(); }
  }

  // ==========================================================================
  // 단계 동작
  // ==========================================================================
  function rate(v) {
    const pid = targets[idx];
    if (!pid) return;
    ratings.set(pid, v);
    ratingLog.push([pid, v, Math.round(performance.now() - t0)]);
    if (idx < targets.length - 1) move(idx + 1);
    else { paint(); render(); }
  }

  function move(i, noScroll) {
    if (i < 0 || i >= targets.length) return;
    if (i !== idx && curBox) {                       // 유닛이 바뀌면 상자를 짧게 페이드인
      curBox.classList.remove('in');
      void curBox.offsetWidth;
      curBox.classList.add('in');
    }
    idx = i;
    if (!noScroll) scrollToUnit(targets[idx]);
    paint(); render();
  }

  function tickPhase() {
    const now = performance.now();
    if (phase && phaseMs) phaseMs[phase] += Math.round(now - phaseT);
    phaseT = now;
  }

  function go(p) {
    tickPhase();
    phase = p;
    hoverPid = null;
    if (p === 'rate') {
      if (!targets.length && !excluded.length) {
        const s = splitUnits();
        targets = s.t; excluded = s.x;
        idx = 0;
      }
      buildShield();
      scrollToUnit(targets[idx]);
      startBox();
    } else {
      stopBox();
    }
    if (p === 'mark') zeroOk = false;
    paint(); render();
  }

  // 라벨 모드 켜기. 'ask' 또는 'rate' 부터.
  function begin(first, trig) {
    if (!RBC.recorder.isRecording()) {
      if (first === 'rate') toast('이 탭은 지금 기록 중이 아니라 평가를 남길 수 없습니다.');
      return;
    }
    trigger = trig;
    t0 = performance.now();
    askT = t0;
    phaseT = t0;
    phaseMs = { ask: 0, rate: 0, mark: 0, survey: 0 };
    targets = []; excluded = []; idx = 0;
    ratings.clear(); ratingLog = []; marks.clear(); survey = {}; zeroOk = false;
    if (first !== 'ask') setMode(true);              // ask 카드 동안은 계속 기록
    buildBar();
    window.addEventListener('keydown', onKey, true);
    phase = null;
    go(first);
  }

  function setMode(on) {
    if (on === modeOn) return;
    modeOn = on;
    bus.emit('label:mode', { on });                  // 5-recorder: 틱 멈춤 / 재개
  }

  function teardown() {
    window.removeEventListener('keydown', onKey, true);
    stopBox();
    removeShield();
    if (host) { host.remove(); host = null; root = null; }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    phase = null;
    hoverPid = null;
    paint();
    if (HL_OK) for (const k of Object.keys(HL)) HL[k].clear();
  }

  function answerAsk(answer) {
    if (phase !== 'ask') return;
    bus.emit('label:ask', { answer, shownMs: Math.round(performance.now() - askT) });   // 5-recorder: labelask
    if (answer === 'yes') {
      t0 = performance.now();                        // 평정 시각(ratingLog)은 라벨 모드 시작부터
      setMode(true);
      go('rate');
      return;
    }
    teardown();
    nextAskAt = performance.now() + backoff;
    backoff *= 2;
    endSince = 0;
  }

  // cancelled: 취소 · Esc. silent: 구간이 이미 닫혀서 남길 곳이 없음.
  function exit(cancelled, silent) {
    if (!phase) return;
    if (phase === 'ask') {                            // 카드 중 구간이 닫힘 (모드는 안 켠 상태)
      teardown();
      return;
    }
    tickPhase();
    const order = (pid) => { const u = RBC.units.byPid(pid); return u ? u.order : 1e9; };
    const payload = {
      cancelled: !!cancelled,
      trigger,
      phaseMs,
      ratings: Object.fromEntries(ratings),
      ratingLog,
      excluded: excluded.slice(),
      marks: [...marks].sort((a, b) => order(a) - order(b)),
      survey: { ...survey },
    };
    teardown();
    if (!silent) bus.emit('label:done', payload);   // 5-recorder: label 이벤트 → 11-session: 정지(완료일 때)
    setMode(false);                                  // 5-recorder: 틱 재개
    if (!silent && !cancelled) toast('평가를 저장했습니다 · 기록을 마치고 파일로 저장합니다');
    if (!silent && cancelled) { nextAskAt = performance.now() + backoff; endSince = 0; }
  }

  // ==========================================================================
  // 구독
  // ==========================================================================
  bus.on('cmd:label', () => {
    if (phase === 'ask') answerAsk('yes');
    else if (!phase) begin('rate', 'popup');
  });

  // 끝 도달: 읽는 중(phase null) · primary · 기록 중일 때 틱마다 (라벨 모드면 틱이 없음)
  bus.on('tick:done', () => {
    if (phase || !RBC.frames.isPrimary() || !RBC.recorder.isRecording()) return;
    const now = performance.now();
    if (!reachedEnd()) { endSince = 0; return; }
    if (!endSince) endSince = now;
    if (now - endSince >= END_HOLD_MS && now >= nextAskAt) begin('ask', 'end');
  });

  // 재스캔으로 유닛이 바뀌면(append · splice): 끝 유닛 다시 계산. 평정 중이면 대상 목록을 새로 만들고
  //   (새 유닛은 끼워 넣음 — 빠지면 [17] FAIL), 사라진 pid 는 평정 · 표시에서 뺀다. 지금 유닛은 유지.
  bus.on('units:changed', () => {
    lastPidDirty = true;
    if (!phase || phase === 'ask') return;
    const alive = (pid) => !!RBC.units.byPid(pid);
    const curPid = targets[idx];
    if (targets.length || excluded.length) {
      const sp = splitUnits();
      targets = sp.t; excluded = sp.x;
      const k = targets.indexOf(curPid);
      if (k >= 0) idx = k;
    }
    for (const pid of [...ratings.keys()]) if (!alive(pid)) ratings.delete(pid);
    for (const pid of [...marks]) if (!alive(pid)) marks.delete(pid);
    idx = Math.min(idx, Math.max(0, targets.length - 1));
    paint(); render();
  });

  // 새 구간: 끝 도달 상태 초기화
  bus.on('record:started', () => {
    endSince = 0; nextAskAt = 0; backoff = ASK_BACKOFF0; lastPidDirty = true;
  });

  // 라벨 중에 구간이 닫히면(세션 정지 · 이동) 남길 곳이 없다 — 조용히 끈다.
  bus.on('record:stopped', () => exit(true, true));

  RBC.label = { isOn: () => !!phase, phase: () => phase };

  injectStyle();
})();