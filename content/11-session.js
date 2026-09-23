/* =============================================================================
 * 11-session.js — background 연결 · 세션 합류 · SPA 경계
 *
 * 소유: session(background 세션 상태의 읽기 전용 사본, 최상위만), lastKey
 * 의존(직접 호출): 0-core, 6-frames
 * 발행: session:changed, export:ready
 * 구독: seg:page, seg:chunk, record:stopped, scan:done,
 *       ui:rec, ui:export, ui:query
 *
 * --- 이 레이어가 하는 일 ----------------------------------------------------
 *   content script 와 background 사이의 유일한 통로다. chrome.runtime 은
 *   이 파일에서만 쓴다. 5-recorder 는 seg:* 사실만 발행하고, 여기서 background
 *   로 실어 나른다. background 의 명령(start/stop)은 여기서 받아 6-frames 로
 *   primary 에게 보낸다.
 *
 * --- 세션 권한은 background 에만 있다 ----------------------------------------
 *   여기는 세션을 만들지 않는다. 버튼(ui:rec)도 background 에 요청만 하고,
 *   실제 시작/정지는 background 의 방송을 받아서 한다. 나중에 웹앱이 세 번째
 *   명령 출처로 붙어도 "누가 진짜 세션인가"가 어긋나지 않게 하려는 규칙이다.
 *
 * --- 합류 ---------------------------------------------------------------------
 *   스캔이 끝나면(scan:done) background 에 "지금 세션 중이냐"(hello)를 묻고,
 *   세션 중이면 primary 에게 start 를 보낸다. 이 한 경로로
 *     - 세션 도중 새로 연 탭
 *     - 새로고침 / content script 재주입
 *     - SPA 이동 뒤 새 글
 *     - primary 교체 뒤 새 primary
 *   가 전부 처리된다. 5-recorder.start() 는 이미 기록 중이면 무시하므로
 *   스캔이 여러 번 끝나도 구간이 중복으로 열리지 않는다.
 *
 * --- SPA 경계 (B 에서 가져옴 — 반응만 바꿨다) ---------------------------------
 *   감지: location 폴링. content script 는 격리 월드라 history.pushState 를
 *         패치해도 페이지의 호출을 못 잡는다. popstate/hashchange 는 pushState 를
 *         못 잡으므로 "지금 확인해봐라" 신호로만 쓴다.
 *   판정: RBC.util.pageKey — 해시·추적 파라미터 제외.
 *   반응: B 는 세션을 끊었다. 여기서는 지금 글의 구간만 닫고(stop 'navigation')
 *         다시 스캔한다. 스캔이 끝나면 위 합류 경로로 새 글의 구간이 열린다.
 *         세션은 그대로다.
 *   주관: 최상위 프레임만. iframe 은 src 가 바뀌면 진짜 로드라 스크립트가 새로 뜬다.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus, IS_TOP } = RBC;
  const { pageKey } = RBC.util;

  // background 로 보낸다. 확장이 새로고침돼서 이 content script 가 고아가 되면
  // chrome.runtime 이 예외를 던진다 — 그때는 조용히 포기한다(페이지 새로고침 필요).
  function toBg(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch((e) => {
        console.warn('[RBC] background 전송 실패', msg.rbc, e && e.message);
        return null;
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // ==========================================================================
  // 모든 프레임: 기록 조각을 background 로
  //   seg:* 는 기록 중인 프레임(primary)에서만 발행된다. iframe 이어도
  //   chrome.runtime 은 직접 쓸 수 있으므로 최상위를 거치지 않는다.
  //   tabId 는 싣지 않는다 — background 가 sender.tab.id 로 붙인다.
  // ==========================================================================
  bus.on('seg:page', (d) => toBg(Object.assign({ rbc: 'page' }, d)));
  bus.on('seg:chunk', (d) => toBg(Object.assign({ rbc: 'flush' }, d)));

  // 30분 무동작은 세션 종료다. 기록하던 프레임이 직접 background 에 알린다.
  // (user 는 background 방송으로 멈춘 것, navigation/demoted 는 구간만 닫은 것)
  bus.on('record:stopped', (d) => {
    if (d && d.reason === 'idle') toBg({ rbc: 'stop', reason: 'idle' });
  });

  if (!IS_TOP) return;          // 이하 전부 최상위 전용

  // ==========================================================================
  // 세션 사본 (읽기 전용 — background 의 방송과 hello 응답으로만 갱신)
  // ==========================================================================
  let session = { recording: false, sessionId: null, epoch: 0, query: null };

  function applySession(m) {
    if (!m || (m.rbc !== 'start' && m.rbc !== 'stop')) return;
    session = {
      recording: m.rbc === 'start',
      sessionId: m.sessionId, epoch: m.epoch, query: m.query || null,
    };
    bus.emit('session:changed', Object.assign({}, session));
  }

  function joinIfRecording() {
    if (!session.recording) return;
    RBC.frames.send('start', {
      sessionId: session.sessionId, epoch: session.epoch, query: session.query,
    });
  }

  // background → 이 탭 (최상위 프레임에만 온다: frameId 0)
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || !m.rbc) return false;
    if (m.rbc === 'start') { applySession(m); joinIfRecording(); }
    else if (m.rbc === 'stop') { applySession(m); RBC.frames.send('stop', { reason: 'user' }); }
    return false;
  });

  // 합류: 스캔이 끝날 때마다 묻는다.
  bus.on('scan:done', () => {
    toBg({ rbc: 'hello' }).then((m) => { applySession(m); joinIfRecording(); });
  });

  // ==========================================================================
  // 버튼 → background (9-panel 이 발행)
  // ==========================================================================
  bus.on('ui:rec', () => {
    const want = session.recording ? { rbc: 'stop', reason: 'user' }
      : { rbc: 'start', query: RBC.recorder.query() };
    // 응답이 와도 여기서 직접 시작하지 않는다. 방송이 이 탭에도 온다.
    toBg(want).then(applySession);
  });

  bus.on('ui:query', (d) => toBg({ rbc: 'query', q: (d && d.q) || null }));

  bus.on('ui:export', () => {
    toBg({ rbc: 'export' }).then((bundle) => {
      if (bundle && bundle.kind === 'rbc-session') bus.emit('export:ready', bundle);
      else console.warn('[RBC] export 실패', bundle);
    });
  });

  // ==========================================================================
  // SPA 경계
  // ==========================================================================
  let lastKey = pageKey(location.href);

  function checkUrl() {
    const key = pageKey(location.href);
    if (key === lastKey) return;
    lastKey = key;

    // 지금 글의 구간만 닫는다. primary 가 iframe 이어도 6-frames 가 전달한다.
    if (session.recording) RBC.frames.send('stop', { reason: 'navigation' });

    // 새 글의 본문이 붙기를 기다렸다가 다시 스캔 → scan:done → 합류.
    setTimeout(() => RBC.frames.doScan(), CFG.FIRST_SCAN_DELAY);
  }

  setInterval(checkUrl, CFG.URL_POLL_MS);
  window.addEventListener('popstate', () => setTimeout(checkUrl, 0));
  window.addEventListener('hashchange', () => setTimeout(checkUrl, 0));

  RBC.session = {
    state: () => Object.assign({}, session),
  };
})();