/* =============================================================================
 * 9-panel.js — 디버그 패널 (최상위 프레임 전용)
 *
 * 소유: panelEl, listEl, uiRecording, uiOverlay
 * 의존(직접 호출): 0-core, RBC.frames, RBC.recorder   ← 전부 자기보다 낮은 번호
 * 발행: cmd:* (버튼이 명령을 쏜다)
 * 구독: stat, units:list, record:started, record:stopped,
 *       scan:progress, scan:failed, scan:done
 *
 * --- 판정 기준 --------------------------------------------------------------
 *   manifest에서 8-overlay.js 와 9-panel.js 를 둘 다 빼면 순수 수집기만 남는다.
 *   그 상태에서 콘솔로 RBC.frames.doScan() → RBC.recorder... 를 직접 불러
 *   수집이 도는 것이 Step 1 전체의 최종 판정이다.
 *
 * --- v2.2 대비 달라진 점 ----------------------------------------------------
 *   [R6]  전: tick() 이 emitStat() → applyStat() 을 직접 호출  → stat 구독
 *   [R7]  전: tick() 이 autostop 에서 renderPanel() 직접 호출  → record:stopped 구독
 *   [R9]  전: startRecording/stopRecording 이 renderPanel() 호출 → 위와 동일
 *   [R10] 전: doScan() 이 setStat()/renderPanel() 직접 호출
 *             → scan:progress / scan:failed / scan:done 구독.
 *               6-frames 는 "사실"만 넘기고, 문장으로 만드는 건 여기 몫이다.
 *   uiRecording / uiOverlay 의 소유자도 여기로 옮겼다.
 *
 * --- BUG-1 / BUG-2 방어 -----------------------------------------------------
 *   기록 중에는 스캔 버튼과 청크 슬라이더를 잠근다. 기록 도중 재청킹이 일어나면
 *   이미 쌓인 timeline 의 pid 와 meta.paragraphs 의 pid 가 어긋나서 세션이
 *   통째로 무효가 되는데, 아무 경고도 안 뜬다.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  if (!RBC.IS_TOP) return;               // 패널은 최상위 프레임에만 뜬다
  const { CFG, bus, TAG } = RBC;
  const { esc, uuid } = RBC.util;

  // --- 이 파일이 소유하는 상태 ---
  let panelEl = null, listEl = null;
  let uiRecording = false;
  let uiOverlay = false;

  // ==========================================================================
  // 스타일 — 원본 injectStyle() 에서 패널 몫만.
  //          오버레이 규칙은 8-overlay.js 가 가져갔다.
  // ==========================================================================
  function injectStyle() {
    const s = document.createElement('style');
    s.textContent = `
      #${CFG.PANEL_ID}{
        position:fixed; right:12px; bottom:12px; z-index:2147483647;
        width:272px; font:12px/1.45 system-ui,-apple-system,sans-serif; color:#111;
        background:#fff; border:1px solid #ddd; border-radius:10px;
        box-shadow:0 4px 16px rgba(0,0,0,.16); padding:10px; }
      #${CFG.PANEL_ID} h4{ margin:0 0 6px; font-size:12px; }
      #${CFG.PANEL_ID} button{
        font:11px system-ui; padding:5px 7px; margin:2px 2px 0 0;
        border:1px solid #ccc; border-radius:6px; background:#f7f7f7; cursor:pointer; }
      #${CFG.PANEL_ID} button.on{ background:#16a34a; color:#fff; border-color:#16a34a; }
      #${CFG.PANEL_ID} button[disabled]{ opacity:.45; cursor:not-allowed; }
      #${CFG.PANEL_ID} .rbc-row{ margin-top:6px; font-size:11px; color:#555;
        display:flex; align-items:center; gap:6px; }
      #${CFG.PANEL_ID} input[type=range]{ flex:1; }
      #${CFG.PANEL_ID} input[type=text]{ flex:1; min-width:0; font:11px system-ui;
        padding:3px 5px; border:1px solid #ccc; border-radius:5px; }
      #${CFG.PANEL_ID} .rbc-stat{ margin-top:8px; font-size:11px; color:#333;
        border-top:1px solid #eee; padding-top:6px; word-break:break-all; }
      #${CFG.PANEL_ID} .rbc-list{ margin-top:6px; max-height:190px; overflow:auto;
        border-top:1px solid #eee; padding-top:6px; font-size:11px; display:none; }
      #${CFG.PANEL_ID} .rbc-list div{ padding:2px 0; border-bottom:1px dotted #eee;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #${CFG.PANEL_ID} .rbc-list b{ color:#2563eb; }
      #${CFG.PANEL_ID} .dot{ display:inline-block; width:8px; height:8px;
        border-radius:50%; margin-right:4px; vertical-align:middle; }
    `;
    document.documentElement.appendChild(s);
  }

  // ==========================================================================
  // 렌더
  // ==========================================================================
  function render() {
    if (!panelEl) {
      panelEl = document.createElement('div');
      panelEl.id = CFG.PANEL_ID;
      document.documentElement.appendChild(panelEl);
    }
    const prevStat = panelEl.querySelector('#rbc-stat');
    const keep = prevStat ? prevStat.innerHTML : '스캔 준비 중…';
    const lock = uiRecording ? 'disabled' : '';      // BUG-1 / BUG-2 방어

    panelEl.innerHTML = `
      <h4>📖 Reading Behavior Collector <span style="color:#999;font-weight:400">v2.2</span></h4>
      <div>
        <button data-act="scan" ${lock}>스캔</button>
        <button data-act="rec" class="${uiRecording ? 'on' : ''}">${uiRecording ? '■ 정지' : '● 기록'}</button>
        <button data-act="ov" class="${uiOverlay ? 'on' : ''}">오버레이</button>
        <button data-act="list">유닛 목록</button>
        <button data-act="exp">JSON</button>
      </div>
      <div class="rbc-row">
        <span>검색어</span>
        <input type="text" data-act="query" placeholder="referrer에서 못 얻으면 직접"
               value="${esc(RBC.recorder.query() || '')}">
      </div>
      <div class="rbc-row">
        <span>청크</span>
        <input type="range" min="80" max="400" step="20" value="${CFG.TARGET_CHARS}"
               data-act="chunk" ${lock}>
        <span id="rbc-chunkval">${CFG.TARGET_CHARS}자</span>
      </div>
      <div class="rbc-stat" id="rbc-stat">${keep}</div>
      <div class="rbc-list" id="rbc-list"></div>
    `;
    listEl = panelEl.querySelector('#rbc-list');

    // 주의: onclick 에 doScan 을 직접 넣으면 이벤트 객체가 auto 인자로 들어가
    //       재시도 카운터가 리셋되지 않는다.
    panelEl.querySelector('[data-act="scan"]').onclick = () => {
      if (uiRecording) {                              // BUG-2
        setStat('기록 중에는 스캔할 수 없습니다. 정지 후 다시 시도하세요.');
        return;
      }
      RBC.frames.doScan();
    };

    panelEl.querySelector('[data-act="rec"]').onclick = () => {
      if (uiRecording) {
        uiRecording = false;
        RBC.frames.send('stop');
      } else {
        uiRecording = true;
        RBC.frames.send('start', {
          epoch: Date.now(), sessionId: uuid(), query: RBC.recorder.query(),
        });
      }
      render();
    };

    panelEl.querySelector('[data-act="ov"]').onclick = () => {
      uiOverlay = !uiOverlay;
      RBC.frames.send('overlay', { on: uiOverlay });
      render();
    };

    panelEl.querySelector('[data-act="list"]').onclick = () => {
      if (listEl.style.display === 'block') { listEl.style.display = 'none'; return; }
      RBC.frames.send('list');
    };

    panelEl.querySelector('[data-act="exp"]').onclick = () => RBC.frames.send('export');

    const q = panelEl.querySelector('[data-act="query"]');
    q.onchange = (e) => {
      RBC.frames.send('query', { q: e.target.value.trim() || null });
    };

    const slider = panelEl.querySelector('[data-act="chunk"]');
    slider.oninput = (e) => {
      panelEl.querySelector('#rbc-chunkval').textContent = e.target.value + '자';
    };
    slider.onchange = (e) => RBC.frames.send('chunk', { target: +e.target.value });
  }

  // ==========================================================================
  // 상태줄
  // ==========================================================================
  function setStat(html) {
    const el = panelEl && panelEl.querySelector('#rbc-stat');
    if (el) el.innerHTML = html;
  }

  function applyStat(s) {
    if (!panelEl || !s) return;
    setStat(`
      <span class="dot" style="background:${s.recording ? '#16a34a' : '#bbb'}"></span>
      ${s.recording ? '기록 중' : '대기'} · 샘플 ${s.samples}개 · 유닛 ${s.units}개
      ${s.recording ? `· focus ${s.focusSec}s` : ''}<br>
      <b style="color:#16a34a">중앙선(B)</b>: ${esc(s.centerPid) || '—'} <i>${esc(s.centerText)}</i><br>
      <b style="color:#2563eb">커서(A)</b>: ${esc(s.cursorPid) || '여백/없음'}<br>
      scrollSpeed: ${s.scrollSpeed} px/s
      ${s.query ? `· 검색어 "${esc(s.query)}"` : '· <span style="color:#c00">검색어 없음</span>'}
      ${s.tag !== TAG ? `<br><span style="color:#999">frame ${esc(s.tag)}</span>` : ''}
    `);
  }

  function showList(list) {
    if (!listEl || !list) return;
    listEl.style.display = 'block';
    listEl.innerHTML = list.map(u =>
      `<div><b>#${u.order}</b> <span style="color:#999">${esc(u.pid)}</span> ` +
      `(${u.charLen}자) ${esc(u.text)}</div>`
    ).join('') || '<div>유닛 없음</div>';
  }

  // ==========================================================================
  // 구독 — 여기가 R6 · R7 · R9 · R10 을 끊은 자리
  // ==========================================================================

  // [R6] 전: emitStat() 안에서 if (IS_TOP) applyStat(s);
  bus.on('stat', applyStat);

  bus.on('units:list', showList);

  // [R7][R9] 전: startRecording / stopRecording / autostop 이 renderPanel() 호출.
  //   일반 시작·정지는 버튼 핸들러가 낙관적으로 먼저 갱신하므로, 이 구독이
  //   실제로 쓰이는 건 30분 무동작 자동 종료 때다. 그때 패널이 안 돌아오면
  //   사용자는 아직 기록 중인 줄 안다.
  bus.on('record:started', () => { uiRecording = true; render(); });
  bus.on('record:stopped', () => { uiRecording = false; render(); });

  // [R10] 전: doScan() 안에서 setStat(...) / renderPanel().
  //   6-frames 는 숫자만 넘기고 문장 조립은 여기서 한다.
  bus.on('scan:progress', (d) => {
    setStat(`본문 탐색 중… (${d.tries}/${d.max})`);
  });

  bus.on('scan:failed', () => {
    setStat('본문을 못 찾음. 페이지가 다 뜬 뒤 <b>스캔</b>을 다시 눌러주세요.');
  });

  bus.on('scan:done', (d) => {
    setStat(
      `프레임 ${d.frames}개 · primary=${esc(d.tag)}` +
      (d.isSelf ? ' (본 페이지)' : ' (iframe)') +
      `<br>유닛 <b>${d.units}</b>개 · 본문 ${d.chars.toLocaleString()}자`
    );
    render();
  });

  // ==========================================================================
  // 공개 + 마운트
  //   init() 이 renderPanel() 을 부르던 것을 자가 마운트로 바꿨다.
  //   content.js 의 init() 은 readyState 에 따라 9-panel.js 보다 먼저 돌 수 있어서,
  //   거기서 패널을 부르면 "가끔" undefined 가 된다.
  // ==========================================================================
  RBC.panel = { render, setStat };

  injectStyle();
  render();
})();