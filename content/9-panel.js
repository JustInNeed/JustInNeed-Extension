/* =============================================================================
 * 9-panel.js — 디버그 패널 (최상위 프레임 전용)
 *
 * 소유: panelEl, listEl, uiRecording, uiOverlay, visible
 * 의존(직접 호출): 0-core, RBC.frames, RBC.recorder, RBC.units   ← 전부 자기보다 낮은 번호
 * 발행: cmd:* (스캔·오버레이·목록·청크·검색어), ui:rec, ui:export, ui:query
 * 구독: stat, units:list, session:changed, session:link,
 *       scan:progress, scan:failed, scan:done, ui:panel, units:rescanned
 *
 * --- 보이기 / 숨기기 (기본 숨김) ----------------------------------------------
 *   참가자 화면에 패널이 뜨면 읽기 행동을 오염시키고, 청크 슬라이더를 만질 수 있다.
 *   그래서 기본은 숨김이고, 참여 정보 페이지의 "연구자용 설정"에서 켠다(서현 결정 2026-10-06).
 *   설정은 chrome.storage.local 'ui:panel' — content 쪽에서 chrome.* 는 11-session 만 쓰므로
 *   11-session 이 읽어서 ui:panel{on} 으로 알린다. 열린 탭에도 바로 반영된다(storage.onChanged).
 *   숨기면 DOM 을 통째로 뺀다. 상태(uiRecording 등)는 계속 갱신되고, 켜면 다시 그린다.
 *   숨길 때 오버레이가 켜져 있으면 끈다 — 오버레이 버튼이 패널 안에 있어서 못 끄게 되니까.
 *
 * --- 상태줄은 primary 프레임 것만 그린다 -------------------------------------
 *   stat 은 모든 프레임에서 올라온다. 광고 iframe 이 재스캔할 때마다 그 iframe 의
 *   "유닛 1개" 가 상태줄을 덮어써서 기록이 이상해 보였다(데이터는 멀쩡했다).
 *   선출 전에는 자기 프레임 것만, 선출 뒤에는 primary 것만 받는다.
 *
 * --- 연결 끊김 표시 ----------------------------------------------------------
 *   11-session 이 background 에 못 닿으면 session:link 로 알린다. 버튼은
 *   background 응답으로만 바뀌므로, 이게 없으면 "버튼이 안 눌린다"로만 보인다.
 *
 * --- 판정 기준 --------------------------------------------------------------
 *   manifest에서 8-overlay.js 와 9-panel.js 를 둘 다 빼면 순수 수집기만 남는다.
 *   그 상태에서 콘솔로 RBC.frames.doScan() → RBC.recorder... 를 직접 불러
 *   수집이 도는 것이 Step 1 전체의 최종 판정이다.
 *
 * --- 기록 · JSON 버튼은 세션을 직접 만지지 않는다 ------------------------------
 *   세션은 background 소유다. 버튼은 ui:rec / ui:export 를 발행하고, 11-session 이
 *   background 에 요청한다. 시작/정지는 background 의 방송으로 일어난다.
 *   그래서 버튼 상태(uiRecording)도 낙관적으로 먼저 바꾸지 않고 session:changed
 *   로만 바꾼다. 다른 탭에서 시작한 세션, 30분 무동작 종료, 웹앱에서 온 명령
 *   (나중)까지 전부 같은 경로로 버튼에 반영된다.
 *
 *   record:started / record:stopped 는 이제 "구간"의 시작/끝이라 버튼에 쓰면
 *   안 된다. SPA 이동으로 구간이 닫힐 때 버튼이 "기록"으로 돌아가 버린다.
 *
 * --- v2.2 대비 달라진 점 ----------------------------------------------------
 *   [R6]  전: tick() 이 emitStat() → applyStat() 을 직접 호출  → stat 구독
 *   [R7]  전: tick() 이 autostop 에서 renderPanel() 직접 호출  → session:changed 구독
 *   [R9]  전: startRecording/stopRecording 이 renderPanel() 호출 → 위와 동일
 *   [R10] 전: doScan() 이 setStat()/renderPanel() 직접 호출
 *             → scan:progress / scan:failed / scan:done 구독.
 *               6-frames 는 "사실"만 넘기고, 문장으로 만드는 건 여기 몫이다.
 *   uiRecording / uiOverlay 의 소유자도 여기로 옮겼다.
 *
 * --- BUG-1 / BUG-2 방어 -----------------------------------------------------
 *   세션 중에는 스캔 버튼과 청크 슬라이더를 잠근다. 기록 도중 재청킹이 일어나면
 *   이미 쌓인 timeline 의 pid 와 meta.paragraphs 의 pid 가 어긋나서 세션이
 *   통째로 무효가 되는데, 아무 경고도 안 뜬다. 잠금 기준이 구간이 아니라
 *   세션인 이유: 한 세션 안의 글들은 같은 청킹 설정으로 잘려야 비교가 된다.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  if (!RBC.IS_TOP) return;               // 패널은 최상위 프레임에만 뜬다
  const { CFG, bus, TAG } = RBC;
  const { esc } = RBC.util;

  // --- 이 파일이 소유하는 상태 ---
  let panelEl = null, listEl = null;
  let uiRecording = false;               // 세션 상태의 표시용 사본. session:changed 로만 바뀐다
  let uiOverlay = false;
  let visible = false;                   // ui:panel 로만 바뀐다. 기본 숨김
  let rescanHtml = '';                   // 마지막 재스캔 한 줄 (기록 중 splice 를 눈으로 보려고, 0-B)
  let linkMsg = '';                      // background 연결 문제. 비어 있으면 정상

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
      #${CFG.PANEL_ID} .rbc-link{ margin-top:8px; padding:6px; font-size:11px;
        color:#991b1b; background:#fef2f2; border:1px solid #fecaca; border-radius:6px; }
      #${CFG.PANEL_ID} .dot{ display:inline-block; width:8px; height:8px;
        border-radius:50%; margin-right:4px; vertical-align:middle; }
    `;
    document.documentElement.appendChild(s);
  }

  // ==========================================================================
  // 렌더
  // ==========================================================================
  function render() {
    if (!visible) {
      if (panelEl) { panelEl.remove(); panelEl = null; listEl = null; }
      return;
    }
    if (!panelEl) {
      panelEl = document.createElement('div');
      panelEl.id = CFG.PANEL_ID;
      document.documentElement.appendChild(panelEl);
    }
    const prevStat = panelEl.querySelector('#rbc-stat');
    const keep = prevStat ? prevStat.innerHTML : '스캔 준비 중…';
    const lock = uiRecording ? 'disabled' : '';      // BUG-1 / BUG-2 방어

    panelEl.innerHTML = `
      <h4>📖 Reading Behavior Collector <span style="color:#999;font-weight:400">v2.3</span></h4>
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
        <input type="range" min="80" max="400" step="20" value="${RBC.units.opts().target}"
               data-act="chunk" ${lock}>
        <span id="rbc-chunkval">${RBC.units.opts().target}자</span>
      </div>
      ${linkMsg ? `<div class="rbc-link">${linkMsg}</div>` : ''}
      <div class="rbc-stat" id="rbc-stat">${keep}</div>
      <div class="rbc-stat" id="rbc-rescan">${rescanHtml}</div>
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

    // 요청만 한다. 버튼은 session:changed 가 오면 바뀐다.
    panelEl.querySelector('[data-act="rec"]').onclick = () => bus.emit('ui:rec');

    panelEl.querySelector('[data-act="ov"]').onclick = () => {
      uiOverlay = !uiOverlay;
      RBC.frames.send('overlay', { on: uiOverlay });
      render();
    };

    panelEl.querySelector('[data-act="list"]').onclick = () => {
      if (listEl.style.display === 'block') { listEl.style.display = 'none'; return; }
      RBC.frames.send('list');
    };

    // 세션 bundle 은 background 가 만든다. 받아서 저장하는 건 11-session → 6-frames.
    panelEl.querySelector('[data-act="exp"]').onclick = () => bus.emit('ui:export');

    // 검색어는 두 군데로 간다: 페이지 meta 에 넣는 recorder(모든 프레임)와,
    // 세션 검색어를 기록하는 background.
    const q = panelEl.querySelector('[data-act="query"]');
    q.onchange = (e) => {
      const v = e.target.value.trim() || null;
      RBC.frames.send('query', { q: v });
      bus.emit('ui:query', { q: v });
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

  // s.recording 은 "이 탭에서 지금 구간을 기록 중"이다. 세션 여부는 버튼이 보여준다.
  function applyStat(s) {
    if (!panelEl || !s) return;
    const primary = RBC.frames.primaryTag();
    if (primary ? s.tag !== primary : s.tag !== TAG) return;   // 광고 iframe 등은 무시
    setStat(`
      <span class="dot" style="background:${s.recording ? '#16a34a' : '#bbb'}"></span>
      ${s.recording ? '기록 중' : '대기'} · 샘플 ${s.samples}개 · 유닛 ${s.units}개
      ${s.recording ? `· focus ${s.focusSec}s` : ''}<br>
      <b style="color:#16a34a">중앙선(B)</b>: ${esc(s.centerPid) || '—'} <i>${esc(s.centerText)}</i><br>
      <b style="color:#2563eb">커서(A)</b>: ${esc(s.cursorPid) || '여백/없음'}<br>
      scrollSpeed: ${s.scrollSpeed} px/s
      ${s.query ? `· 검색어 "${esc(s.query)}"` : '· <span style="color:#c00">검색어 없음</span>'}
      ${s.sampleMs ? `<br><span style="color:${s.sampleMs.p95 > 10 ? '#c00' : '#333'}">` +
        `sample p95 ${s.sampleMs.p95}ms (그중 vis ${s.sampleMs.visP95}ms) · max ${s.sampleMs.max}ms` +
        ` (최근 ${s.sampleMs.n}틱)</span> · 측정 조각 ${s.sampleMs.pieces} · 화면 조각 ${s.visN}` : ''}
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

  // [R7][R9] 버튼은 세션 상태만 따른다. 11-session 이 background 의 방송·hello
  //   응답을 받을 때마다 발행한다.
  bus.on('session:changed', (d) => {
    const on = !!(d && d.recording);
    if (on === uiRecording) return;
    uiRecording = on;
    render();
  });

  // 재스캔 결과 한 줄: 기록 중 토글을 열거나 늦게 그려질 때 무슨 일이 났는지 바로 보이게.
  //   splice 면 유지 · 새 · 사라짐 · 자체 검증([0,0] = 정상) · 루트. 루트가 바뀌면 빨갛게.
  const RESCAN_KO = { full: '전체 재청킹', append: '끝에 추가', splice: '중간 변경(splice)' };
  let sameN = 0, sameMax = 0;            // 글 변화 없는 재스캔(호버 UI 등) 횟수 · 최대 ms
  bus.on('units:rescanned', (d) => {
    if (!d) return;
    if (d.mode === 'same') {
      sameN++; sameMax = Math.max(sameMax, d.ms || 0);
      const el = panelEl && panelEl.querySelector('#rbc-same');
      if (el) el.textContent = ` · 글 변화 없는 재스캔 ${sameN}회 (최대 ${sameMax}ms)`;
      return;
    }
    const t = new Date().toTimeString().slice(0, 8);
    const kind = d.inline ? '문단 안 변경(제자리 수정)' : (RESCAN_KO[d.mode] || esc(d.mode));
    let s = `<b>재스캔</b> ${t} · ${kind} · ${d.ms != null ? d.ms + 'ms · ' : ''}유닛 ${d.count}`;
    if (d.mode === 'splice') {
      const ok = d.check && d.check[0] === 0;
      s += ` · 유지 ${d.kept} · 새 ${d.added} · 사라짐 ${d.retired}` +
        ` · 검증 <span style="color:${ok ? '#16a34a' : '#dc2626'}">${esc(JSON.stringify(d.check))}</span>`;
      if (d.diff && d.diff.unit != null) s += ` · 첫 변경 #${d.diff.unit}`;
    }
    if (d.rootChanged) {
      s += ` <span style="color:#dc2626;font-weight:600">· 루트 바뀜! ${esc(d.rootFrom)} → ${esc(d.root)}</span>`;
    } else if (d.root) {
      s += ` · 루트 ${esc(d.root)}`;
    }
    const ri = RBC.stream.rootInfo();
    if (ri && ri.toggles != null) s += ` · 토글 ${ri.toggles}개 인식`;
    // 목록에는 지금 화면의 유닛만 나온다. 사라진 유닛은 내보낼 데이터에 남아 있다는 걸 여기서 보여 준다.
    const gone = RBC.units.retired ? RBC.units.retired() : [];
    if (gone.length) {
      s += `<br><span style="color:#666">사라진 유닛 ${gone.length}개 데이터에 보존: ` +
        gone.slice(-3).map(u => `${esc(u.pid)} "${esc(u.text.slice(0, 12))}…"`).join(', ') +
        (gone.length > 3 ? ' …' : '') + '</span>';
    }
    rescanHtml = s + `<span id="rbc-same">${sameN ? ` · 글 변화 없는 재스캔 ${sameN}회 (최대 ${sameMax}ms)` : ''}</span>`;
    const el = panelEl && panelEl.querySelector('#rbc-rescan');
    if (el) el.innerHTML = rescanHtml;
  });

  bus.on('ui:panel', (d) => {
    const on = !!(d && d.on);
    if (on === visible) return;
    visible = on;
    if (!on && uiOverlay) {
      uiOverlay = false;
      RBC.frames.send('overlay', { on: false });
    }
    render();
  });

  bus.on('session:link', (d) => {
    const why = d && d.why;
    linkMsg = d && d.ok ? ''
      : String(why).startsWith('orphan')
        ? '확장이 새로고침돼서 이 탭과 연결이 끊겼습니다. <b>페이지를 새로고침</b>하세요.' +
          `<br><span style="color:#999">[${esc(why)}]</span>`
        : 'background 연결 실패' +
          `<br><span style="color:#999;word-break:break-all">${esc(why || '응답 없음')}</span>`;
    render();
  });

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
      `<br>유닛 <b>${d.units}</b>개 · 본문 ${d.chars.toLocaleString()}자` +
      rootLine(d.root)
    );
    render();
  });

  // 본문으로 고른 요소와 이유. 루트를 잘못 고르면 유닛 수만으로는 티가 안 날 때가
  // 있어서(헤럴드: 제목 영역, 감사 §6-F) 콘솔 없이 바로 보이게 한다.
  const ROOT_HOW = { site: '플랫폼 지정', semantic: '시맨틱 태그', fallback: '링크 아닌 글자 최다', body: '후보 없음 → body' };
  function rootLine(r) {
    if (!r) return '';
    const warn = r.how === 'body';
    return `<br><span style="color:${warn ? '#c00' : '#999'}">루트 ${esc(r.sel)} · ` +
      `${ROOT_HOW[r.how] || esc(r.how)} · 링크 ${Number(r.link || 0).toLocaleString()}자` +
      (r.toggles != null ? ` · 토글 ${r.toggles}개 인식(둘레에만 벽)` : '') + '</span>';
  }

  // ==========================================================================
  // 공개 + 마운트
  //   init() 이 renderPanel() 을 부르던 것을 자가 마운트로 바꿨다.
  //   content.js 의 init() 은 readyState 에 따라 9-panel.js 보다 먼저 돌 수 있어서,
  //   거기서 패널을 부르면 "가끔" undefined 가 된다.
  // ==========================================================================
  RBC.panel = { render, setStat };

  injectStyle();
  render();                              // 숨김 상태면 아무것도 안 그린다. ui:panel{on:true} 가 오면 그린다
})();