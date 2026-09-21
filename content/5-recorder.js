/* =============================================================================
 * 5-recorder.js — 마스터 틱 · timeline · 세션 · payload
 *
 * 소유: recording, timeline, tickTimer, tickCount, recordedTicks,
 *       prev*(틱 간 비교값), 세션 메타, searchQuery, 마지막 틱 표시값
 * 의존(직접 호출): 0-core, 2-units, 3-hittest, 4-input
 * 발행: record:started, record:stopped, tick:done, stat, export:ready
 * 구독: cmd:start, cmd:stop, cmd:export, cmd:query, primary:changed,
 *       overlay:changed, units:changed, units:rescanned,
 *       sel:highlight, sel:copy, visibility, focus, pagehide
 *
 * --- 이 레이어가 하는 일 ----------------------------------------------------
 *   150ms 마스터 클럭을 돌리고, 그 순간의 관측을 timeline 에 원본 그대로 남긴다.
 *   DOM 을 직접 읽지 않는다 — 측정은 3-hittest.sample(), 입력은 4-input.drain().
 *   측정과 기록을 갈라놔야 "패널이 느려서 틱이 밀렸나"를 구분할 수 있다.
 *
 * --- 원칙 ------------------------------------------------------------------
 *   원본만 남긴다. 정규화·z-score·개인화 보정은 전부 오프라인/BE 담당.
 *   여기서 판단을 섞으면 나중에 feature 정의를 바꿀 때 재수집을 해야 한다.
 *
 * --- 미러 두 개 -------------------------------------------------------------
 *   isPrimary(6-frames 소유), overlayOn(8-overlay 소유) 은 읽기 전용 사본이다.
 *   이벤트로만 갱신하고 여기서 직접 대입하지 않는다. 그 파일이 없으면 기본값으로
 *   남고, 그게 맞는 동작이다.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus, IS_TOP, TAG } = RBC;
  const { uuid, searchQueryFromReferrer } = RBC.util;

  // --- 소유 상태 ---
  let recording = false;
  let timeline = [];
  let tickTimer = null;
  let tickCount = 0;
  let recordedTicks = 0;              // [C6] focusMs = 이 수 × tickMs

  let prevTickCursor = null;
  let prevScrollY = window.scrollY;
  let prevTickTime = null;

  const pageEnteredAt = Date.now();   // [C7]
  let pageLeftAt = null;

  let sessionId = null;               // [C6]
  let sessionEpoch = 0;
  let sessionStartISO = null;
  let sessionEndISO = null;
  let searchQuery = searchQueryFromReferrer();   // [C8]

  let lastCenterPid = null, lastCursorPid = null, lastScrollSpeed = 0;

  // --- 미러 (읽기 전용) ---
  let isPrimary = IS_TOP;
  let overlayOn = false;

  function tNow() { return Date.now() - sessionEpoch; }

  // ==========================================================================
  // 마스터 틱
  // ==========================================================================
  function tick() {
    // [C2] 탭이 숨겨졌거나 브라우저 창이 포커스를 잃은 동안은 기록하지 않는다.
    if (recording && (document.hidden || !RBC.input.focused())) { prevTickTime = null; return; }

    // [C5] 30분 무동작 → 자동 종료
    if (recording && RBC.input.idleMs() > CFG.IDLE_TIMEOUT_MS) {
      timeline.push({ type: 'autostop', t: tNow(), reason: 'idle' });
      stop('idle');
      return;
    }

    const now = performance.now();
    const scrollY = window.scrollY;
    const dt = prevTickTime != null ? (now - prevTickTime) / 1000 : 0;
    const cursor = RBC.input.cursor();
    const ev = RBC.input.drain();          // 틱당 정확히 한 번. 읽으면서 리셋.

    const s = RBC.hittest.sample(cursor);  // 이 틱의 DOM 조회는 전부 여기서
    const centerU = s.centerU;
    const centerPid = centerU ? centerU.pid : null;
    const scrollSpeed = dt > 0 ? (scrollY - prevScrollY) / dt : 0;

    let cursorPid = null, cx = null, cy = null, cursorDist = 0, cursorMoved = false;
    if (cursor) {
      cx = cursor.x; cy = cursor.y;
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
        scrollEvents: ev.scrollEvents,
        mouseEvents: ev.mouseEvents,            // [C3]
        centerPid,                              // B채널 귀속
        visTop: s.visTop, visBot: s.visBot,     // [C1] 이 사이 유닛은 화면에 노출됨
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
    if (cursor) prevTickCursor = { x: cursor.x, y: cursor.y };

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
  // 녹화 제어
  // ==========================================================================
  function start(m) {
    if (!RBC.units.count()) RBC.units.rescan({});
    timeline = [];
    recordedTicks = 0;
    sessionId = (m && m.sessionId) || uuid();          // [C6]
    sessionEpoch = (m && m.epoch) || Date.now();
    sessionStartISO = new Date(sessionEpoch).toISOString();
    sessionEndISO = null;
    if (m && m.query) searchQuery = m.query;           // [C8]
    if (!searchQuery) searchQuery = searchQueryFromReferrer();
    RBC.input.bump();                                   // idle 타이머 초기화
    recording = true;
    ensureTicking();
    bus.emit('record:started', { sessionId });
    emitStat();
  }

  function stop(reason) {
    if (recording) sessionEndISO = new Date().toISOString();   // [C6]
    recording = false;
    ensureTicking();
    bus.emit('record:stopped', { reason: reason || 'user' });
    emitStat();
  }

  // ==========================================================================
  // payload
  //   export JSON 스키마는 extract_features.py 와의 계약이다. 한 글자도
  //   바꾸지 않는다 — 바꾸려면 schemaVersion 을 올리고 양쪽을 같이 고칠 것.
  // ==========================================================================
  function buildPayload() {
    return {
      meta: {
        schemaVersion: CFG.SCHEMA_VERSION,              // [C9]
        collector: 'rbc-v2.2-charstream',

        // --- 세션 [C6] ---
        sessionId,
        startedAt: sessionStartISO,
        endedAt: sessionEndISO || new Date().toISOString(),
        focusMs: recordedTicks * CFG.TICK_MS,

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
          '기사 제목은 유닛에 포함되지 않는다(본문 루트 밖). 제목 텍스트는 meta.title.',
        ],

        paragraphs: RBC.units.all().map(u => ({
          pid: u.pid, order: u.order, charLen: u.charLen, text: u.text.slice(0, 1000),
        })),
      },
      timeline,
    };
  }

  // ==========================================================================
  // 패널 표시용 통계
  //   여기서는 만들기만 한다. 최상위로 보내는 건 6-frames, 그리는 건 9-panel.
  // ==========================================================================
  function emitStat() {
    const u = RBC.units.byPid(lastCenterPid);
    bus.emit('stat', {
      res: 'stat', tag: TAG, recording, overlayOn, isPrimary,
      units: RBC.units.count(), samples: timeline.length,
      centerPid: lastCenterPid, cursorPid: lastCursorPid,
      scrollSpeed: Math.round(lastScrollSpeed),
      centerText: u ? (u.order + ' · ' + u.text.slice(0, 26)) : '',
      query: searchQuery || '',
      focusSec: Math.round(recordedTicks * CFG.TICK_MS / 1000),
      href: location.href,
    });
  }

  // ==========================================================================
  // 구독 — 명령
  //   primary 게이트는 6-frames 가 이미 걸었다. 여기서 또 보지 않는다.
  // ==========================================================================
  bus.on('cmd:start', (m) => start(m));
  bus.on('cmd:stop', () => stop('user'));
  bus.on('cmd:export', () => bus.emit('export:ready', buildPayload()));

  bus.on('cmd:query', (m) => {                       // [C8] 모든 프레임이 갱신
    searchQuery = (m.q || '').trim() || null;
    if (isPrimary) emitStat();
  });

  // ==========================================================================
  // 구독 — 미러
  // ==========================================================================
  bus.on('overlay:changed', (d) => {
    overlayOn = !!(d && d.on);
    ensureTicking();
  });

  // primary 를 잃으면 기록이 끊긴다. 전에는 이게 조용히 일어나서
  // "왜 데이터가 중간에 없지"를 추적할 수 없었다. demoted 를 남긴다.
  bus.on('primary:changed', (d) => {
    isPrimary = !!(d && d.isPrimary);
    if (!isPrimary && recording) {
      timeline.push({ type: 'demoted', t: tNow() });
      stop('demoted');
    }
  });

  // ==========================================================================
  // 구독 — 기록할 사실들
  //   4-input 은 "무슨 일이 있었다"만 알린다. 기록 여부 판단은 전부 여기.
  // ==========================================================================
  bus.on('sel:highlight', (d) => {
    if (!recording) return;
    timeline.push({ type: 'highlight', t: tNow(), pids: d.pids, pid: d.pids[0] || null, text: d.text });
  });

  bus.on('sel:copy', (d) => {
    if (!recording) return;
    timeline.push({ type: 'copy', t: tNow(), pids: d.pids, pid: d.pids[0] || null, text: d.text });
  });

  bus.on('visibility', (d) => {
    if (recording) timeline.push({ type: 'visibility', t: tNow(), hidden: d.hidden });
    if (!d.hidden) prevTickTime = null;
  });

  bus.on('focus', (d) => {
    if (recording) timeline.push({ type: 'focus', t: tNow(), focused: d.focused });
    if (d.focused) prevTickTime = null;        // 복귀 직후 dt 튐 방지
  });

  bus.on('pagehide', () => {                   // [C7]
    pageLeftAt = Date.now();
    if (recording) timeline.push({ type: 'pagehide', t: tNow() });
  });

  // [R3] 전: rescan() 이 timeline.push 를 직접 호출했다.
  bus.on('units:rescanned', (d) => {
    if (recording) timeline.push({ type: 'rescan', t: tNow(), mode: d.mode, units: d.count });
  });

  // 유닛이 바뀌면 패널 숫자도 바뀐다.
  bus.on('units:changed', () => emitStat());

  // ==========================================================================
  // 공개
  // ==========================================================================
  RBC.recorder = {
    isRecording: () => recording,
    query: () => searchQuery,                  // 9-panel 의 검색어 입력 초기값
    payload: buildPayload,
    start,
    stop,
  };
})();