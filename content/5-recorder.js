/* =============================================================================
 * 5-recorder.js — 마스터 틱 · 페이지 구간 · timeline 조각
 *
 * 소유: recording, 구간(segId, segPageId, segMeta), timeline 버퍼, tickTimer,
 *       flushTimer, tickCount, prev*(틱 간 비교값), searchQuery, 마지막 틱 표시값
 * 의존(직접 호출): 0-core, 1-stream(rootInfo), 2-units, 3-hittest, 4-input
 * 발행: record:started, record:stopped, tick:done, stat, seg:page, seg:chunk, settle:empty
 * 구독: cmd:start, cmd:stop, cmd:query, primary:changed,
 *       overlay:changed, units:changed, units:rescanned,
 *       sel:highlight, sel:copy, visibility, focus, pagehide,
 *       label:mode, label:ask, label:done
 *
 * --- 이 레이어가 하는 일 ----------------------------------------------------
 *   150ms 마스터 클럭을 돌리고, 그 순간의 관측을 timeline 에 원본 그대로 남긴다.
 *   DOM 을 직접 읽지 않는다 — 측정은 3-hittest.sample(), 입력은 4-input.drain().
 *   측정과 기록을 갈라놔야 "패널이 느려서 틱이 밀렸나"를 구분할 수 있다.
 *   (예외: 스크롤 위치 · 뷰포트 크기 같은 스칼라는 직접 읽는다. 주체 요소는 4-input 이 정한다.)
 *
 * --- 스크롤 주체 (v3, 감사 §8-6) ----------------------------------------------
 *   tick.scrollY / docH = 본문 스크롤 주체(4-input.scroller())의 scrollTop / scrollHeight,
 *   주체가 window 면 window.scrollY / documentElement.scrollHeight (v2 와 같은 값).
 *   주체가 바뀔 때와 구간 시작 때 { type:'scroller', t, segId, path:'window'|[tag,id,class,role] }.
 *
 * --- drain 을 버리는 때 (v3) ---------------------------------------------------
 *   틱을 건너뛸 때(숨김 · 포커스 없음)와 구간을 열 때. 안 버리면 그 사이 쌓인 카운터가
 *   다음 기록 틱에 섞인다.
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
 *   첫 틱이 찍히는 순간 seg:page (글 정보 + 유닛 목록), 그 뒤 FLUSH_MS 마다
 *   seg:chunk (그동안 쌓인 이벤트). 버퍼는 넘기는 즉시 비운다. background 로
 *   실어 나르는 건 11-session 이다 — 여기는 chrome.runtime 을 모른다.
 *   조각 경계는 데이터에 영향이 없다. 이어 붙이면 같은 timeline 이다.
 *
 * --- 안 본 탭은 아무것도 내보내지 않는다 ------------------------------------
 *   세션이 시작되면 열린 탭 전부가 구간을 연다. 그런데 "읽었다"의 기준은 틱이고,
 *   틱은 보이고 + 창 포커스가 있을 때만 찍힌다. 그래서 첫 틱 전까지는 URL·제목·
 *   원문(seg:page)도, 이벤트(seg:chunk)도 내보내지 않는다. 첫 틱이 없이 구간이
 *   닫히면 버퍼를 버린다. 안 본 탭은 background 저장소에 흔적이 남지 않는다.
 *   (개인정보 · 로그 크기 · 빈 페이지 때문에 check_session 이 FAIL 하는 문제를
 *    한 번에 막는다)
 *
 * --- 조각 번호 n ------------------------------------------------------------
 *   구간마다 0 부터. background 가 export 때 (segId, n) 으로 중복을 빼고,
 *   빠진 번호로 유실을 찾는다.
 *
 * --- 원칙 ------------------------------------------------------------------
 *   원본만 남긴다. 정규화·z-score·개인화 보정은 전부 오프라인/BE 담당.
 *   여기서 판단을 섞으면 나중에 feature 정의를 바꿀 때 재수집을 해야 한다.
 *
 * --- 라벨 모드 (12-label) ----------------------------------------------------
 *   label:mode{on:true} 동안 틱을 찍지 않는다 (숨김 · 포커스 없음과 같은 처리: drain 버림).
 *   라벨 고르는 시간은 읽기 행동이 아니다 (명세). 선택 · 복사도 기록하지 않는다.
 *   v2 (라벨_명세_v2.md §6). 끝 도달 질문 카드가 떠 있는 동안은 계속 기록한다(무시하고 읽는 사람 대비).
 *   label:ask  → { type:'labelask', t, segId, answer, startT, ms }  answer = yes | no | cancel.
 *                startT = 카드가 뜬 때(t − shownMs). 이 구간의 틱은 정상 기록이다.
 *                yes 면 바로 label:mode{on:true} — 라벨 모드(틱 정지)는 여기부터.
 *   label:done → { type:'label', v:2, t, segId, trigger, cancelled, startT, ms, phaseMs,
 *                  ratings, ratingLog, excluded, marks, survey } 를 남기고 바로 넘긴다.
 *     startT = 라벨 모드 시작 t, ms = t − startT. 취소여도 채운 값은 남긴다 — 틱 공백의 이유가 데이터에 남게.
 *   하이라이트 · 복사와 다른 이벤트다 (행동 feature 와 정답이 섞이지 않게).
 *
 * --- 본문 준비 중 대기 (0-B 마지막, 2026-10-08) ------------------------------------
 *   start() 는 바로 구간을 열지 않는다. SETTLE_POLL_MS 마다 전체 재스캔하고, 본문 스트림 글자가
 *   SETTLE_QUIET_MS 동안 안 바뀌면 그때 begin() 으로 구간을 연다(최대 SETTLE_MAX_MS).
 *   대기 중엔 recording 이 꺼져 있어 재스캔은 전체 재청킹 = 기록 시작 순간의 최신 렌더로 유닛 확정.
 *   그 뒤 늦게 끼는 글은 splice 가 받는다.
 *   - 기준은 DOM 변경이 아니라 글자 변경. 광고 회전 · 노션 호버 손잡이는 DOM 만 바꾼다 —
 *     DOM 기준이면 광고 많은 사이트가 매번 최대 대기를 채운다. 유닛이 글자로 정의되므로 기준도 글자.
 *   - 시계는 탭이 보일 때만 간다(document.hidden 이면 멈추고 조용함도 처음부터).
 *     세션 시작 때 열린 탭이 전부 start 를 받는데, 숨은 탭은 사용자가 처음 볼 때 대기한다.
 *     포커스는 안 본다 — 팝업이 열려 있으면 페이지 포커스가 없지만 탭은 보이고, 팝업이 대기를 보여 준다.
 *   - 대기 중 정지 · primary 교체 = 대기 취소(구간을 연 적이 없으니 segend 도 없다).
 *   - 구간을 열 때 { type:'settle', t, segId, ms, how: quiet|max, changes } 하나.
 *     ms = 보이는 동안 기다린 시간, changes = 대기 중 글이 바뀐 횟수(첫 스캔 제외).
 *     용도: 대기가 실제로 흡수했나(changes>0) · 글이 안 멈추는 페이지(max) · 대기 직후 splice 가 잦으면
 *     SETTLE_QUIET_MS 가 짧다는 근거. 판정 없이 check_session 요약에 표시.
 *   - 재스캔 비용은 대기 시간 동안만(노션 재스캔 중앙 11ms / 300ms).
 *   - 유닛이 0개면 구간을 열지 않고 계속 기다린다(최대 대기와 무관). SETTLE_ASK_MS 마다 settle:empty 를
 *     발행 → 6-frames 가 primary 를 다시 뽑는다. 최대 대기를 넘긴 뒤엔 SETTLE_EMPTY_POLL_MS 간격으로만 확인.
 *     이유 (2026-10-09 블로그 PC, 느린 와이파이): 본문 iframe 이 최상위의 스캔 재시도(약 9초)보다 늦게 떠서
 *     primary 선출이 실패 → 최상위가 기본 primary 로 유닛 0개 · 루트 body 를 기록. 기록 중엔 doScan 이 막혀
 *     iframe 이 다 떠도 영영 못 넘어갔다(대기 이전부터 있던 구멍). 0개로 구간을 열지 않으면 doScan 이 막히지 않고,
 *     다시 뽑기에서 iframe 이 이기면 primary:changed 로 이 대기는 취소되고 iframe 이 새로 대기를 시작한다.
 *     유닛 0개 구간은 어차피 droppedPages 로 버려지므로 잃는 데이터는 없다.
 *     최대 대기(max)는 본문을 찾은 뒤부터 잰다 — 안 그러면 늦게 뜬 iframe 이 뜨자마자 조용함 확인 없이 열린다.
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

  let prevScrollY = window.scrollY;
  let prevTickTime = null;

  let sessionId = null;
  let sessionEpoch = 0;
  let segId = null;
  let segPageId = null;               // 구간을 연 순간의 글. 이동 뒤에도 이 구간은 이 글이다
  let segMeta = null;                 // 구간을 연 순간에 캡처한 글 정보
  let pageSent = false;               // 첫 틱에 seg:page 를 보냈는가. 그 전엔 아무것도 안 나간다
  let chunkN = 0;                     // 이 구간의 다음 조각 번호
  let searchQuery = searchQueryFromReferrer();   // [C8]

  let lastScrollerEl;                 // 마지막으로 scroller 이벤트를 낸 주체. undefined = 아직 안 냄
  let lastCenterPid = null, lastCursorPid = null, lastScrollSpeed = 0;   // 스크롤 속도는 패널 표시용 내부 값
  let lastVisN = 0;                     // 패널 표시용 — 마지막 틱 vis 조각 수
  let labeling = false;                 // 12-label 의 라벨 모드 (label:mode 로만 갱신)
  let labelStartT = 0;
  let settle = null;                    // 본문 준비 중 대기 { m, at, waited, quiet, raw, changes, timer } | null

  // --- 미러 (읽기 전용) ---
  let isPrimary = IS_TOP;
  let overlayOn = false;

  function tNow() { return Date.now() - sessionEpoch; }

  function push(e) {
    timeline.push(e);
    segEvents++;
  }

  // 본문 스크롤 주체의 위치 · 높이. el = null 이면 window.
  function scrollState() {
    const el = RBC.input.scroller();
    return el
      ? { el, y: el.scrollTop, h: el.scrollHeight }
      : { el: null, y: window.scrollY, h: document.documentElement.scrollHeight };
  }

  // 주체가 바뀌었으면 scroller 이벤트. 기록 중에만 부른다.
  function noteScroller(el) {
    if (el === lastScrollerEl) return;
    lastScrollerEl = el;
    push({ type: 'scroller', t: tNow(), segId, path: el ? RBC.stream.attrs(el) : 'window' });
    prevTickTime = null;                       // 패널 속도: 다른 주체끼리 차분하지 않는다
  }

  // ==========================================================================
  // 마스터 틱
  // ==========================================================================
  function tick() {
    // [C2] 탭이 숨겨졌거나 브라우저 창이 포커스를 잃은 동안은 기록하지 않는다.
    //      비활성 탭에서 틱이 안 도는 것도 이 줄 덕분이다.
    if (recording && (document.hidden || !RBC.input.focused())) {
      RBC.input.drain();                       // v3: 공백 동안 쌓인 카운터는 버린다
      prevTickTime = null;
      return;
    }

    // 라벨 모드: 틱을 찍지 않는다. 무동작 판정보다 먼저 — 라벨 중에 자동 종료되면 안 된다.
    if (recording && labeling) {
      RBC.input.drain();
      prevTickTime = null;
      return;
    }

    // [C5] 30분 무동작 → 자동 종료 (세션 종료는 11-session 이 background 로 올린다)
    if (recording && RBC.input.idleMs() > CFG.IDLE_TIMEOUT_MS) {
      push({ type: 'autostop', t: tNow(), reason: 'idle', segId });
      stop('idle');
      return;
    }

    const now = performance.now();
    const sc = scrollState();
    if (recording) noteScroller(sc.el);
    const scrollY = sc.y;
    const dt = prevTickTime != null ? (now - prevTickTime) / 1000 : 0;
    const cursor = RBC.input.cursor();
    const ev = RBC.input.drain();          // 틱당 정확히 한 번. 읽으면서 리셋.

    const s = RBC.hittest.sample(cursor);  // 이 틱의 DOM 조회는 전부 여기서
    const centerU = s.centerU;
    const centerPid = centerU ? centerU.pid : null;
    const scrollSpeed = dt > 0 ? (scrollY - prevScrollY) / dt : 0;   // 패널 표시용 (로그에 안 넣음)

    let cursorPid = null, cx = null, cy = null;
    if (cursor) {
      cx = cursor.x; cy = cursor.y;
      cursorPid = s.cursorU ? s.cursorU.pid : null;
    }

    if (recording) {
      // 필드 순서 = 감사 §8 "v3 tick 최종 필드". media(세트 E) · fo(세트 D) 는 아직 없다.
      push({
        type: 'tick',
        t: tNow(),
        segId,
        scrollY,                                // v3: 본문 스크롤 주체 기준
        scrollEvents: ev.scrollEvents,          // 본문을 움직인 스크롤 이벤트
        scrollOther: ev.scrollOther,            // v3: 나머지 스크롤 (캐러셀 · 코드 블록 등)
        mouseEvents: ev.mouseEvents,            // [C3]
        mdx: ev.mdx, mdy: ev.mdy,               // v3: 직전 틱 이후 Σ|dx| · Σ|dy| (px)
        cursorPid,                              // A채널 귀속 (여백이면 null)
        cx, cy,
        centerPid,                              // B채널 귀속
        visTop: s.visTop, visBot: s.visBot,     // [C1] caret 탐침 — vis 교차검증용
        vis: s.vis,                             // v3: 뷰포트와 겹친 조각 [pid,k,top,bottom,left,right]
        edits: ev.edits,                        // v3: input 이벤트 개수 (0 이냐 아니냐로만)
        vw: window.innerWidth,
        vh: window.innerHeight,
        docH: sc.h,                             // v3: 본문 스크롤 주체 기준
        dpr: window.devicePixelRatio,           // v3: 기록 중 확대/축소
      });
      segTicks++;
      if (!pageSent) { pageSent = true; emitPage(); }   // 첫 틱 = 이 탭을 실제로 봤다
    }

    prevTickTime = now;
    prevScrollY = scrollY;

    lastCenterPid = centerPid; lastCursorPid = cursorPid; lastScrollSpeed = scrollSpeed;
    lastVisN = s.vis.length;
    bus.emit('tick:done', { centerU, cursorPid, vis: s.vis });
    if (++tickCount % CFG.STAT_EVERY === 0) emitStat();
  }

  function ensureTicking() {
    const want = recording || overlayOn;
    if (want && !tickTimer) {
      prevTickTime = null; prevScrollY = scrollState().y;
      tickTimer = setInterval(tick, CFG.TICK_MS);
    } else if (!want && tickTimer) {
      clearInterval(tickTimer); tickTimer = null;
    }
  }

  // ==========================================================================
  // 내보내기 — 여기는 사실만 발행한다. 실어 나르는 건 11-session.
  // ==========================================================================
  // 살아 있는 유닛 + 기록 중 splice 로 사라진 유닛(retired: true, order 는 살아 있는 것 뒤로 이어 붙임).
  //   retired 를 빼면 그 pid 를 참조한 옛 틱이 meta.paragraphs 에 없어 pid 정합성이 깨진다.
  function paragraphs() {
    const alive = RBC.units.all();
    const one = (u, order, gone) => {
      const p = { pid: u.pid, order, charLen: u.charLen, text: u.text.slice(0, 1000), pieces: u.pieces || [] };
      if (gone) { p.retired = true; p.after = u.after || null; }   // 사라질 때 바로 앞 유닛 pid (글 순서 복원용)
      return p;
    };
    return alive.map(u => one(u, u.order, false))
      .concat(RBC.units.retired().map((u, k) => one(u, alive.length + k, true)));
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
    if (!pageSent || !timeline.length) return;       // 첫 틱 전에는 쌓아만 둔다
    const events = timeline;
    timeline = [];
    bus.emit('seg:chunk', { sessionId, pageId: segPageId, segId, n: chunkN++, events });
  }

  // export JSON 의 페이지 meta 가 된다. 세션 필드(sessionId, startedAt, endedAt,
  // focusMs)와 paragraphs 는 background 가 채운다.
  // 이 모양은 extract_features.py 와의 계약이다 — 바꾸려면 schemaVersion 을
  // 올리고 양쪽을 같이 고칠 것.
  function buildMeta() {
    const ri = RBC.stream.rootInfo();
    return {
      schemaVersion: CFG.SCHEMA_VERSION,              // [C9]
      // v3 구현 단계 표시. A = 조각만, B = + vis, C = + 입력 · 스크롤 주체, L = + 라벨. 세트가 끝날 때마다 올린다.
      collector: 'rbc-v3-T',

      // --- 페이지 [C7] — 구간을 연 순간의 값. export 시점의 location 이 아니다 ---
      url: location.href,
      title: document.title,
      referrer: document.referrer || null,
      enteredAt: new Date().toISOString(),
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
      root: ri ? { el: ri.el, how: ri.how } : null,  // 본문 루트 [tag,id,class,role] · semantic|fallback|body
      idleTimeoutMs: CFG.IDLE_TIMEOUT_MS,

      notes: [
        '원본 값만 수집. 정규화·z-score·개인화 보정은 전부 오프라인/BE 담당.',
        '유닛 = 본문 텍스트 스트림의 글자 오프셋 구간. DOM 문단이 아님.',
        'pid = 유닛 텍스트 해시. 재스캔해도 같은 글이면 같은 pid.',
        'pieces = 유닛을 DOM 블록 경계로 나눈 조각. 배열 순서 = 조각 번호 k. off/chars 는 ' +
        '유닛 text(공백 정리 뒤, UTF-16) 기준이며 빈틈·겹침 없이 text 를 나눈다. linkChars = <a> 안 글자 수.',
        'pieces[].path = 조각의 가장 가까운 DOM 블록부터 루트 직전까지 최대 6단계 [tag,id,class,role]. ' +
        'pathCut = 6단계에서 잘림. DOM 블록이 루트 자신이면 []. meta.root = 루트 자신과 선택 방식.',
        '이탈 시각은 segend 이벤트 · session.chunkReport.end 로 본다 (meta.leftAt 없음).',
        'tick.vis = 그 틱에 뷰포트와 겹친 조각 [pid, k, top, bottom, left, right]. 자기 프레임 뷰포트 기준 CSS px, ' +
        '자르지 않음(음수 · vh 초과 허용). 조각마다 Range 외곽 상자. 같은 pid 의 조각은 세로 구간 합집합으로 합칠 것(단순 합 금지). ' +
        '보이는 조각이 없으면 []. tick.dpr = devicePixelRatio.',
        'visTop/visBot = 그 틱에 뷰포트에 보이던 유닛 order 범위(양끝 포함). ' +
        '체류시간(뷰포트 노출 누적)은 이걸로 오프라인 계산.',
        'centerPid = 뷰포트 49% 중앙선 유닛. GVAM 캐비엣: 중앙선=focus 가정은 ' +
        'dwell에서만 검증됨. scroll_speed/scrlfreq/entry_scrlspeed는 미검증 가정 위.',
        'cursorPid=null 은 커서가 여백/이미지/sticky 위 (A채널 결측).',
        '탭이 숨겨졌거나 창이 포커스를 잃은 동안의 틱은 기록하지 않음. ' +
        'focusMs = 기록된 틱 수 × tickMs.',
        'highlight/copy 의 ranges = [[pid, lo, hi], …] 선택이 걸친 유닛마다 그 유닛 text 안 범위' +
        '(pieces 와 같은 좌표, 유닛 order 순). text = 선택 문자열(trim).',
        'tick.scrollY / docH = 본문 스크롤 주체의 scrollTop / scrollHeight (주체가 window 면 window.scrollY / ' +
        '문서 높이). 주체는 scroller 이벤트(path = window | [tag,id,class,role])로 바뀔 때만 남는다.',
        'tick.scrollEvents = 본문을 움직인 스크롤 이벤트 수(대상이 document 이거나 본문 루트를 품은 요소), ' +
        'scrollOther = 나머지 스크롤 이벤트 수.',
        'tick.mdx / mdy = 직전 틱 이후 mousemove 이동량 Σ|dx| · Σ|dy| (px). ' +
        'tick.edits = 직전 틱 이후 input 이벤트 수(내용 안 남김, 한글 IME 로 부풀므로 0 이냐 아니냐로만).',
        '차분값(스크롤 속도 · 커서 이동 거리)은 로그에 없다. 아래 리셋 규칙으로 백엔드가 계산.',
        'type=rescan mode=splice = 기록 중 본문 중간이 바뀌어 바뀐 구간만 다시 청킹함 { kept, added, retired, diff }. ' +
        '사라진 유닛은 paragraphs 에 retired:true 로 남는다(order 는 살아 있는 유닛 뒤). ' +
        'diff = 처음 달라진 원문 위치(at) · 그 유닛 order · 직전 40자(ctx) · 옛/새 40자. ' +
        'mode=disruptive-skipped 는 옛 확장(splice 이전)의 기록 — 본문 교체로 학습 제외.',
        '기사 제목은 유닛에 포함되지 않는다(본문 루트 밖). 제목 텍스트는 meta.title.',
        '한 페이지 = 같은 글(pageId)의 모든 구간(segId)을 합친 것. 탭 전환은 ' +
        '구간을 바꾸지 않는다(visibility/focus 이벤트 + 틱 공백으로 남음).',
        '연속 틱 간 차분은 segId 가 바뀌거나 두 틱의 t 간격이 2×tickMs 를 넘으면 리셋.',
        'tabId 는 background 가 붙인다(sender.tab.id).',
        'type=label (v:2) = 참가자 자기보고 { trigger, cancelled, startT, ms, phaseMs, ratings(pid→skip|skim|read|focus|unsure), ' +
        'ratingLog([pid,값,ms]), excluded(숨은 유닛), marks(중요 유닛 pid, order 순), survey{gain,interest,familiarity} }. ' +
        'type=labelask = 끝 도달 질문 응답 { answer: yes|no|cancel, startT(카드가 뜬 때), ms } — 카드가 떠 있는 동안도 틱은 기록된다. ' +
        'label 의 startT..t(라벨 모드) 동안은 틱을 기록하지 않는다. label 이 여러 번 있으면 마지막 것(취소 아닌)이 정답.',
      ],
    };
  }

  // ==========================================================================
  // 구간 제어
  // ==========================================================================
  // 구간 열기 요청. 바로 열지 않고 본문이 조용해질 때까지 기다린다 (헤더 "본문 준비 중 대기").
  //   이미 기록 중이거나 대기 중이면 무시 — 11-session 이 스캔 · 탭 복귀마다 여러 번 부른다.
  function start(m) {
    if (recording || settle) return;
    settle = { m, at: null, waited: 0, quiet: 0, raw: null, changes: 0, timer: null, asked: 0, found: 0 };
    settleStep();
  }

  function settleStep() {
    const s = settle;
    if (!s) return;
    const now = performance.now();
    if (document.hidden) {                             // 안 보는 탭: 시계 멈춤, 조용함도 다시 잰다
      s.at = null; s.quiet = 0;
      s.timer = setTimeout(settleStep, CFG.SETTLE_POLL_MS);
      return;
    }
    const dt = s.at == null ? 0 : now - s.at;
    s.at = now;
    s.waited += dt;
    RBC.units.rescan({});                              // recording 꺼짐 → 전체 재청킹 (최신 렌더)
    const raw = RBC.stream.raw();
    if (raw !== s.raw || !RBC.units.count()) {
      if (s.raw !== null && raw !== s.raw) s.changes++;
      s.raw = raw; s.quiet = 0;
    } else {
      s.quiet += dt;
    }
    const empty = !RBC.units.count();
    if (empty && s.waited - s.asked >= CFG.SETTLE_ASK_MS) {   // 본문을 못 찾음 → primary 다시 뽑기 요청
      s.asked = s.waited;
      bus.emit('settle:empty');
    }
    if (empty) s.found = 0; else s.found += dt;              // 최대 대기는 본문을 찾은 뒤부터 잰다
    const how = empty ? null
      : s.quiet >= CFG.SETTLE_QUIET_MS ? 'quiet' : s.found >= CFG.SETTLE_MAX_MS ? 'max' : null;
    if (how) {
      settle = null;
      begin(s.m, { ms: Math.round(s.waited), how, changes: s.changes });
      return;
    }
    emitStat();
    s.timer = setTimeout(settleStep, empty && s.waited >= CFG.SETTLE_MAX_MS ? CFG.SETTLE_EMPTY_POLL_MS : CFG.SETTLE_POLL_MS);
  }

  function cancelSettle() {
    if (!settle) return false;
    clearTimeout(settle.timer);
    settle = null;
    emitStat();
    return true;
  }

  function begin(m, settled) {
    if (recording) return;
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
    pageSent = false;
    chunkN = 0;
    RBC.input.drain();                                  // v3: 기록 전 쌓인 카운터는 버린다
    lastScrollerEl = undefined;
    RBC.input.seedScroller();                           // 첫 스크롤 전 주체

    RBC.input.bump();                                   // idle 타이머 초기화
    recording = true;
    noteScroller(RBC.input.scroller());                 // 구간 시작 때 첫 값
    if (settled) push({ type: 'settle', t: tNow(), segId, ms: settled.ms, how: settled.how, changes: settled.changes });
    ensureTicking();
    // seg:page 는 여기서 보내지 않는다 — 첫 틱에서 보낸다
    flushTimer = setInterval(flush, CFG.FLUSH_MS);
    bus.emit('record:started', { sessionId, segId });
    emitStat();
  }

  // 구간을 닫는다. 세션을 닫는 게 아니다 — 세션 종료는 background 가 정한다.
  // reason: 'user'(세션 정지 방송) | 'idle' | 'demoted' | 'navigation'(11-session)
  function stop(reason) {
    if (!recording && cancelSettle()) return;         // 대기 중이었음: 구간을 연 적이 없다
    if (recording) {
      const e = { type: 'segend', t: tNow(), segId, reason: reason || 'user' };
      if (sameN) { e.same = [sameN, sameMs, sameMax]; sameN = 0; sameMs = 0; sameMax = 0; }
      push(e);
    }
    if (pageSent) flush();                             // 마지막 조각까지 넘기고 닫는다
    else timeline = [];                                // 한 번도 안 본 구간: 흔적 없이 버린다
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
      settling: settle ? { ms: Math.round(settle.waited), changes: settle.changes } : null,   // 본문 준비 중 (패널 · 팝업)
      units: RBC.units.count(), samples: segEvents,
      centerPid: lastCenterPid, cursorPid: lastCursorPid,
      scrollSpeed: Math.round(lastScrollSpeed),
      centerText: u ? (u.order + ' · ' + u.text.slice(0, 26)) : '',
      query: searchQuery || '',
      sampleMs: RBC.hittest.stats(), visN: lastVisN,   // 패널: sample() p95 · 이번 틱 vis 조각 수
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
    if (!isPrimary) cancelSettle();
  });

  // ==========================================================================
  // 구독 — 기록할 사실들
  //   4-input 은 "무슨 일이 있었다"만 알린다. 기록 여부 판단은 전부 여기.
  // ==========================================================================
  bus.on('sel:highlight', (d) => {
    if (!recording || labeling) return;
    push({ type: 'highlight', t: tNow(), segId, ranges: d.ranges, text: d.text });
  });

  bus.on('sel:copy', (d) => {
    if (!recording || labeling) return;
    push({ type: 'copy', t: tNow(), segId, ranges: d.ranges, text: d.text });
  });

  // 라벨 모드 (12-label). 끝나면 공백 동안 쌓인 입력을 버리고 무동작 타이머를 새로 잰다.
  bus.on('label:mode', (d) => {
    const on = !!(d && d.on);
    if (on === labeling) return;
    labeling = on;
    if (on) {
      labelStartT = recording ? tNow() : 0;
    } else {
      RBC.input.drain();
      RBC.input.bump();
      prevTickTime = null;
    }
  });

  bus.on('label:ask', (d) => {
    if (!recording) return;
    const t = tNow();
    const ms = Math.max(0, Math.round((d && d.shownMs) || 0));
    push({ type: 'labelask', t, segId, answer: (d && d.answer) || 'cancel', startT: t - ms, ms });
  });

  bus.on('label:done', (d) => {
    if (!recording) return;
    const t = tNow();
    const x = d || {};
    push({ type: 'label', v: 2, t, segId, trigger: x.trigger || null, cancelled: !!x.cancelled,
      startT: labelStartT, ms: t - labelStartT, phaseMs: x.phaseMs || null,
      ratings: x.ratings || {}, ratingLog: x.ratingLog || [], excluded: x.excluded || [],
      marks: x.marks || [], survey: x.survey || {} });
    flush();
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
  // 글이 안 바뀐 재스캔(mode 'same')은 횟수 · 시간만 모아 두고 다음 기록 이벤트에 얹는다 —
  //   호버 UI 처럼 잦은 DOM 변경마다 이벤트 · page 기록을 쌓지 않으려고 (0-B 성능).
  let sameN = 0, sameMs = 0, sameMax = 0;
  bus.on('units:rescanned', (d) => {
    if (!recording) return;
    if (d.mode === 'same') {
      sameN++; sameMs += d.ms || 0; sameMax = Math.max(sameMax, d.ms || 0);
      return;
    }
    const e = { type: 'rescan', t: tNow(), segId, mode: d.mode, units: d.count, ms: d.ms };
    if (sameN) { e.same = [sameN, sameMs, sameMax]; sameN = 0; sameMs = 0; sameMax = 0; }
    if (d.diff) e.diff = d.diff;                      // splice 진단: 어디가 바뀌었나
    if (d.root) e.root = d.root;                      // 이 시점 본문 루트 (패널 · [6] 표시)
    if (d.mode === 'splice') {
      e.kept = d.kept; e.added = d.added; e.retired = d.retired; e.check = d.check;
      if (d.inline) e.inline = true;                 // 문단 안쪽 변경 → 유닛 제자리 수정
      if (d.rootChanged) { e.rootChanged = true; e.rootFrom = d.rootFrom; e.rootTo = d.root; }
    }
    push(e);
    if (d.mode !== 'disruptive-skipped' && pageSent) emitPage();   // 첫 틱 전이면 첫 틱 때 최신 목록이 나간다
  });

  // 유닛이 바뀌면 패널 숫자도 바뀐다.
  bus.on('units:changed', () => emitStat());

  // ==========================================================================
  // 공개
  // ==========================================================================
  RBC.recorder = {
    isRecording: () => recording,
    isSettling: () => !!settle,                // 본문 준비 중 대기 (구간은 아직 안 열림)
    query: () => searchQuery,                  // 9-panel 의 검색어 입력 초기값
    segment: () => ({ sessionId, segId, pageId: segPageId }),
    start,
    stop,
  };
})();