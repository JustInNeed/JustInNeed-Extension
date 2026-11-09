/* =============================================================================
 * 9-panel.js — 디버그 패널 (최상위 프레임 전용)
 *
 * 소유: panelEl, listEl, uiRecording, uiOverlay, prefOverlay, overlayErr, visible
 * 의존(직접 호출): 0-core, RBC.stream(펼치기 실패 시험 #37), RBC.frames, RBC.recorder, RBC.units   ← 전부 자기보다 낮은 번호
 * 발행: cmd:* (스캔·오버레이·목록·청크·검색어), ui:rec, ui:export, ui:query, ui:idletest, ui:overlay
 * 구독: stat, units:list, session:changed, session:link,
 *       scan:progress, scan:failed, scan:done, ui:panel, overlay:pref, units:rescanned, idle:clock, skip:page(#49), popup:perf(#66)
 *
 * --- 보이기 / 숨기기 (기본 숨김) ----------------------------------------------
 *   참가자 화면에 패널이 뜨면 읽기 행동을 오염시키고, 청크 슬라이더를 만질 수 있다.
 *   그래서 기본은 숨김이고, 참여 정보 페이지의 "연구자용 설정"에서 켠다(서현 결정 2026-10-06).
 *   설정은 chrome.storage.local 'ui:panel' — content 쪽에서 chrome.* 는 11-session 만 쓰므로
 *   11-session 이 읽어서 ui:panel{on} 으로 알린다. 열린 탭에도 바로 반영된다(storage.onChanged).
 *   숨기면 DOM 을 통째로 뺀다. 상태(uiRecording 등)는 계속 갱신되고, 켜면 다시 그린다.
 *   숨길 때 오버레이가 켜져 있으면 끈다 — 오버레이 버튼이 패널 안에 있어서 못 끄게 되니까.
 *
 * --- 오버레이 켜짐 기억 (#36) ----------------------------------------------------
 *   [오버레이] 버튼은 직접 켜지 않고 ui:overlay 로 저장을 요청한다. 저장값은 11-session 이 overlay:pref 로 알린다
 *   → 모든 탭 · 다음 탭 · 브라우저 재시작 뒤에도 같은 상태. 실제 켜짐 = 저장값 && 패널 보임
 *   (패널을 숨기면 꺼지지만 저장값은 그대로라 다시 보이면 켜진다).
 *   오버레이 명령은 primary 에만 먹고 primary 는 스캔이 끝나야 정해지므로, 켜져 있으면 scan:done 때 다시 보낸다
 *   (본문이 iframe 인 블로그 PC 등).
 *
 * --- 상태줄은 primary 프레임 것만 그린다 -------------------------------------
 *   stat 은 모든 프레임에서 올라온다. 광고 iframe 이 재스캔할 때마다 그 iframe 의
 *   "유닛 1개" 가 상태줄을 덮어써서 기록이 이상해 보였다(데이터는 멀쩡했다).
 *   선출 전에는 자기 프레임 것만, 선출 뒤에는 primary 것만 받는다.
 *
 * --- noise 줄 · 본문 문턱 (#11) ----------------------------------------------
 *   stat.tables 로 표 줄(#54): "표 N개 (자료 a · 배치 b)" + 자료 표마다 줄×칸 · 판정 이유 · 글자 수.
 *   stat.noise 로 noise 조각 · 유닛 개수, 판정 방식(Readability / 플랫폼 생략 / 실패 원문), 되찾은 상자 이름,
 *   상자 안 비율과 문턱, 걸린 ms 를 보여 준다. "전부 noise" 유닛 수 = 테스트 모드 평정에서 빠지는 수(#13). 문턱 슬라이더는 청크 명령에 실려 가고 기록 중 잠긴다.
 *
 * --- 무동작 시계 줄 (#26) ---------------------------------------------------
 *   시계는 background 것이다. idle:clock 으로 받은 시각에서 1초마다 여기서 경과만 센다.
 *   탭은 입력을 몇 초 간격(CFG.ACTIVITY_PING_MS)으로만 알리므로 몇 초 늦게 0 으로 돌아가는 건 정상이다.
 *   크롬 밖 시간은 떠나 있는 동안 볼 수 없으니, 돌아온 뒤 "지난번 크롬 밖"으로 보여 준다.
 *   [빠른 시험] = 한도를 20초 · 40초로 줄여 자동 정지를 바로 눈으로 본다. 기록 중에만 누를 수 있고,
 *   다음 기록 시작 때 background 가 끈다. 검사는 30초마다라 20초를 넘긴 뒤 최대 30초 더 걸릴 수 있다.
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
 *   로만 바꾼다. 다른 탭에서 시작한 세션, 무동작 자동 정지(#26), 웹앱에서 온 명령
 *   (나중)까지 전부 같은 경로로 버튼에 반영된다.
 *
 *   record:started / record:stopped 는 이제 "구간"의 시작/끝이라 버튼에 쓰면
 *   안 된다. SPA 이동으로 구간이 닫힐 때 버튼이 "기록"으로 돌아가 버린다.
 *
 * --- 버스로만 움직인다 --------------------------------------------------------
 *   상태 줄 = stat · 버튼 = session:changed · 스캔 진행 = scan:progress / scan:failed / scan:done.
 *   6-frames 는 "사실"만 넘기고, 문장으로 만드는 건 여기 몫이다.
 *   uiRecording / uiOverlay 의 소유자는 여기다.
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
  let uiMode = null;                     // 확장 버전 (session:changed 의 mode, #19). 첫 hello 전에는 null
  const MODE_KO = { download: '데이터 수집용', server: '실사용' };
  let uiOverlay = false;                 // 지금 켜짐 = prefOverlay && visible (applyOverlay 만 바꾼다)
  let prefOverlay = false;               // 저장된 오버레이 설정. overlay:pref 로만 바뀐다 (#36)
  let visible = false;                   // ui:panel 로만 바뀐다. 기본 숨김
  let rescanHtml = '';                   // 마지막 재스캔 한 줄 (기록 중 splice 를 눈으로 보려고, 0-B)
  let electHtml = '';                    // 마지막 primary 뽑기 후보 · 새 규칙 결과 (#47)
  let linkMsg = '';                      // background 연결 문제. 비어 있으면 정상
  let overlayErr = '';                   // 오버레이 설정 저장 · 읽기 실패 원문(#36). 다음 성공 때 지운다
  let noiseMinPct = 5;                   // 본문 문턱 슬라이더 표시값(%) — 실제 값은 primary 의 1-stream, stat 으로 맞춘다
  let noiseHtml = '';                    // 마지막 noise 판정 줄 (#11)
  let idleClock = null;                  // background 무동작 시계 (#26). idle:clock 으로만 바뀐다
  let skipRule = null;                   // 이 주소가 걸린 기록 안 할 주소 규칙 { url, why, label } (#49). skip:page 로만 바뀐다
  let skipInfo = null;                   // 버전 파일 규칙 목록 상태 (실사용 = 수집 제외 URL, #49). session:changed 로

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
      <h4>📖 JustInNeed
        <span style="margin-left:6px;padding:1px 7px;border-radius:9px;font-size:11px;font-weight:600;${uiMode ? 'background:#eef7e9;color:#3b7f2d' : 'background:#fdf3f2;color:#c0392b'}">${uiMode ? esc(MODE_KO[uiMode] || uiMode) : '버전 확인 전'}</span></h4>
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
      <div class="rbc-row" title="루트 글자 중 Readability 본문 상자 안 비율이 이보다 낮으면 미판정(상자가 루트 안에 거의 없음). 5% 는 근거 없는 임시값">
        <span>본문 문턱</span>
        <input type="range" min="0" max="100" step="5" value="${noiseMinPct}" data-act="noisemin" ${lock}>
        <span id="rbc-noiseminval">${noiseMinPct}%</span>
      </div>
      <div class="rbc-stat" id="rbc-noise">${noiseHtml}</div>
      <div class="rbc-row">
        <span>무동작</span>
        <button data-act="idletest" class="${idleTest() ? 'on' : ''}" ${uiRecording ? '' : 'disabled'}
                title="이번 세션만 한도를 크롬 안 20초 · 크롬 밖 40초로 줄인다">빠른 시험 (20초 · 40초)</button>
      </div>
      <div class="rbc-stat" id="rbc-idle">${idleHtml()}</div>
      <div class="rbc-row">
        <span>노션</span>
        <button data-act="unfoldtest" class="${RBC.stream.unfoldTest() ? 'on' : ''}"
                title="켜면 노션 펼치기가 실패한 것으로 친다 — 기록 전이면 기록 안 함, 기록 중이면 1초 안에 기록을 닫고 실패 창 (#37)">펼치기 실패 시험</button>
      </div>
      ${skipRule ? `<div class="rbc-link" style="color:#92400e;background:#fffbeb;border-color:#fde68a">` +
        `<b>기록 안 함: ${esc(skipRule.label || skipRule.why)}</b> (규칙 ${esc(skipRule.url)}) — 읽기는 그대로, 구간을 안 엶` +
        (skipRule.closed ? '<br><b style="color:#dc2626">규칙이 늦게 와서 기록 중이던 구간을 닫음 (segend excluded)</b>' : '') + '</div>' : ''}
      ${skipInfoLine()}
      ${popPerfLine()}
      ${linkMsg ? `<div class="rbc-link">${linkMsg}</div>` : ''}
      ${overlayErr ? `<div class="rbc-link">${esc(overlayErr)}</div>` : ''}
      <div class="rbc-stat" id="rbc-stat">${keep}</div>
      <div class="rbc-stat" id="rbc-rescan">${rescanHtml}</div>
      <div class="rbc-stat" id="rbc-elect">${electHtml}</div>
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

    // 저장만 요청한다. 켜고 끄기는 overlay:pref 가 오면 (#36)
    panelEl.querySelector('[data-act="ov"]').onclick = () => bus.emit('ui:overlay', { on: !uiOverlay });

    panelEl.querySelector('[data-act="list"]').onclick = () => {
      if (listEl.style.display === 'block') { listEl.style.display = 'none'; return; }
      RBC.frames.send('list');
    };

    // 세션 bundle 은 background 가 만든다. 받아서 저장하는 건 11-session → 6-frames.
    panelEl.querySelector('[data-act="exp"]').onclick = () => bus.emit('ui:export');
    panelEl.querySelector('[data-act="idletest"]').onclick = () => bus.emit('ui:idletest', { on: !idleTest() });
    panelEl.querySelector('[data-act="unfoldtest"]').onclick = () => {   // 이 프레임만 (노션은 최상위가 본문)
      RBC.stream.setUnfoldTest(!RBC.stream.unfoldTest());
      render();
    };

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

    // 본문 문턱(#11): 청크 명령에 실어 보낸다 → primary 만 받고 기록 중엔 6-frames 가 막는다.
    const nm = panelEl.querySelector('[data-act="noisemin"]');
    nm.oninput = (e) => {
      panelEl.querySelector('#rbc-noiseminval').textContent = e.target.value + '%';
    };
    nm.onchange = (e) => {
      noiseMinPct = +e.target.value;
      RBC.frames.send('chunk', { noiseMin: noiseMinPct / 100 });
    };
  }

  // noise 판정 줄 (#11). primary 의 stat.noise(5-recorder noiseStat)로 그린다 — 본문이 iframe 이어도 보이게.
  const NOISE_HOW = { ok: 'Readability', site: '플랫폼 지정 루트 — 판정 생략', fail: 'Readability 실패' };
  function noiseLine(n) {
    if (!n) return '<span style="color:#999">noise 판정 없음 (유닛 없음)</span>';
    const pct = (x) => (x == null ? '-' : Math.round(x * 100) + '%');
    let s = `<b style="color:#dc2626">noise</b> 조각 <b>${n.pieces}</b> · 유닛 <b>${n.units}</b>` +
      ` (전부 noise ${n.allUnits} = 평정 제외)` + (n.none ? ` · <span style="color:#b45309">미판정 조각 ${n.none}</span>` : '');
    if (n.status === 'fail') {
      s += `<br><span style="color:#dc2626;font-weight:600">${NOISE_HOW.fail}: ${esc(n.why)}</span>`;
    } else if (n.status === 'site') {
      s += `<br><span style="color:#666">${NOISE_HOW.site}</span>`;
    } else {
      s += '<br>' + (n.by ? `<b style="color:#7e22ce">${esc(n.by)} 지정 본문 칸 ${n.boxes.length}개 (Readability 안 씀)</b>` +
        (n.skips && n.skips.length ? ` · <b style="color:#dc2626">광고 칸 제외 ${n.skips.length}개</b>` : '') + '<br>' : '') +
        (n.alt ? `<b style="color:#7e22ce">Readability 상자 ${esc(n.altFrom.join(', '))} 가 루트를 통째로 감쌈 → itemprop="${esc(n.alt)}" 칸으로</b><br>` : '') +
        `<span style="color:#7e22ce">상자 ${esc(n.boxes.join(', '))}</span> · 상자 안 비율 <b>${pct(n.ratio)}</b>` +
        ` / 문턱 ${pct(n.min)} → ` + (n.decided ? '판정함' : '<b style="color:#b45309">미판정 (비율 &lt; 문턱)</b>');
    }
    if (n.ms != null) s += ` · ${n.ms}ms`;
    // 복사본에서 지운 on* 속성 수 (#27) — Readability 를 돌렸을 때만. 원본 페이지는 그대로.
    if (n.onAttrs != null) s += ` · <span style="color:#666" title="Readability 복사본에서만 지움 — 원본 페이지 그대로. CSP 위반 경고 막기(#27)">복사본 on* 속성 ${n.onAttrs}개 지움</span>`;
    return s;
  }

  // 표 판정 줄 (#54). 자료 표 = 표 유닛이 될 표(줄×칸 · 판정 이유 · 글자 수), 배치용 = 지금처럼 줄글로.
  function tableLine(t) {
    if (!t || (!t.data.length && !t.layout.length)) return '';
    const list = t.data.map(d => `${d.rows}×${d.cols} ${esc(d.why)} ${d.chars}자`).join(' · ');
    // 가장 큰 표 비율: 페이지 대부분이 표 유닛 하나면 배치용 표를 자료 표로 잘못 본 것일 수 있다 — 문턱 없이 숫자만 보인다
    return `<br><b style="color:#15803d">표 유닛 ${t.units || 0}개</b>` +
      (t.units ? ` · 가장 큰 표 = 유닛 글자의 <b>${Math.round(t.maxPct * 100)}%</b>` : '') +
      ` · 표 ${t.data.length + t.layout.length}개 (자료 ${t.data.length} · 배치 ${t.layout.length})` +
      (list ? ` · <span style="color:#15803d">${list}</span>` : '') +
      (t.layout.length ? ` · <span style="color:#666">배치 ${esc(t.layout.join(', '))}</span>` : '');
  }

  // ==========================================================================
  // 상태줄
  // ==========================================================================
  function setStat(html) {
    const el = panelEl && panelEl.querySelector('#rbc-stat');
    if (el) el.innerHTML = html;
  }

  // s.recording 은 "이 탭에서 지금 구간을 기록 중"이다. 세션 여부는 버튼이 보여준다.
  // s.settling = 본문 준비 중 대기 (구간을 열기 전, 5-recorder). 주황 점.
  // 노션 펼침 줄 (#37). 노션이 아니거나 아직 시도 안 했으면 없음
  function unfoldLine(u) {
    if (!u) return '';
    const txt = u.on ? `노션 펼침 켜짐 · 블록 ${u.blocks}개 · 높이 맞춤 ${u.fits}회 · 다시 펼침 ${u.relinks || 0}회 · 스타일 다시 적용 ${u.fixes || 0}회 · ${u.ms}ms`
      : u.why ? `노션 펼침 실패: ${esc(u.why)}` : `노션 펼침 꺼짐(되돌림) · 블록 ${u.blocks}개`;
    return `<br><span style="color:${u.on ? '#7c3aed' : u.why ? '#c00' : '#999'}">${txt}</span>`;
  }

  function applyStat(s) {
    if (!panelEl || !s) return;
    const primary = RBC.frames.primaryTag();
    if (primary ? s.tag !== primary : s.tag !== TAG) return;   // 광고 iframe 등은 무시
    noiseHtml = noiseLine(s.noise) + tableLine(s.tables);
    const nEl = panelEl.querySelector('#rbc-noise');
    if (nEl) nEl.innerHTML = noiseHtml;
    if (s.noise && s.noise.min != null) {
      noiseMinPct = Math.round(s.noise.min * 100);
      const nm = panelEl.querySelector('[data-act="noisemin"]');
      if (nm && document.activeElement !== nm) {        // 끌고 있는 중이 아니면 실제 값으로 맞춘다
        nm.value = noiseMinPct;
        panelEl.querySelector('#rbc-noiseminval').textContent = noiseMinPct + '%';
      }
    }
    setStat(`
      <span class="dot" style="background:${s.recording ? '#16a34a' : s.settling ? '#f59e0b' : '#bbb'}"></span>
      ${s.recording ? '기록 중' : s.settling
        ? `<b style="color:#b45309">본문 준비 중 ${(s.settling.ms / 1000).toFixed(1)}초 · 글 변화 ${s.settling.changes}회` +
          `${s.units ? '' : ' · 본문 못 찾음, 다시 찾는 중'}</b>`
        : '대기'} · 샘플 ${s.samples}개 · 유닛 ${s.units}개
      ${s.recording ? `· focus ${s.focusSec}s` : ''}<br>
      <b style="color:#16a34a">중앙선(B)</b>: ${esc(s.centerPid) || '—'} <i>${esc(s.centerText)}</i><br>
      <b style="color:#2563eb">커서(A)</b>: ${esc(s.cursorPid) || '여백/없음'}<br>
      scrollSpeed: ${s.scrollSpeed} px/s
      ${s.query ? `· 검색어 "${esc(s.query)}"` : '· <span style="color:#c00">검색어 없음</span>'}
      ${s.sampleMs ? `<br><span style="color:${s.sampleMs.p95 > 10 ? '#c00' : '#333'}">` +
        `sample p95 ${s.sampleMs.p95}ms (그중 vis ${s.sampleMs.visP95}ms) · max ${s.sampleMs.max}ms` +
        ` (최근 ${s.sampleMs.n}틱)</span> · 측정 조각 ${s.sampleMs.pieces} · 화면 조각 ${s.visN}` +
        (s.sampleMs.folded ? ` · <span style="color:#c2410c">접혀 숨은 조각 ${s.sampleMs.folded} (vis 제외)</span>` : '') +
        (s.sampleMs.rescued ? ` · <span style="color:#15803d">첫 글자만 숨은 조각 ${s.sampleMs.rescued} (vis 포함)</span>` : '') : ''}
      ${s.title ? `<br><span style="color:#555">제목: ${esc(s.title.text.slice(0, 40))}</span>` +
        ` <span style="color:#999">(${s.title.from === 'seg' ? '이 구간에 기록됨' : esc(s.title.from)})</span>` : ''}
      ${unfoldLine(s.unfold)}
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
  // 구독 — 역방향 호출을 끊은 자리 (다른 모듈은 사실만 발행, 패널은 듣고 그린다)
  // ==========================================================================

  bus.on('stat', applyStat);

  bus.on('units:list', showList);

  // 버튼은 세션 상태만 따른다. 11-session 이 background 의 방송·hello
  //   응답을 받을 때마다 발행한다.
  bus.on('session:changed', (d) => {
    const on = !!(d && d.recording);
    const mode = (d && d.mode) || null;
    const info = (d && d.skipInfo) || null;
    const infoSame = JSON.stringify(info) === JSON.stringify(skipInfo);
    skipInfo = info;
    if (on === uiRecording && mode === uiMode && infoSame) return;
    uiRecording = on;
    uiMode = mode;
    render();
  });

  // 재스캔 결과 한 줄: 기록 중 토글을 열거나 늦게 그려질 때 무슨 일이 났는지 바로 보이게.
  //   splice 면 유지 · 새 · 사라짐 · 자체 검증([0,0] = 정상) · 루트. 루트가 바뀌면 빨갛게.
  const RESCAN_KO = { full: '전체 재청킹', append: '끝에 추가', splice: '중간 변경(splice)' };
  let sameN = 0, sameMax = 0;            // 글 변화 없는 재스캔(호버 UI 등) 횟수 · 최대 ms
  bus.on('units:rescanned', (d) => {
    if (!d) return;
    // 이 버스는 이 프레임(최상위) 것이다. 본문이 iframe(블로그 PC)이면 여기 재스캔은 껍데기 페이지(루트 body · 유닛 0)라
    //   그리면 "루트 body"로 잘못 보인다(2026-10-09). iframe 재스캔은 중계되지 않으므로 안 그린다 — 루트는 스캔 결과 줄로 본다.
    const p = RBC.frames.primaryTag();
    if (p && p !== TAG) return;
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

  // 무동작 시계 (#26). 숫자는 background 값, 문장은 여기서.
  function mmss(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  const SRC_KO = { input: '입력', tab: '탭 전환', window: '크롬으로 돌아옴', start: '기록 시작', test: '빠른 시험 누름' };
  function idleTest() { return !!(uiRecording && idleClock && idleClock.test); }
  function idleHtml() {
    const c = idleClock;
    if (!uiRecording || !c || !c.lastActAt) return '<span style="color:#999">무동작 시계: 기록 중이 아님</span>';
    const idle = Date.now() - c.lastActAt;
    const near = idle > c.inMs * 0.8;
    // 패널이 보인다 = 크롬 안. 그런데 background 가 크롬 밖으로 보고 있으면 잘못 잡힌 것(개발자 도구 창 등) — 빨갛게.
    const away = c.awaySince ? `<br><b style="color:#dc2626">background 는 지금 크롬 밖으로 봄 ${mmss(Date.now() - c.awaySince)}` +
      ` — 무동작 시계는 멈춤, 크롬 밖 한도로 잼</b>` : '';
    return `무동작 <b style="color:${near ? '#dc2626' : '#111'}">${mmss(idle)}</b> / ${mmss(c.inMs)}` +
      ` · 크롬 밖 지난번 ${c.lastAwayMs != null ? mmss(c.lastAwayMs) : '없음'} / ${mmss(c.outMs)}` +
      (c.test ? ' <b style="color:#dc2626">· 빠른 시험 켜짐</b>' : '') +
      `<br><span style="color:#666">마지막 움직임: ${esc(SRC_KO[c.src] || c.src || '?')}</span>` + away +
      (c.err ? `<br><span style="color:#dc2626">무동작 시계 실패: ${esc(c.err)}</span>` : '');
  }
  bus.on('idle:clock', (d) => {
    const wasTest = idleTest();
    idleClock = d;
    if (idleTest() !== wasTest) { render(); return; }      // 버튼 색
    const el = panelEl && panelEl.querySelector('#rbc-idle');
    if (el) el.innerHTML = idleHtml();
  });
  setInterval(() => {
    const el = visible && panelEl && panelEl.querySelector('#rbc-idle');
    if (el) el.innerHTML = idleHtml();
  }, 1000);

  bus.on('ui:panel', (d) => {
    const on = !!(d && d.on);
    if (on === visible) return;
    visible = on;
    applyOverlay();
    render();
  });

  // 오버레이 켜짐 = 저장값 && 패널 보임. 바뀔 때만 프레임에 보낸다 (#36)
  function applyOverlay() {
    const want = prefOverlay && visible;
    if (want === uiOverlay) return;
    uiOverlay = want;
    RBC.frames.send('overlay', { on: uiOverlay });
  }

  bus.on('overlay:pref', (d) => {
    prefOverlay = !!(d && d.on);
    overlayErr = (d && d.err) || '';      // 상태줄은 틱마다 덮이므로 따로 남는 줄에 (#36 검토)
    applyOverlay();
    render();
  });

  bus.on('skip:page', (d) => { skipRule = d || null; render(); });

  // 수집 제외 URL 목록 줄 (#49, 실사용만). 받은 개수 · 때 · 실패 원문
  function skipInfoLine() {
    const k = skipInfo;
    if (!k) return '';
    const when = k.at ? new Date(k.at).toTimeString().slice(0, 8) + ' 받음' : '아직 못 받음';
    return `<div class="rbc-stat">${esc(k.kind)} <b>${Number(k.n)}</b>개 · ${when}` +
      (k.mine ? '' : ' <span style="color:#999">(로그인한 회원 목록 없음 — 규칙 안 씀)</span>') +
      (k.err ? `<br><span style="color:#dc2626">${esc(k.err)}</span>` : '') + '</div>';
  }

  // 팝업 속도 줄 (#66, 실사용만). 마지막으로 연 팝업의 첫 화면 · background 응답(ms). 300ms 넘으면 주황.
  let popPerf = null;
  bus.on('popup:perf', (d) => { popPerf = d; render(); });
  function popPerfLine() {
    const p = popPerf;
    if (!p) return '';
    const ms = (v) => (v == null ? '…' : `<b style="color:${v > 300 ? '#b45309' : '#111'}">${Number(v)}ms</b>`);
    return `<div class="rbc-stat">팝업 속도 (${new Date(p.at).toTimeString().slice(0, 8)} 연 팝업): 첫 화면 ${ms(p.first)}` +
      ` · background 응답 첫 ${ms(p.st0)} / 최근 ${ms(p.last)} / 최대 ${ms(p.max)} (${Number(p.n)}번) · whoami ${ms(p.whoami)}` +
      `<br><span style="color:#999">열림 → 스크립트 ${Number(p.script)}ms. 응답이 크면 background(깨우기 · 줄 대기), 작으면 팝업 그리기 · 크롬 쪽</span></div>`;
  }

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

  // 6-frames 는 숫자만 넘기고 문장 조립은 여기서 한다.
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
    if (uiOverlay) RBC.frames.send('overlay', { on: true });   // 새 primary 에도 켠다 (#36)
    electHtml = electLine(d);
    render();
  });

  // primary 뽑기 줄 (#47): 후보(유닛 많은 순) · 뽑힌 것 ✓ · 옛 규칙(유닛 최다)이었으면 같은지.
  //   "다름" = 새 규칙의 예외가 끼어든 페이지(광고 · 위젯 대신 본 페이지를 고름).
  function electLine(d) {
    if (!d.cands) return '';
    const name = (c) => c.top ? '본 페이지' : `frame ${esc(c.tag)} ${esc(c.host)}`;
    const MAX = 5;
    const rows = d.cands.slice(0, MAX).map(c =>
      // 숫자는 다른 출처 iframe 이 보낸 값이라 Number 로만 넣는다
      `${c.tag === d.tag ? '✓' : '·'} ${name(c)} — 유닛 ${Number(c.units)} · ${Number(c.chars).toLocaleString()}자 · 루트 ${esc(c.how || '없음')}`);
    if (d.cands.length > MAX) rows.push(`… 외 ${d.cands.length - MAX}개`);
    const old = d.cands.find(c => c.tag === d.old);
    const verdict = d.old === d.tag
      ? '<b style="color:#16a34a">같음</b>'
      : `<b style="color:#b45309">다름 → 옛 규칙은 ${old ? name(old) : esc(d.old)} (#47 예외로 바꿈)</b>`;
    return `<b>primary 뽑기</b> 후보 ${d.cands.length}개 · 옛 규칙이면: ${verdict}<br>` + rows.join('<br>');
  }

  // 본문으로 고른 요소와 이유. 루트를 잘못 고르면 유닛 수만으로는 티가 안 날 때가
  // 있어서(헤럴드: 제목 영역, 감사 §6-F) 콘솔 없이 바로 보이게 한다.
  const ROOT_HOW = { site: '플랫폼 지정', semantic: '시맨틱 태그', fallback: '링크 아닌 글자 최다', body: '후보 없음 → body' };
  function rootLine(r) {
    if (!r) return '';
    const warn = r.how === 'body';
    return `<br><span style="color:${warn ? '#c00' : '#999'}">루트 ${esc(r.sel)} · ` +
      `${ROOT_HOW[r.how] || esc(r.how)} · 링크 ${Number(r.link || 0).toLocaleString()}자` +
      (r.toggles != null ? ` · 토글 ${r.toggles}개 인식(둘레에만 벽)` : '') +
      (r.shadow ? ` · <span style="color:#0369a1">shadow 안 읽은 칸 ${Number(r.shadow.n)}개(${esc(r.shadow.name)})</span>` : '') + '</span>';
  }

  // ==========================================================================
  // 공개 + 마운트
  //   패널은 스스로 마운트한다(누가 불러 주지 않는다).
  // ==========================================================================
  RBC.panel = { render, setStat };

  injectStyle();
  render();                              // 숨김 상태면 아무것도 안 그린다. ui:panel{on:true} 가 오면 그린다
})();