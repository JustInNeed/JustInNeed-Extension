/* =============================================================================
 * Reading Behavior Collector (v2.2) — 글자 스트림 기반
 *
 * 원칙: content script는 RAW만 수집한다.
 *   정규화·z-score·개인화 보정은 전부 오프라인/BE 담당.
 *   여기서는 "나중에 어떤 feature를 만들든 재계산 가능한 원본"을 빠짐없이 남기는 게 목표.
 *
 * --- 수집 단위 (v1 -> v2) --------------------------------------------------
 *   "문단 탐지"를 버리고 본문 텍스트 스트림을 글자 수로 자른다.
 *     - 기사 사이트: <br>로만 나뉜 CMS가 많아 기사 전체가 문단 1개가 됨
 *     - 네이버 블로그: SmartEditor가 한 줄마다 <p> → 한 줄이 문단 1개
 *   유닛 = 스트림의 글자 오프셋 구간 [start, end). 좌표가 아니라 '글자'로 정의되므로
 *   lazy-load / 광고 삽입 / 폰트 로딩으로 레이아웃이 밀려도 정체성이 안 깨진다.
 *   문장·블록 경계에 스냅해서 자르므로 문장이 반토막 안 남 (LLM 단계 보호).
 *   매 틱 위치 조회는 caretRangeFromPoint. 유닛 개수와 무관하게 상수 시간.
 *   pid = 텍스트 해시 → 재스캔해도 같은 글이면 같은 id.
 *   iframe: 전 프레임 주입 후 유닛이 가장 많은 프레임 1개를 primary로 선출해 거기서만 기록.
 *
 * --- v2.2: 명세(0-3 / 0-4) 대비 누락 수집 항목 보강 -------------------------
 *   [C1] 체류시간 = "블록이 뷰포트에 들어와 있던 누적 시간".
 *        기존엔 중앙선(B채널)에 걸린 유닛만 기록해서, 화면에 보였지만 중앙선에
 *        안 닿은 유닛은 체류시간이 0이었다.
 *        틱마다 뷰포트 최상단/최하단의 유닛 order를 기록(visTop/visBot) →
 *        그 사이 유닛은 전부 "노출됨". 오프라인에서 누적하면 IntersectionObserver와
 *        같은 값이 나온다. (유닛이 DOM 요소가 아니라 IO를 직접 못 쓴다)
 *   [C2] focus 시간: visibilitychange만 보던 것을 window blur/focus까지 확대.
 *        탭은 보이는데 브라우저 창이 뒤로 간 경우가 안 잡혔다.
 *        포커스는 최상위 프레임이 소유하고 하위 프레임에 브로드캐스트한다
 *        (iframe에서 document.hasFocus()는 프레임 내부에 포커스가 있어야 true라
 *         그냥 읽기만 하는 동안 false가 되어버린다).
 *   [C3] 커서 이벤트 수(mouseEvents) — cursorfreq가 "커서이벤트수 ÷ 활성시간"인데
 *        폴링 틱 수만 세고 있었다. scrollEvents와 대칭이 되게 추가.
 *   [C4] 선택/복사가 여러 유닛에 걸치면 걸친 유닛을 전부 기록(pids).
 *        기존엔 선택 '시작 지점' 유닛 하나만 1이 됐다. 명세: "여러 문단 걸치면 모두 1".
 *   [C5] 30분 무동작 자동 종료.
 *   [C6] 세션 메타: sessionId, startedAt/endedAt, focusMs.
 *   [C7] 페이지 메타: referrer, devicePixelRatio, enteredAt/leftAt.
 *   [C8] 검색 키워드: referrer의 검색 URL에서 파싱 + 패널에서 직접 입력.
 *        PDF 4번 섹션(관심 벡터) 전체가 이것에 의존한다.
 *   [C9] schemaVersion — 포맷이 바뀌어도 과거 데이터를 재처리할 수 있게.
 *
 * --- 아직 없음 (background + chrome.storage 필요) ---------------------------
 *   · 페이지를 넘어 이어지는 세션 / 방문 순서
 *   · 이탈·새로고침 시 데이터 보존  (지금은 페이지 메모리에만 있음)
 * ========================================================================== */

(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus, IS_TOP, TAG } = RBC;
  const { isWs, clean, hash } = RBC.util;

  


  // ==========================================================================
  // STATE
  // ==========================================================================

  // 8-overlay.js 가 소유하는 overlayOn 의 읽기 전용 미러.
  // overlay:changed 이벤트로만 갱신한다. 여기서 직접 대입하지 말 것.
  // 8-overlay.js 가 없으면 영원히 false 로 남고, 그게 맞는 동작이다.
  let isPrimary = IS_TOP;
  let primaryTag = null;



  // ==========================================================================
  // 7) 녹화 제어 / export
  // ==========================================================================

  function download(payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const sid = (payload.meta.sessionId || 'nosid').slice(0, 8);
    a.download = `rbc_${sid}_${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  

  // ==========================================================================
  // 9) 프레임 간 통신
  //    최상위 프레임이 패널을 갖고, 유닛을 제일 많이 가진 프레임 1개만 기록한다.
  //    (네이버 블로그: 본문이 #mainFrame 안 → 그 프레임이 primary)
  // ==========================================================================
  const seenMsg = new Set();

  function toChildren(msg) {
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage(msg, '*'); } catch (e) { /* noop */ }
    }
  }
  function toTop(msg) {
    try { window.top.postMessage(Object.assign({ __rbc: 1, tag: TAG }, msg), '*'); }
    catch (e) { /* noop */ }
  }

  function handleCmd(m) {
    switch (m.cmd) {
      case 'scan':
        bus.emit('cmd:scan');                 // primary 아닌 프레임도 돈다 (선출 근거)
        break;
      case 'primary':
        isPrimary = (m.tag === TAG);
        bus.emit('primary:changed', { isPrimary });
        if (!isPrimary) bus.emit('cmd:overlay', { on: false });
        break;
      case 'focus':    bus.emit('cmd:focus', m); break;      // [C2] 전 프레임
      case 'activity': bus.emit('cmd:activity'); break;      // [C5] 전 프레임
      case 'query':    bus.emit('cmd:query', m); break;      // [C8] 전 프레임
      case 'chunk':
        if (RBC.recorder.isRecording()) break;               // BUG-1
        if (isPrimary) bus.emit('cmd:chunk', m);
        break;
      // 아래는 primary 만. 각 모듈은 primary 개념을 몰라도 된다.
      case 'start':   if (isPrimary) bus.emit('cmd:start', m); break;
      case 'stop':    if (isPrimary) bus.emit('cmd:stop'); break;
      case 'overlay': if (isPrimary) bus.emit('cmd:overlay', m); break;
      case 'list':    if (isPrimary) bus.emit('cmd:list'); break;
      case 'export':  if (isPrimary) bus.emit('cmd:export'); break;
    }
  }


  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.__rbc !== 1) return;
    if (m.cmd) {
      if (m.id && seenMsg.has(m.id)) return;
      if (m.id) seenMsg.add(m.id);
      handleCmd(m);
      toChildren(m);                     // 중첩 프레임까지 전파
      return;
    }
    if (!IS_TOP) return;
    if (m.res === 'scan') collectScan(m);
    else if (m.res === 'stat') bus.emit('stat', m);
    else if (m.res === 'export') download(m.payload);
    else if (m.res === 'list') bus.emit('units:list', m.list);
    else if (m.res === 'autostop') bus.emit('record:stopped', { reason: 'idle' });
  });

  function send(cmd, extra) {
    const msg = Object.assign(
      { __rbc: 1, cmd, id: Math.random().toString(36).slice(2) }, extra || {});
    handleCmd(msg);
    seenMsg.add(msg.id);
    toChildren(msg);
  }

  // --- primary 선출 + 스캔 재시도 ---------------------------------------------
  let scanBucket = [];
  let scanTimer = null;
  let scanTries = 0;

  function doScan(auto) {
    if (RBC.recorder.isRecording()) return;
    if (!auto) scanTries = 0;
    scanBucket = [];
    clearTimeout(scanTimer);
    send('scan');
    scanTimer = setTimeout(() => {
      if (!scanBucket.length) {
        if (scanTries < CFG.SCAN_RETRY_MAX) {
          scanTries++;
          bus.emit('scan:progress', { tries: scanTries, max: CFG.SCAN_RETRY_MAX });
          setTimeout(() => doScan(true), CFG.SCAN_RETRY_MS);
        } else {
          bus.emit('scan:failed');
        }
        return;
      }
      scanTries = 0;
      scanBucket.sort((a, b) => b.units - a.units || b.chars - a.chars);
      const win = scanBucket[0];
      primaryTag = win.tag;
      send('primary', { tag: primaryTag });
      send('focus', { on: !document.hidden && document.hasFocus() });   // [C2] 초기 동기화
      const q = RBC.recorder.query();
      if (q) send('query', { q });
      bus.emit('scan:done', {
        frames: scanBucket.length,
        tag: win.tag,
        isSelf: win.tag === TAG,
        units: win.units,
        chars: win.chars,
      });
    }, CFG.SCAN_COLLECT_MS);
  }

  function collectScan(m) {
    if (m.units > 0) scanBucket.push(m);
  }


  // ==========================================================================
  // 11) DOM 변경 감시
  //   목적은 무한스크롤 대응이 아니라 (1) 첫 스캔이 너무 일렀을 때의 복구,
  //   (2) 본문 뒤에 내용이 덧붙는 경우의 꼬리 청킹이다.
  //   첫 스캔 전에는 문서 전체를 봐야 '늦게 도착하는 본문'을 잡을 수 있고,
  //   본문 루트가 정해진 뒤에는 그 안으로 좁혀 광고 노이즈를 끊는다.
  //   최초 observe 시점엔 contentRoot가 null이므로 rescan() 후 재부착이 필요하다.
  // ==========================================================================
  let mutTimer = null;
  let lastRescanAt = 0;
  let mo = null, moTarget = null;

  function retargetObserver() {
    if (!mo) return;
    const root = RBC.stream.root();
    const target = (RBC.units.count() && root) ? root : document.documentElement;
    if (moTarget === target) return;
    mo.disconnect();
    moTarget = target;
    mo.observe(target, { childList: true, subtree: true, characterData: false });
  }

  function watchMutations() {
    mo = new MutationObserver(() => {
      clearTimeout(mutTimer);
      const wait = RBC.recorder.isRecording() ? CFG.MUTATION_DEBOUNCE_REC : CFG.MUTATION_DEBOUNCE;
      mutTimer = setTimeout(() => {
        if (!RBC.units.count()) {
          // 아직 본문을 못 잡음. auto=true 로 호출해야 재시도 카운터가 유지된다.
          if (IS_TOP && scanTries < CFG.SCAN_RETRY_MAX) doScan(true);
          return;
        }
        if (RBC.recorder.isRecording() && Date.now() - lastRescanAt < CFG.RESCAN_MIN_GAP_REC) return;
        lastRescanAt = Date.now();
        RBC.units.rescan({ preserve: true });
      }, wait);
    });
    retargetObserver();
  }

  // ==========================================================================
  // init
  // ==========================================================================

  // [R1] 전: rescan() 이 retargetObserver() 를 직접 호출
  bus.on('units:changed', () => {
    retargetObserver();
  });

  // 스캔 결과를 최상위 프레임으로. primary 선출의 입력이 된다.
  bus.on('units:scanned', (d) => {
    const info = { tag: TAG, units: d.count, href: location.href, chars: d.chars };
    if (IS_TOP) collectScan(info); else toTop(Object.assign({ res: 'scan' }, info));
  });

  // 유닛 목록을 최상위로 중계 (최상위면 패널이 직접 받는다)
  bus.on('units:list', (list) => {
    if (!IS_TOP) toTop({ res: 'list', list });
  });

  bus.on('activity', () => send('activity'));

  // 4-input 이 최상위 프레임의 포커스 변화를 알리면 하위 프레임으로 브로드캐스트한다.
  bus.on('focus:broadcast', (d) => send('focus', { on: d.on }));

    // 5-recorder 가 만든 통계를 최상위로. 최상위면 9-panel 이 직접 받는다.
  bus.on('stat', (s) => { if (!IS_TOP) toTop(s); });

  // export payload. 최상위면 바로 저장, 아니면 최상위로 넘긴다.
  bus.on('export:ready', (payload) => {
    if (IS_TOP) download(payload); else toTop({ res: 'export', payload });
  });

  // 자동 종료는 최상위 패널이 알아야 버튼이 돌아온다.
  bus.on('record:stopped', (d) => {
    if (!IS_TOP && d && d.reason === 'idle') toTop({ res: 'autostop' });
  });


  function init() {
    watchMutations();
    if (IS_TOP) setTimeout(() => doScan(), CFG.FIRST_SCAN_DELAY);
  }

  RBC.frames = { send, doScan, isPrimary: () => isPrimary };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

})();