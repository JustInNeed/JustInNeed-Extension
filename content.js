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
  const { isWs, clean, esc, hash, uuid, searchQueryFromReferrer } = RBC.util;

  


  // ==========================================================================
  // STATE
  // ==========================================================================

  let recording = false;
  // 8-overlay.js 가 소유하는 overlayOn 의 읽기 전용 미러.
  // overlay:changed 이벤트로만 갱신한다. 여기서 직접 대입하지 말 것.
  // 8-overlay.js 가 없으면 영원히 false 로 남고, 그게 맞는 동작이다.
  let overlayOn = false;
  let isPrimary = IS_TOP;
  let primaryTag = null;

  let timeline = [];
  let tickTimer = null;
  let tickCount = 0;
  let recordedTicks = 0;        // [C6] focusMs 계산용

  let latestCursor = null;
  let prevTickCursor = null;
  let prevScrollY = window.scrollY;
  let prevTickTime = null;
  let scrollEventsSinceTick = 0;
  let mouseEventsSinceTick = 0; // [C3]
  let lastSelText = '';

  let winFocused = true;        // [C2] 최상위 프레임이 소유, 하위로 브로드캐스트
  let lastActivityAt = Date.now();
  let lastActivityPing = 0;

  const pageEnteredAt = Date.now();   // [C7]
  let pageLeftAt = null;

  let sessionId = null;         // [C6]
  let sessionEpoch = 0;
  let sessionStartISO = null;
  let sessionEndISO = null;
  let searchQuery = null;       // [C8]

  let lastCenterPid = null, lastCursorPid = null, lastScrollSpeed = 0;

  // ==========================================================================
  // 유틸
  // ==========================================================================
  function tNow() { return Date.now() - sessionEpoch; }




  // ==========================================================================
  // 5) 이벤트 리스너
  // ==========================================================================
  function bump() {                       // [C5] 사용자 활동 기록
    lastActivityAt = Date.now();
    if (IS_TOP && Date.now() - lastActivityPing > CFG.ACTIVITY_PING_MS) {
      lastActivityPing = Date.now();
      send('activity');
    }
  }

  function onMouseMove(e) {
    latestCursor = { x: e.clientX, y: e.clientY };
    mouseEventsSinceTick++;               // [C3]
    bump();
  }
  function onScroll() { scrollEventsSinceTick++; RBC.hittest.invalidate(); bump(); }
  function onKey() { bump(); }
  function onResize() { RBC.hittest.invalidate(); bus.emit('viewport:resized'); }

  // 패널 위 선택·복사는 수집 대상이 아니다. (3-hittest 안에도 같은 판정이 있는데,
  // 그쪽은 좌표 탐침 필터용이고 이쪽은 이벤트 필터용이라 쓰임이 다르다)
  function inPanel(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('#' + CFG.PANEL_ID));
  }

  function onCopy() {
    if (!recording) return;
    const sel = window.getSelection();
    if (!sel || inPanel(sel.anchorNode)) return;
    const pids = RBC.hittest.unitsFromSelection(sel)
    timeline.push({
      type: 'copy', t: tNow(), pids, pid: pids[0] || null, text: sel.toString(),
    });
    bump();
  }

  function onSelectionChange() {
    if (!recording) return;
    const sel = window.getSelection();
    if (!sel || inPanel(sel.anchorNode)) return;
    const text = sel.toString().trim();
    if (text && text !== lastSelText) {
      lastSelText = text;
      const pids = RBC.hittest.unitsFromSelection(sel)
      timeline.push({ type: 'highlight', t: tNow(), pids, pid: pids[0] || null, text });
      bump();
    } else if (!text) {
      lastSelText = '';
    }
  }

  function onVisibility() {
    if (recording) {
      timeline.push({ type: 'visibility', t: tNow(), hidden: document.hidden });
    }
    if (!document.hidden) { prevTickTime = null; bump(); }
  }

  // [C2] 포커스는 최상위 프레임이 소유하고 하위 프레임에 알린다.
  function onWinFocus() { if (IS_TOP) { bump(); send('focus', { on: true }); } }
  function onWinBlur() { if (IS_TOP) send('focus', { on: false }); }

  function setFocus(on) {
    if (winFocused === on) return;
    winFocused = on;
    if (recording) timeline.push({ type: 'focus', t: tNow(), focused: on });
    if (on) prevTickTime = null;          // 복귀 직후 dt 튐 방지
  }

  function onPageHide() {                 // [C7]
    pageLeftAt = Date.now();
    if (recording) timeline.push({ type: 'pagehide', t: tNow() });
  }

  // ==========================================================================
  // 6) 마스터 틱
  // ==========================================================================
  function tick() {
    // [C2] 탭이 숨겨졌거나 브라우저 창이 포커스를 잃은 동안은 기록하지 않는다.
    //      (명세 0-3: focus 시간 = 탭이 active일 때만 카운트)
    if (recording && (document.hidden || !winFocused)) { prevTickTime = null; return; }

    // [C5] 30분 무동작 → 자동 종료
    if (recording && Date.now() - lastActivityAt > CFG.IDLE_TIMEOUT_MS) {
      timeline.push({ type: 'autostop', t: tNow(), reason: 'idle' });
      stopRecording('idle');
      if (!IS_TOP) toTop({ res: 'autostop' });
      return;  
    }

    const now = performance.now();
    const scrollY = window.scrollY;
    const dt = prevTickTime != null ? (now - prevTickTime) / 1000 : 0;

    const s = RBC.hittest.sample(latestCursor);
    const centerU = s.centerU;
    const centerPid = centerU ? centerU.pid : null;
    const scrollSpeed = dt > 0 ? (scrollY - prevScrollY) / dt : 0;
    const visTop = s.visTop, visBot = s.visBot; 

    let cursorPid = null, cx = null, cy = null, cursorDist = 0, cursorMoved = false;
    if (latestCursor) {
      cx = latestCursor.x; cy = latestCursor.y;
      cursorPid = s.cursorU ? s.cursorU.pid : null;
      if (prevTickCursor) {
        cursorDist = Math.round(Math.hypot(cx - prevTickCursor.x, cy - prevTickCursor.y));
        cursorMoved = cursorDist > 0;
      }
    }

    if (recording) {
      timeline.push({
        type: 'tick',
        t: tNow(),
        scrollY,
        scrollSpeed: Math.round(scrollSpeed),   // 부호 = 방향. 감속은 오프라인에서 미분
        scrollEvents: scrollEventsSinceTick,
        mouseEvents: mouseEventsSinceTick,      // [C3]
        centerPid,                              // B채널 귀속
        visTop, visBot,                         // [C1] 이 사이 유닛은 화면에 노출됨
        cursorPid,                              // A채널 귀속 (여백이면 null)
        cx, cy,
        cursorDist,
        cursorMoved,
        vw: window.innerWidth,
        vh: window.innerHeight,
        docH: document.documentElement.scrollHeight,
      });
      recordedTicks++;
    }

    prevTickTime = now;
    prevScrollY = scrollY;
    if (latestCursor) prevTickCursor = { x: latestCursor.x, y: latestCursor.y };
    scrollEventsSinceTick = 0;
    mouseEventsSinceTick = 0;

    lastCenterPid = centerPid; lastCursorPid = cursorPid; lastScrollSpeed = scrollSpeed;
    bus.emit('tick:done', { centerU, cursorPid });
    if (++tickCount % CFG.STAT_EVERY === 0) emitStat();
  }

  function ensureTicking() {
    const want = recording || overlayOn;
    if (want && !tickTimer) {
      prevTickTime = null; prevScrollY = window.scrollY; prevTickCursor = null;
      tickTimer = setInterval(tick, CFG.TICK_MS);
    } else if (!want && tickTimer) {
      clearInterval(tickTimer); tickTimer = null;
    }
  }

  // ==========================================================================
  // 7) 녹화 제어 / export
  // ==========================================================================
  function startRecording(m) {
    if (!RBC.units.count()) RBC.units.rescan({});
    timeline = [];
    recordedTicks = 0;
    sessionId = (m && m.sessionId) || uuid();          // [C6]
    sessionEpoch = (m && m.epoch) || Date.now();
    sessionStartISO = new Date(sessionEpoch).toISOString();
    sessionEndISO = null;
    if (m && m.query) searchQuery = m.query;           // [C8]
    if (!searchQuery) searchQuery = searchQueryFromReferrer();
    lastActivityAt = Date.now();
    recording = true;
    ensureTicking();
    bus.emit('record:started', { sessionId });
    emitStat();
  }

  function stopRecording(reason) {
    if (recording) sessionEndISO = new Date().toISOString();   // [C6]
    recording = false;
    ensureTicking();
    bus.emit('record:stopped', { reason: reason || 'user' });
    emitStat();
  }

  function buildPayload() {
    return {
      meta: {
        schemaVersion: CFG.SCHEMA_VERSION,              // [C9]
        collector: 'rbc-v2.2-charstream',

        // --- 세션 [C6] ---
        sessionId,
        startedAt: sessionStartISO,
        endedAt: sessionEndISO || new Date().toISOString(),
        focusMs: recordedTicks * CFG.TICK_MS,           // 기록된 틱 = focus 상태였던 틱

        // --- 페이지 [C7] ---
        url: location.href,
        title: document.title,
        referrer: document.referrer || null,
        enteredAt: new Date(pageEnteredAt).toISOString(),
        leftAt: pageLeftAt ? new Date(pageLeftAt).toISOString() : null,
        devicePixelRatio: window.devicePixelRatio,
        userAgent: navigator.userAgent,

        // --- 세션 쿼리 [C8] ---
        searchQuery: searchQuery || null,
        searchQuerySource: searchQuery
          ? (searchQueryFromReferrer() === searchQuery ? 'referrer' : 'manual') : null,

        // --- 수집 설정 ---
        tickMs: CFG.TICK_MS,
        centerRatio: CFG.CENTER_RATIO,
        frameTag: TAG,
        isTopFrame: IS_TOP,
        chunking: RBC.units.opts(),
        idleTimeoutMs: CFG.IDLE_TIMEOUT_MS,

        notes: [
          '원본 값만 수집. 정규화·z-score·개인화 보정은 전부 오프라인/BE 담당.',
          '유닛 = 본문 텍스트 스트림의 글자 오프셋 구간. DOM 문단이 아님.',
          'pid = 유닛 텍스트 해시. 재스캔해도 같은 글이면 같은 pid.',
          'visTop/visBot = 그 틱에 뷰포트에 보이던 유닛 order 범위(양끝 포함). ' +
          '체류시간(뷰포트 노출 누적)은 이걸로 오프라인 계산.',
          'centerPid = 뷰포트 49% 중앙선 유닛. GVAM 캐비엣: 중앙선=focus 가정은 ' +
          'dwell에서만 검증됨. scroll_speed/scrlfreq/entry_scrlspeed는 미검증 가정 위.',
          'cursorPid=null 은 커서가 여백/이미지/sticky 위 (A채널 결측).',
          '탭이 숨겨졌거나 창이 포커스를 잃은 동안의 틱은 기록하지 않음. ' +
          'focusMs = 기록된 틱 수 × tickMs.',
          'highlight/copy 의 pids = 선택이 걸친 유닛 전부. pid는 첫 유닛(하위호환).',
          'scrollSpeed 부호 = 스크롤 방향. 감속은 속도 시계열을 미분해서 얻을 것.',
          'type=rescan mode=disruptive-skipped 이벤트가 있으면 본문이 교체된 세션.',
        ],

        paragraphs: RBC.units.all().map(u => ({
          pid: u.pid, order: u.order, charLen: u.charLen, text: u.text.slice(0, 1000),
        })),
      },
      timeline,
    };
  }

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

  function emitStat() {
    const u = RBC.units.byPid(lastCenterPid);
    const s = {
      res: 'stat', tag: TAG, recording, overlayOn, isPrimary,
      units: RBC.units.count(), samples: timeline.length,
      centerPid: lastCenterPid, cursorPid: lastCursorPid,
      scrollSpeed: Math.round(lastScrollSpeed),
      centerText: u ? (u.order + ' · ' + u.text.slice(0, 26)) : '',
      query: searchQuery || '',
      focusSec: Math.round(recordedTicks * CFG.TICK_MS / 1000),
      href: location.href,
    };
    if (IS_TOP) bus.emit('stat', s); else toTop(s);
  }

  function handleCmd(m) {
    switch (m.cmd) {
      case 'scan':
        bus.emit('cmd:scan');          // primary 아닌 프레임도 돈다 (선출 근거)
        break;
      case 'primary':
        isPrimary = (m.tag === TAG);
        if (!isPrimary) {
          if (recording) timeline.push({ type: 'demoted', t: tNow() });
          recording = false;
          bus.emit('record:stopped', { reason: 'demoted' });   // 미러 동기화
          bus.emit('cmd:overlay', { on: false });
          ensureTicking();
        }
        break;
      case 'chunk':
        if (recording) break;          // BUG-1
        if (isPrimary) { bus.emit('cmd:chunk', m); emitStat(); }
        break;
      case 'list':
        if (isPrimary) bus.emit('cmd:list');
        break;
      case 'focus': setFocus(!!m.on); break;              // [C2]
      case 'activity': lastActivityAt = Date.now(); break; // [C5]
      case 'query':                                        // [C8]
        searchQuery = (m.q || '').trim() || null;
        if (isPrimary) emitStat();
        break;
      case 'start': if (isPrimary) startRecording(m); break;
      case 'stop': if (isPrimary) stopRecording(); break;
      case 'overlay':
        if (isPrimary) bus.emit('cmd:overlay', m);
        break;
      case 'export':
        if (isPrimary) {
          if (IS_TOP) download(buildPayload());
          else toTop({ res: 'export', payload: buildPayload() });
        }
        break;
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
    if (recording) return;
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
      if (searchQuery) send('query', { q: searchQuery });               // [C8]
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
      const wait = recording ? CFG.MUTATION_DEBOUNCE_REC : CFG.MUTATION_DEBOUNCE;
      mutTimer = setTimeout(() => {
        if (!RBC.units.count()) {
          // 아직 본문을 못 잡음. auto=true 로 호출해야 재시도 카운터가 유지된다.
          if (IS_TOP && scanTries < CFG.SCAN_RETRY_MAX) doScan(true);
          return;
        }
        if (recording && Date.now() - lastRescanAt < CFG.RESCAN_MIN_GAP_REC) return;
        lastRescanAt = Date.now();
        RBC.units.rescan({ preserve: true });
        emitStat();
      }, wait);
    });
    retargetObserver();
  }

  // ==========================================================================
  // init
  // ==========================================================================
  // 8-overlay.js 가 overlayOn 을 바꾸면 미러를 맞추고 틱 필요 여부를 재평가한다.
  bus.on('overlay:changed', (d) => {
    overlayOn = !!(d && d.on);
    ensureTicking();
  });
  // [R1] 전: rescan() 이 retargetObserver() 를 직접 호출
  bus.on('units:changed', () => {
    retargetObserver();
  });

  // [R3] 전: rescan() 이 timeline.push 를 직접 호출.
  //   기록 중이 아니면 안 남긴다 (원래 동작과 동일).
  bus.on('units:rescanned', (d) => {
    if (recording) {
      timeline.push({ type: 'rescan', t: tNow(), mode: d.mode, units: d.count });
    }
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


  function init() {
    searchQuery = searchQueryFromReferrer();      // [C8]
    if (IS_TOP) {
      winFocused = !document.hidden && document.hasFocus();
    }
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
    watchMutations();
    if (IS_TOP) setTimeout(() => doScan(), CFG.FIRST_SCAN_DELAY);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // 인터페이스를 지금 확정해두면, 실제 구현이 옮겨갈 때 8-overlay.js 는 안 고쳐도 된다.

  RBC.frames = { send, doScan, isPrimary: () => isPrimary };
  RBC.recorder = { query: () => searchQuery };

})();