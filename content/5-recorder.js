/* =============================================================================
 * 5-recorder.js — 마스터 틱 · 페이지 구간 · timeline 조각
 *
 * 소유: recording, 구간(segId, segPageId, segMeta), timeline 버퍼, tickTimer,
 *       flushTimer, tickCount, prev*(틱 간 비교값), searchQuery, 마지막 틱 표시값
 * 의존(직접 호출): 0-core, 2-units, 3-hittest, 4-input
 * 발행: record:started, record:stopped, tick:done, stat, seg:page, seg:chunk
 * 구독: cmd:start, cmd:stop, cmd:query, primary:changed,
 *       overlay:changed, units:changed, units:rescanned,
 *       sel:highlight, sel:copy, visibility, focus, pagehide
 *
 * --- 이 레이어가 하는 일 ----------------------------------------------------
 *   150ms 마스터 클럭을 돌리고, 그 순간의 관측을 timeline 에 원본 그대로 남긴다.
 *   DOM 을 직접 읽지 않는다 — 측정은 3-hittest.sample(), 입력은 4-input.drain().
 *   측정과 기록을 갈라놔야 "패널이 느려서 틱이 밀렸나"를 구분할 수 있다.
 *
 * --- 세션은 여기 없다 --------------------------------------------------------
 *   세션(sessionId, epoch)은 background 가 소유한다. 여기서 "기록 중"은
 *   "이 문서에서 지금 글의 구간을 기록 중"이라는 뜻이다.
 *   start() 는 background 가 준 sessionId/epoch 로 구간을 연다. 같은 세션에서
 *   여러 번 불릴 수 있다 — 새 탭 합류, SPA 이동 뒤 새 글, primary 교체.
 *
 * --- 구간 (segId) -------------------------------------------------------------
 *   start() 한 번 = 구간 하나 = segId 하나. "이 탭에서 이 글을 연 이번 구간".
 *   새 구간이 생기는 때: 세션 합류, 새로고침, SPA 이동 뒤 새 글, primary 교체.
 *   탭 전환은 구간을 바꾸지 않는다 — 떠났다 돌아와도 같은 segId 가 이어지고,
 *   그 사이는 visibility/focus 이벤트와 틱 공백으로 남는다.
 *   export 는 글(pageId) 단위로 합치지만 이벤트마다 segId·tabId 가 남는다.
 *
 *   연속 틱 간 차분(스크롤 감속, 커서 이동 등)의 리셋 규칙 — extract_features 용:
 *     segId 가 바뀌거나, 연속 두 틱의 t 간격이 2 × tickMs 를 넘으면 리셋.
 *   이 하나로 탭 전환·창 이탈·같은 글 다른 탭·재방문이 전부 걸린다.
 *
 * --- 내보내기 ---------------------------------------------------------------
 *   구간을 열 때 seg:page (글 정보 + 유닛 목록), 그 뒤 FLUSH_MS 마다 seg:chunk
 *   (그동안 쌓인 이벤트). 버퍼는 넘기는 즉시 비운다. background 로 실어 나르는
 *   건 11-session 이다 — 여기는 chrome.runtime 을 모른다.
 *   조각 경계는 데이터에 영향이 없다. 이어 붙이면 같은 timeline 이다.
 *
 * --- 원칙 ------------------------------------------------------------------
 *   원본만 남긴다. 정규화·z-score·개인화 보정은 전부 오프라인/BE 담당.
 *   여기서 판단을 섞으면 나중에 feature 정의를 바꿀 때 재수집을 해야 한다.
 *
 * --- 미러 두 개 -------------------------------------------------------------
 *   isPrimary(6-frames 소유), overlayOn(8-overlay 소유) 은 읽기 전용 사본이다.
 *   이벤트로만 갱신하고 여기서 직접 대입하지 않는다.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus, IS_TOP, TAG } = RBC;
  const { uuid, searchQueryFromReferrer, pageId } = RBC.util;

  // --- 소유 상태 ---
  let recording = false;
  let timeline = [];                  // 아직 넘기지 않은 이벤트만 들고 있다
  let tickTimer = null;
  let flushTimer = null;
  let tickCount = 0;
  let segTicks = 0;                   // 이 구간에서 기록한 틱 수 (패널 표시용)
  let segEvents = 0;                  // 이 구간에서 기록한 이벤트 수 (패널 표시용)

  let prevTickCursor = null;
  let prevScrollY = window.scrollY;
  let prevTickTime = null;

  let sessionId = null;
  let sessionEpoch = 0;
  let segId = null;
  let segPageId = null;               // 구간을 연 순간의 글. 이동 뒤에도 이 구간은 이 글이다
  let segMeta = null;                 // 구간을 연 순간에 캡처한 글 정보
  let searchQuery = searchQueryFromReferrer();   // [C8]

  let lastCenterPid = null, lastCursorPid = null, lastScrollSpeed = 0;

  // --- 미러 (읽기 전용) ---
  let isPrimary = IS_TOP;
  let overlayOn = false;

  function tNow() { return Date.now() - sessionEpoch; }

  function push(e) {
    timeline.push(e);
    segEvents++;
  }

  // ==========================================================================
  // 마스터 틱
  // ==========================================================================
  function tick() {
    // [C2] 탭이 숨겨졌거나 브라우저 창이 포커스를 잃은 동안은 기록하지 않는다.
    //      비활성 탭에서 틱이 안 도는 것도 이 줄 덕분이다.
    if (recording && (document.hidden || !RBC.input.focused())) { prevTickTime = null; return; }

    // [C5] 30분 무동작 → 자동 종료 (세션 종료는 11-session 이 background 로 올린다)
    if (recording && RBC.input.idleMs() > CFG.IDLE_TIMEOUT_MS) {
      push({ type: 'autostop', t: tNow(), reason: 'idle', segId });
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
      push({
        type: 'tick',
        t: tNow(),
        segId,
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
      segTicks++;
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
  // 내보내기 — 여기는 사실만 발행한다. 실어 나르는 건 11-session.
  // ==========================================================================
  function paragraphs() {
    return RBC.units.all().map(u => ({
      pid: u.pid, order: u.order, charLen: u.charLen, text: u.text.slice(0, 1000),
    }));
  }

  // 글 정보 + 유닛 목록. 구간을 열 때, 그리고 기록 중 유닛이 늘었을 때(append).
  // background 는 pid 합집합으로 합치므로 여러 번 보내도 된다.
  function emitPage() {
    bus.emit('seg:page', {
      sessionId, pageId: segPageId, segId,
      meta: segMeta,
      paragraphs: paragraphs(),
    });
  }

  function flush() {
    if (!timeline.length) return;
    const events = timeline;
    timeline = [];
    bus.emit('seg:chunk', { sessionId, pageId: segPageId, segId, events });
  }

  // export JSON 의 페이지 meta 가 된다. 세션 필드(sessionId, startedAt, endedAt,
  // focusMs)와 paragraphs 는 background 가 채운다.
  // 이 모양은 extract_features.py 와의 계약이다 — 바꾸려면 schemaVersion 을
  // 올리고 양쪽을 같이 고칠 것.
  function buildMeta() {
    return {
      schemaVersion: CFG.SCHEMA_VERSION,              // [C9]
      collector: 'rbc-v2.3-session',

      // --- 페이지 [C7] — 구간을 연 순간의 값. export 시점의 location 이 아니다 ---
      url: location.href,
      title: document.title,
      referrer: document.referrer || null,
      enteredAt: new Date().toISOString(),
      leftAt: null,
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
        '한 페이지 = 같은 글(pageId)의 모든 구간(segId)을 합친 것. 탭 전환은 ' +
        '구간을 바꾸지 않는다(visibility/focus 이벤트 + 틱 공백으로 남음).',
        '연속 틱 간 차분은 segId 가 바뀌거나 두 틱의 t 간격이 2×tickMs 를 넘으면 리셋.',
        'tabId 는 background 가 붙인다(sender.tab.id).',
      ],
    };
  }

  // ==========================================================================
  // 구간 제어
  // ==========================================================================
  function start(m) {
    if (recording) return;                             // 같은 구간을 두 번 열지 않는다
    if (!RBC.units.count()) RBC.units.rescan({});
    timeline = [];
    segTicks = 0;
    segEvents = 0;
    sessionId = (m && m.sessionId) || uuid();          // 단독 실행(background 없음) 대비
    sessionEpoch = (m && m.epoch) || Date.now();
    if (m && m.query) searchQuery = m.query;           // [C8]
    if (!searchQuery) searchQuery = searchQueryFromReferrer();

    segId = uuid();
    segPageId = pageId(location.href);
    segMeta = buildMeta();

    RBC.input.bump();                                   // idle 타이머 초기화
    recording = true;
    ensureTicking();
    emitPage();
    flushTimer = setInterval(flush, CFG.FLUSH_MS);
    bus.emit('record:started', { sessionId, segId });
    emitStat();
  }

  // 구간을 닫는다. 세션을 닫는 게 아니다 — 세션 종료는 background 가 정한다.
  // reason: 'user'(세션 정지 방송) | 'idle' | 'demoted' | 'navigation'(11-session)
  function stop(reason) {
    if (recording) push({ type: 'segend', t: tNow(), segId, reason: reason || 'user' });
    flush();                                           // 마지막 조각까지 넘기고 닫는다
    clearInterval(flushTimer); flushTimer = null;
    recording = false;
    ensureTicking();
    bus.emit('record:stopped', { reason: reason || 'user', segId });
    emitStat();
  }

  // ==========================================================================
  // 패널 표시용 통계
  //   여기서는 만들기만 한다. 최상위로 보내는 건 6-frames, 그리는 건 9-panel.
  // ==========================================================================
  function emitStat() {
    const u = RBC.units.byPid(lastCenterPid);
    bus.emit('stat', {
      res: 'stat', tag: TAG, recording, overlayOn, isPrimary,
      units: RBC.units.count(), samples: segEvents,
      centerPid: lastCenterPid, cursorPid: lastCursorPid,
      scrollSpeed: Math.round(lastScrollSpeed),
      centerText: u ? (u.order + ' · ' + u.text.slice(0, 26)) : '',
      query: searchQuery || '',
      focusSec: Math.round(segTicks * CFG.TICK_MS / 1000),
      href: location.href,
    });
  }

  // ==========================================================================
  // 구독 — 명령
  //   primary 게이트는 6-frames 가 이미 걸었다. 여기서 또 보지 않는다.
  // ==========================================================================
  bus.on('cmd:start', (m) => start(m));
  bus.on('cmd:stop', (m) => stop((m && m.reason) || 'user'));   // 6-frames 가 사유를 실어 보낸다

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

  // primary 를 잃으면 이 프레임의 구간은 끝난다. demoted 를 남긴다.
  bus.on('primary:changed', (d) => {
    isPrimary = !!(d && d.isPrimary);
    if (!isPrimary && recording) {
      push({ type: 'demoted', t: tNow(), segId });
      stop('demoted');
    }
  });

  // ==========================================================================
  // 구독 — 기록할 사실들
  //   4-input 은 "무슨 일이 있었다"만 알린다. 기록 여부 판단은 전부 여기.
  // ==========================================================================
  bus.on('sel:highlight', (d) => {
    if (!recording) return;
    push({ type: 'highlight', t: tNow(), segId, pids: d.pids, pid: d.pids[0] || null, text: d.text });
  });

  bus.on('sel:copy', (d) => {
    if (!recording) return;
    push({ type: 'copy', t: tNow(), segId, pids: d.pids, pid: d.pids[0] || null, text: d.text });
  });

  // 탭을 떠나는 순간 바로 넘긴다. 떠난 탭은 틱이 멈추니 다음 flush 까지 기다릴 이유가 없다.
  bus.on('visibility', (d) => {
    if (recording) {
      push({ type: 'visibility', t: tNow(), segId, hidden: d.hidden });
      if (d.hidden) flush();
    }
    if (!d.hidden) prevTickTime = null;
  });

  bus.on('focus', (d) => {
    if (recording) push({ type: 'focus', t: tNow(), segId, focused: d.focused });
    if (d.focused) prevTickTime = null;        // 복귀 직후 dt 튐 방지
  });

  // 문서가 내려간다. 이 뒤로는 기회가 없으니 지금 넘긴다.
  // (전송이 유실될 수 있다 — 손실은 최대 FLUSH_MS 분량)
  bus.on('pagehide', () => {                   // [C7]
    if (!recording) return;
    push({ type: 'pagehide', t: tNow(), segId });
    flush();
  });

  // [R3] 전: rescan() 이 timeline.push 를 직접 호출했다.
  // 유닛이 늘거나 바뀌었으면(append/full) 유닛 목록도 다시 보낸다. 안 보내면 새 pid 가
  // timeline 에만 있고 meta.paragraphs 에는 없어서 pid 정합성이 깨진다.
  bus.on('units:rescanned', (d) => {
    if (!recording) return;
    push({ type: 'rescan', t: tNow(), segId, mode: d.mode, units: d.count });
    if (d.mode !== 'disruptive-skipped') emitPage();
  });

  // 유닛이 바뀌면 패널 숫자도 바뀐다.
  bus.on('units:changed', () => emitStat());

  // ==========================================================================
  // 공개
  // ==========================================================================
  RBC.recorder = {
    isRecording: () => recording,
    query: () => searchQuery,                  // 9-panel 의 검색어 입력 초기값
    segment: () => ({ sessionId, segId, pageId: segPageId }),
    start,
    stop,
  };
})();