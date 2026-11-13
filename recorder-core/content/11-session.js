/* =============================================================================
 * 11-session.js — background 연결 · 세션 합류 · SPA 경계
 *
 * 소유: session(background 세션 상태의 읽기 전용 사본, 최상위만), lastKey
 * 의존(직접 호출): 0-core, 2-units(무한 스크롤 의심의 앞 글 표본, #78), 6-frames
 * 발행: session:changed, session:link, export:ready, ui:panel, overlay:pref, idle:clock, skip:page(#49), popup:perf(#66), nav:hint(#78)
 * 구독: seg:page, seg:flush, label:mode, scan:done, label:done, activity,
 *       ui:rec, ui:export, ui:query, ui:idletest, ui:overlay, stat
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
 *
 * --- 조용히 실패하지 않는다 --------------------------------------------------
 *   background 에 못 닿으면 session:link { ok:false, why } 를 발행하고 패널이
 *   그걸 보여준다. 가장 흔한 원인은 "확장을 새로고침했는데 탭은 그대로" —
 *   이 content script 는 고아가 되어 방송도 못 받고 보내지도 못한다.
 *   고칠 방법은 페이지 새로고침뿐이라 그 문장을 그대로 띄운다.
 *
 * --- 탭이 다시 보일 때마다 재확인 --------------------------------------------
 *   방송은 한 번만 온다. 탭이 얼어 있었거나(절전) 메시지를 놓치면 이 탭은
 *   세션과 어긋난 채로 남는다. 그래서 탭이 보이게 될 때마다 hello 로 다시
 *   물어서 놓친 시작/정지를 따라잡는다. start 는 이미 기록 중이면 무시되므로
 *   여러 번 불러도 구간이 중복으로 열리지 않는다.
 *
 * --- 기록 안 할 주소 (#49) ----------------------------------------------------
 *   규칙은 background 가 hello · 방송(sessionMsg.skip)으로 준다. 합류 직전 · SPA 이동 직후에 이 탭 주소를 맞춰 보고
 *   (0-core skipMatch) 걸리면 start 를 안 보낸다 — 읽기 · 스크롤은 그대로, 기록만 안 함. 규칙이 늦게 와 대기 · 기록 중이면
 *   그만두고, 기록 중이던 구간은 segend.reason 'excluded' 로 닫는다(11-06 서현). 걸림 · 풀림이 바뀔 때만 background 에 skip 으로
 *   알린다(툴바 아이콘을 그 탭만 회색으로). 알림은 화면 아래 가운데에 4.5초(팝업 스타일, 숨은 탭이면 보일 때) —
 *     그 사이트 페이지를 열 때 · 다른 사이트에서 넘어올 때 · 다른 탭에서 이 탭으로 돌아올 때마다(까먹지 않게, 11-06 서현).
 *     단 규칙 문구에 quiet 가 있으면(검색 결과 화면, #80 — 하루 수십 번이라 방해) 알림 없이 아이콘 · 팝업 · 패널로만.
 *     아래 가운데 = 구글 스낵바 자리. 툴바 팝업(오른쪽 위)에 가리지 않고 디버그 패널(오른쪽 아래)과도 안 겹친다.
 *   무한 스크롤은 스크롤마다 주소가 바뀌어 SPA 경계 → 재스캔 → 합류를 다시 타지만, 규칙이 그대로면 다시 안 띄운다.
 *   판정은 최상위 주소로만(본문이 iframe 이어도 사이트는 최상위 주소). 패널에는 skip:page 로 알린다.
 *
 * --- 무한 스크롤 의심 (#78) ---------------------------------------------------
 *   무한 스크롤 사이트(zdnet: 스크롤하면 다음 글을 이어 붙이고 주소를 바꿈)를 서현이 찾게 돕는 표시. **막지 않는다**
 *   (11-06 서현 "자동 감지로 막지 않음, 목록으로만" — 막는 건 bg-core NO_RECORD_SITES). 기록 데이터에 아무것도 안 남긴다.
 *   SPA 경계에서 주소가 바뀔 때(기록 여부와 상관없이):
 *     의심      = 직전 3초 안에 손짓(누름 · 클릭 · Enter · 뒤로/앞으로) 없음 + 직전 1.5초 안에 스크롤 있음
 *     강한 의심 = 의심 + 앞 글이 문서에 그대로 남음 — FIRST_SCAN_DELAY 뒤(다시 스캔 전), 앞 글 본문다운 유닛 표본 3개의
 *                 글 40자(공백 뺌) 중 과반이 body 글자(공백 뺌)에 있음. 본문이 iframe 이면 최상위에 유닛이 없어 "모름"(null).
 *   결과는 nav:hint { n, strong, last:{ from, to, left, t } } 로 패널에. 횟수는 이 문서가 뜬 동안 누적.
 *   한계(예상): 스크롤 중 ?page=2 만 바꾸는 목록도 의심(찾고 싶은 쪽) · 주소를 안 바꾸고 글만 붙이면 못 잡음 ·
 *     본문 iframe 안 스크롤은 최상위가 못 봄 · 3초 · 1.5초는 근거 없는 임시값 ·
 *     0.6초보다 늦게 화면을 갈아끼우는 SPA 는 앞 글이 아직 있어 "남음"이 될 수 있음(손짓 없이 바뀔 때만 해당) ·
 *     누른 뒤 3초 안에 스크롤로 바뀐 주소는 놓침(요소 스크롤 막대를 끌 때 포함).
 *
 * --- 무동작 시계 (#26) -------------------------------------------------------
 *   시계는 background 가 갖는다(bg-core 헤더). 여기서는 4-input 의 activity 를 background 로
 *   실어 나르고(모든 프레임 · 기록 안 하는 탭도),
 *   background 가 알려 준 시계 값을 idle:clock 으로 패널에 넘긴다.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus, IS_TOP } = RBC;
  const { pageKey } = RBC.util;

  // background 로 보낸다. 실패는 전부 session:link 로 알린다(패널이 표시).
  //   고아: 확장을 새로고침하면 이미 떠 있던 content script 는 chrome.runtime.id 가
  //         사라지고 sendMessage 가 예외를 던진다. 회복 불가 — 페이지 새로고침 필요.
  let linkOk = true;
  function link(ok, why) {
    if (ok === linkOk && ok) return;
    linkOk = ok;
    bus.emit('session:link', { ok, why: why || null });
  }

  // why 는 패널에 그대로 찍힌다 — 콘솔 없이 원인을 보기 위해서다.
  //   고아로 확정하는 건 두 경우뿐: runtime.id 가 없거나, 에러 문구가 invalidated.
  //   그 외 예외를 고아로 뭉뚱그리면 새로고침해도 안 풀리는 문제를 "새로고침하라"로
  //   잘못 안내하게 된다(velog 에서 실제로 그랬다).
  function fail(msg, e, stage) {
    const m = (e && e.message) || String(e);
    console.warn('[RBC] background 전송 실패', msg.rbc, stage, m);
    link(false, /invalidated/i.test(m) ? 'orphan:invalidated' : `${msg.rbc}/${stage}: ${m}`);
    return null;
  }

  function toBg(msg) {
    if (!chrome.runtime || !chrome.runtime.id) {
      link(false, 'orphan:no-id');
      return Promise.resolve(null);
    }
    let p;
    try {
      p = chrome.runtime.sendMessage(msg);
    } catch (e) {
      return Promise.resolve(fail(msg, e, 'throw'));
    }
    return Promise.resolve(p).then((r) => {
      if (r == null) { link(false, `${msg.rbc}/no-reply`); return null; }
      if (r.ok === false) { link(false, `${msg.rbc}/bg: ${r.why}`); return r; }
      link(true);
      return r;
    }, (e) => fail(msg, e, 'reject'));
  }

  // ==========================================================================
  // 모든 프레임: 기록 조각을 background 로
  //   seg:* 는 기록 중인 프레임(primary)에서만 발행된다. iframe 이어도
  //   chrome.runtime 은 직접 쓸 수 있으므로 최상위를 거치지 않는다.
  //   tabId 는 싣지 않는다 — background 가 sender.tab.id 로 붙인다.
  // ==========================================================================
  bus.on('seg:page', (d) => toBg(Object.assign({ rbc: 'page' }, d)));
  bus.on('seg:flush', (d) => toBg(Object.assign({ rbc: 'flush' }, d)));

  // 입력 = 움직임 → background 의 무동작 시계 (#26). 간격은 4-input 이 둔다(CFG.ACTIVITY_PING_MS).
  bus.on('activity', () => toBg({ rbc: 'activity' }));

  // 라벨 모드(테스트 버전 평가) 동안은 자동 정지하면 안 된다 — 평가 중 움직임을 계속 알린다 (#26).
  let labelKeep = null;
  bus.on('label:mode', (d) => {
    clearInterval(labelKeep); labelKeep = null;
    if (d && d.on) labelKeep = setInterval(() => toBg({ rbc: 'activity' }), CFG.ACTIVITY_PING_MS);
  });

  // 테스트 모드: 라벨 [완료] = 이 글을 다 읽음 → 세션을 끝낸다 (한 글 = 한 기록).
  //   라벨을 고른 프레임(primary, iframe 일 수도 있음)이 직접 알린다. 5-recorder 가 같은 label:done 에서
  //   label 이벤트를 먼저 넘기므로(파일 순서상 먼저 구독) 정지 요청보다 라벨 조각이 먼저 도착한다.
  //   취소는 정지하지 않는다 — 계속 읽는다.
  //   answer(정답 'O' / 오답 'X', #24)는 정지 요청에만 싣는다 — 데이터 수집 버전이 파일 이름에 쓴다. 기록 JSON 에는 없다.
  bus.on('label:done', (d) => {
    if (d && !d.cancelled) toBg({ rbc: 'stop', reason: 'labeled', answer: d.answer || null });
  });

  if (!IS_TOP) return;          // 이하 전부 최상위 전용

  // ==========================================================================
  // 세션 사본 (읽기 전용 — background 의 방송과 hello 응답으로만 갱신)
  // ==========================================================================
  //   mode = 확장 버전('download' 데이터 수집 · 'server' 실사용, #19). 패널이 머리에 표시한다.
  let session = { recording: false, sessionId: null, epoch: 0, query: null, mode: null, skip: [] };

  function applySession(m) {
    if (!m || (m.rbc !== 'start' && m.rbc !== 'stop')) return;
    session = {
      recording: m.rbc === 'start',
      sessionId: m.sessionId, epoch: m.epoch, query: m.query || null, mode: m.mode || null,
      skip: Array.isArray(m.skip) ? m.skip : [], skipInfo: m.skipInfo || null,
    };
    bus.emit('session:changed', Object.assign({}, session));
    if (m.idle) bus.emit('idle:clock', m.idle);
    if (!session.recording) toastWant = null;             // 보이기 전에 정지됐으면 알림도 안 띄운다 (#49)
    if (!session.recording && skipSent !== undefined) {   // 정지 = background 가 배지를 전부 뗐다 (#49)
      skipSent = undefined;
      bus.emit('skip:page', null);
    }
  }

  // --- 기록 안 할 주소 (#49, 헤더) ---
  //   skipSent = background 에 마지막으로 알린 규칙 url | null(안 걸림) | undefined(이 문서에서 아직 안 알림).
  //   새로 뜬 문서는 처음 한 번 null 도 보낸다 — 걸린 사이트에서 다른 사이트로 넘어간 탭의 회색 아이콘을 되돌리려고.
  //   skipSid = 그 알림이 어느 세션 것인지. 정지 방송을 놓친 탭(얼었던 탭 · bfcache)이 새 세션에서 옛 값 때문에
  //   안 알리면 새 세션의 아이콘 · 알림이 안 뜬다 → 세션이 바뀌면 처음부터 다시 알린다.
  let skipSent, skipSid = null;
  //   moved = SPA 이동 직후 (방금 'navigation' 으로 닫았으니 여기서 또 닫지 않는다)
  function skipCheck(moved) {
    if (skipSid !== session.sessionId) { skipSid = session.sessionId; skipSent = undefined; }
    const r = RBC.util.skipMatch(location.href, session.skip);
    const rule = r ? r.url : null;
    // 대기 중 · 기록 중에 걸림 = 규칙이 나중에 왔다(수집 제외 목록을 세션 시작 뒤 · 웹에서 바꾼 뒤 받음) → 그만둔다.
    //   기록 중이던 구간은 segend.reason 'excluded' 로 닫는다(11-06 서현: 늦게 제외돼도 기록은 멈춘다). 대기 중이면 구간이 없어 아무것도 안 남는다.
    //   닫기 전에 이미 기록된 부분(보통 몇 초)은 남는다.
    let closed = false;
    if (r && !moved) {
      const ps = primaryState();
      if (ps.settling || ps.recording) RBC.frames.send('stop', { reason: 'excluded' });
      closed = !!ps.recording;
    }
    if (rule !== skipSent) {
      skipSent = rule;
      if (!r) skipToastOff();                                // 풀림 (제외를 끔 등) → 떠 있거나 기다리던 알림도 거둔다
      bus.emit('skip:page', r ? Object.assign({ closed }, r) : null);   // closed = 기록 중이던 구간을 닫음 (패널)
      toBg({ rbc: 'skip', rule, why: r ? r.why : null });
      if (r) skipToast(r);                                   // 걸리기 시작함 = 이 페이지를 엶 · 다른 사이트에서 넘어옴
    }
    return !!r;
  }

  // 다른 탭에서 돌아옴 → 걸린 탭이면 다시 알린다 (visibilitychange). 새 규칙을 받은 뒤에 본다(resync 뒤) —
  //   웹에서 제외를 끄고 돌아왔는데 옛 규칙으로 "기록하지 않아요"가 뜨지 않게. 그 뒤 목록이 바뀌어 풀리면 skipCheck 가 거둔다.
  function skipAgain() {
    if (!session.recording || !skipSent) return;
    const r = RBC.util.skipMatch(location.href, session.skip);
    if (r) skipToast(r);
  }

  let toastEl = null, toastWant = null;
  function skipToastOff() {
    toastWant = null;
    if (toastEl) { toastEl.remove(); toastEl = null; }
  }
  function skipToast(r) {
    if (r.quiet) { skipToastOff(); return; }                 // 검색 결과 화면 등 — 알림 없이 아이콘 · 팝업으로만 (#80, bg-core SKIP_TEXT).
                                                             //   앞 규칙의 알림 · 기다리던 알림도 거둔다(검토)
    if (document.hidden) { toastWant = r; return; }          // 보일 때 (visibilitychange)
    toastWant = null;
    if (toastEl) toastEl.remove();
    const host = document.createElement('div');
    host.id = 'rbc-skip-toast';
    host.style.cssText = 'all:initial;position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647';
    const sh = host.attachShadow({ mode: 'open' });          // 페이지 CSS 가 안 섞이게
    sh.innerHTML = `<style>
      .card{display:flex;align-items:center;gap:10px;padding:12px 16px;max-width:340px;
        background:#fff;color:#1e211f;border:1px solid #e4e7e2;border-radius:10px;
        box-shadow:0 6px 20px rgba(30,33,31,.14);cursor:pointer;
        font-family:"Pretendard",-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;
        font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased;
        opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}
      .card.on{opacity:1;transform:none}
      .t{font-weight:400;color:#6a706b}
      .b{display:inline-block;margin-top:4px;padding:2px 8px;border-radius:6px;font-size:12.5px;font-weight:700;
        color:#c0392b;background:#fdf3f2;border:1px solid #f0cdc8}
    </style><div class="card" role="status" title="눌러서 닫기">
      <svg width="28" height="28" viewBox="0 0 44 44" aria-hidden="true">
        <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#78c957"/><stop offset="1" stop-color="#4caf3f"/></linearGradient></defs>
        <rect width="44" height="44" rx="12" fill="url(#g)"/>
        <path d="M22 33V21" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M22 22c0-5 3.4-8.4 8.6-8.4 0 5.2-3.6 8.4-8.6 8.4Z" fill="#fff"/>
        <path d="M22 24.5c-4.2 0-7.2-2.8-7.2-7 4.4 0 7.2 2.9 7.2 7Z" fill="#fff" opacity=".85"/>
      </svg>
      <div><div class="t"></div><span class="b"></span></div></div>`;
    sh.querySelector('.t').textContent = r.head || '이 사이트는 기록할 수 없어요';
    sh.querySelector('.b').textContent = r.label || r.why;
    const card = sh.querySelector('.card');
    const close = () => {
      card.classList.remove('on');
      setTimeout(() => { host.remove(); if (toastEl === host) toastEl = null; }, 300);
    };
    card.onclick = close;
    document.documentElement.appendChild(host);
    toastEl = host;
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('on')));
    setTimeout(close, CFG.SKIP_TOAST_MS);
  }

  function joinIfRecording() {
    if (!session.recording) return;
    if (skipCheck()) return;
    RBC.frames.send('start', {
      sessionId: session.sessionId, epoch: session.epoch, query: session.query,
    });
  }

  // primary 의 마지막 stat (최상위 전용). primary 가 iframe(블로그 PC)이면 기록 · 대기 상태가 그 프레임에 있어서
  //   이 프레임의 recorder 로는 알 수 없다. 6-frames 가 iframe 의 stat 을 이 버스로 중계해 준다.
  let pStat = null;
  bus.on('stat', (st) => {
    const p = RBC.frames.primaryTag();
    if (st && st.tag === (p || RBC.TAG)) pStat = st;
  });
  function primaryState() {
    const own = RBC.frames.primaryTag() == null || RBC.frames.primaryTag() === RBC.TAG;
    if (own || !pStat) {
      return { recording: RBC.recorder.isRecording(), settling: RBC.recorder.isSettling(), units: RBC.units.count() };
    }
    return { recording: !!pStat.recording, settling: !!pStat.settling, units: pStat.units };
  }

  // background → 이 탭 (최상위 프레임에만 온다: frameId 0)
  //   label: 팝업 "다 읽었어요". primary 에서 12-label 이 켜진다. 받았다는 답만 바로 한다 —
  //          답이 없으면 background 의 sendMessage 가 실패로 끝날 수 있다.
  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (!m || !m.rbc) return false;
    if (m.rbc === 'start') { applySession(m); joinIfRecording(); }
    else if (m.rbc === 'stop') {
      applySession(m);
      // idle = background 무동작 자동 정지(#26) → 5-recorder 가 autostop 이벤트를 남긴다
      RBC.frames.send('stop', { reason: m.reason === 'idle' ? 'idle' : 'user' });
    }
    else if (m.rbc === 'label') { RBC.frames.send('label'); reply({ ok: true }); }
    else if (m.rbc === 'ping') {                       // 팝업의 연결 확인 (참가자용, 0-B)
      //   settling = 본문 준비 중 대기. 팝업은 기록 시작 뒤 이게 풀리고 recording 이 될 때까지 기다렸다 닫힌다.
      const ri = RBC.stream.rootInfo() || {};
      const ps = primaryState();
      // 본문을 아직 못 찾았고 기록 · 대기 전이면 primary 를 다시 뽑는다. 블로그 PC 처럼 본문 iframe 이 스캔 재시도(약 9초)보다
      //   늦게 뜨면 그 뒤로는 아무도 다시 찾지 않아, 팝업의 "잠시 뒤 다시 열어 보세요"가 거짓말이 됐다(2026-10-09 3G 실측).
      //   이번 답은 옛 값(0개) — 다시 열면 새 값이 보인다. 기록을 시작하면 5-recorder 대기가 같은 일을 한다(settle:empty).
      if (!ps.units && !ps.recording && !ps.settling) RBC.frames.doScan();
      //   skip = 이 탭은 기록 안 하는 사이트 (#49) — 팝업이 본문 준비를 기다리지 않고 바로 닫힌다
      reply({ ok: true, units: ps.units, root: ri.sel || null, how: ri.how || null,
        recording: ps.recording, settling: ps.settling, skip: session.recording && skipSent ? skipSent : null });
    }
    return false;
  });

  // 합류: 스캔이 끝날 때마다, 그리고 탭이 다시 보일 때마다 묻는다.
  //   세션이 멈춰 있는데 이 탭이 아직 기록 중이면(정지 방송을 놓친 경우) 닫는다.
  function resync() {
    return toBg({ rbc: 'hello' }).then((m) => {
      if (!m) return;
      const wasRecording = session.recording;
      applySession(m);
      if (session.recording) joinIfRecording();
      else if (wasRecording || RBC.recorder.isRecording() || RBC.recorder.isSettling()) {
        RBC.frames.send('stop', { reason: 'user' });       // 대기 중인 탭도 (정지 방송을 놓친 경우)
      }
    });
  }

  bus.on('scan:done', resync);
  // 뒤로 가기 캐시(bfcache)에서 살아난 문서: 떠나 있는 동안 background 는 이 탭을 다른 문서로 봤다 → 처음부터 다시 알린다 (#49 검토)
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    skipSent = undefined;                                  // 합류 때 skipCheck 가 다시 알리고 알림도 띄운다
    resync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const want = toastWant;
    toastWant = null;
    resync().then(() => {                                    // 새 규칙으로 맞춰 본 뒤에 (skipAgain 주석)
      if (want && skipSent) skipToast(want);
      else skipAgain();
    });
  });

  // ==========================================================================
  // 디버그 패널 보이기 설정 → 9-panel (기본 숨김)
  //   참여 정보 페이지가 chrome.storage.local 'ui:panel' 에 쓴다. 여기서 읽어 버스로 알린다.
  //   9-panel 이 없어도 아무 일 없다(구독자 없음). 고아 탭이면 chrome.storage 가 던지므로 감싼다.
  // ==========================================================================
  const K_PANEL = 'ui:panel';
  const emitPanel = (v) => bus.emit('ui:panel', { on: v === true });
  try {
    chrome.storage.local.get(K_PANEL).then((r) => emitPanel(r[K_PANEL])).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch[K_PANEL]) emitPanel(ch[K_PANEL].newValue);
    });
  } catch (e) { /* 고아 탭: 패널은 숨김 그대로 */ }

  // 팝업 속도 (#66, 실사용 팝업이 'ui:popupPerf' 에 씀) → 9-panel. 데이터 수집 버전은 안 써서 줄이 안 생긴다.
  const K_POPPERF = 'ui:popupPerf';
  const emitPopPerf = (v) => bus.emit('popup:perf', v || null);
  try {
    chrome.storage.local.get(K_POPPERF).then((r) => emitPopPerf(r[K_POPPERF]))
      .catch((e) => console.warn('[RBC] 팝업 속도 읽기 실패', e));
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch[K_POPPERF]) emitPopPerf(ch[K_POPPERF].newValue);
    });
  } catch (e) { /* 고아 탭: 줄 없음 */ }

  // ==========================================================================
  // 오버레이 켜짐 기억 → 9-panel (#36, 11-03 서현 — 새 탭마다 켜기 번거로움)
  //   9-panel 의 [오버레이] 버튼이 ui:overlay 로 요청하면 'ui:overlay' 에 쓴다.
  //   읽을 때 · 바뀔 때마다 overlay:pref 로 알린다 → 새 탭 · 열린 다른 탭 · 브라우저 재시작 뒤에도 같은 상태.
  //   저장이 실패하면(고아 탭 등) 이 탭에만 적용하고 원문을 패널에 보낸다.
  // ==========================================================================
  const K_OVERLAY = 'ui:overlay';
  const emitOverlay = (v, err) => bus.emit('overlay:pref', { on: v === true, err: err || null });
  try {
    chrome.storage.local.get(K_OVERLAY).then((r) => emitOverlay(r[K_OVERLAY])).catch((e) => {
      const why = `오버레이 설정 읽기 실패: ${(e && e.message) || e}`;
      console.warn('[RBC]', why);
      emitOverlay(false, why);
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch[K_OVERLAY]) emitOverlay(ch[K_OVERLAY].newValue);
    });
  } catch (e) { /* 고아 탭: 저장값 없이 꺼진 상태로 시작 (패널은 session:link 로 고아를 이미 알림) */ }
  bus.on('ui:overlay', (d) => {
    const on = !!(d && d.on);
    const fail = (e) => {
      const why = `오버레이 설정 저장 실패: ${(e && e.message) || e}`;
      console.warn('[RBC]', why);
      emitOverlay(on, why);
    };
    // 저장 뒤 이 탭에는 직접도 알린다 — 값이 그대로면 onChanged 가 안 와서 버튼이 안 먹을 수 있다(#36 검토)
    try { chrome.storage.local.set({ [K_OVERLAY]: on }).then(() => emitOverlay(on), fail); } catch (e) { fail(e); }
  });

  // 패널이 켜져 있고 기록 중이면 무동작 시계를 몇 초마다 다시 받는다 (#26).
  //   iframe(블로그 PC 본문)의 입력은 이 프레임을 거치지 않고 background 로 가므로, 여기서 다시 물어야 패널이 맞는다.
  let panelOn = false;
  bus.on('ui:panel', (d) => { panelOn = !!(d && d.on); });
  setInterval(() => {
    if (!panelOn || !session.recording || document.hidden) return;
    toBg({ rbc: 'idle' }).then((r) => { if (r && r.ok) bus.emit('idle:clock', r); });
  }, CFG.IDLE_POLL_MS);

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

  // 패널 "빠른 시험" (#26) — 무동작 한도를 20초 · 40초로 줄인다. 이번 세션에만.
  bus.on('ui:idletest', (d) => {
    toBg({ rbc: 'idletest', on: !!(d && d.on) }).then((r) => { if (r && r.ok) bus.emit('idle:clock', r); });
  });

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

  // --- 무한 스크롤 의심 (#78, 헤더) ---
  //   손짓 = 클릭 · Enter · 뒤로/앞으로(popstate). 화살표 · 스페이스 · PageDown 은 스크롤 손짓이라 안 센다.
  const HINT_GESTURE_MS = 3000;    // 이 안에 손짓이 있었으면 사용자가 옮긴 것 — SPA 는 클릭 뒤 데이터를 받느라 늦게 바뀔 수 있어 넉넉히
  const HINT_SCROLL_MS = 1500;     // 이 안에 스크롤이 있었으면 스크롤 때문에 바뀐 것
  let lastGesture = 0, lastScroll = 0;
  const hint = { n: 0, strong: 0, last: null };
  //   pointerdown 도 센다 — 누르는 순간 주소를 바꾸는 라우터가 있어 click 보다 400ms 폴링이 먼저 돌 수 있다(검토).
  document.addEventListener('pointerdown', () => { lastGesture = Date.now(); }, true);
  document.addEventListener('click', () => { lastGesture = Date.now(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') lastGesture = Date.now(); }, true);
  document.addEventListener('scroll', () => { lastScroll = Date.now(); }, { capture: true, passive: true });
  window.addEventListener('popstate', () => { lastGesture = Date.now(); });

  // 앞 글 표본 = 이 프레임 유닛 중 본문다운 것 3개(1/4 · 1/2 · 3/4 자리)의 글 40자.
  //   메뉴 · 머리 같은 유닛은 SPA 이동 뒤에도 남으니 빼야 "남음"이 뜻을 갖는다:
  //   noise 조각이 있으면 뺌 + 판정이 안 나 noise 필드가 없는 페이지도 걸러지게 링크 글자 30% 이상이면 뺌 + 맨 앞 · 맨 끝 자리를 피함(검토).
  //   표 유닛은 칸 경계 글자가 textContent 와 달라 뺀다.
  //   본문이 iframe 이면 최상위엔 유닛이 없다 → 표본 없음 = "모름".
  const noWs = (s) => s.replace(/\s+/g, '');
  function hintSamples() {
    const body = RBC.units.all().filter((u) => u.pieces && u.kind !== 'table' && u.charLen >= 40 &&
      !u.pieces.some((p) => p.noise) && u.pieces.reduce((a, p) => a + (p.linkChars || 0), 0) < u.charLen * 0.3);
    if (!body.length) return [];
    const n = body.length;
    const pick = [...new Set([n >> 2, n >> 1, (n * 3) >> 2])].map((i) => body[Math.min(i, n - 1)]);
    return pick.map((u) => noWs(u.text).slice(0, 40));
  }
  // 공백을 다 빼고 비교한다 — 유닛 글은 DOM 블록 경계에 공백이 들어가고 textContent 는 붙어 나온다(<h1>…</h1><p>…, <br>, 검토).
  function hintLeft(samples) {
    if (!samples.length) return null;
    const txt = noWs(document.body ? document.body.textContent : '');
    const hit = samples.filter((s) => txt.includes(s)).length;
    return hit * 2 > samples.length;           // 과반이 남아 있으면 "남음"
  }

  function checkUrl() {
    const key = pageKey(location.href);
    if (key === lastKey) return;
    const fromKey = lastKey;
    lastKey = key;

    // 무한 스크롤 의심 (#78) — 막지 않고 패널에만. 기록 여부와 상관없이 본다.
    const now = Date.now();
    const suspect = now - lastGesture > HINT_GESTURE_MS && now - lastScroll <= HINT_SCROLL_MS;
    const samples = suspect ? hintSamples() : [];

    // 지금 글의 구간만 닫는다. primary 가 iframe 이어도 6-frames 가 전달한다.
    if (session.recording) RBC.frames.send('stop', { reason: 'navigation' });
    // 기록 안 할 주소 (#49): 새 주소로 바로 맞춰 본다 — 스캔이 실패하면(본문 없는 목록 페이지 등) 합류가 안 일어나
    //   회색 아이콘 · 팝업 "일시 정지"가 옛 주소 것으로 남았다(검토 11-06). 걸리면 아래 스캔 뒤 합류에서도 다시 걸린다.
    if (session.recording) skipCheck(true);

    // 새 글의 본문이 붙기를 기다렸다가 다시 스캔 → scan:done → 합류.
    //   앞 글이 남았나는 그 기다림 끝(다시 스캔 전, 유닛 목록이 아직 앞 글 것)에 본다 — SPA 는 주소를 먼저 바꾸고 화면을 나중에 갈아끼우기도 해서.
    setTimeout(() => {
      if (suspect) {
        let left = null;
        try { left = hintLeft(samples); } catch (e) { console.warn('[RBC] 무한 스크롤 의심 · 앞 글 확인 실패', e); }
        hint.n++;
        if (left) hint.strong++;
        hint.last = { from: fromKey, to: key, left, t: now };
        bus.emit('nav:hint', Object.assign({}, hint));
      }
      RBC.frames.doScan();
    }, CFG.FIRST_SCAN_DELAY);
  }

  setInterval(checkUrl, CFG.URL_POLL_MS);
  window.addEventListener('popstate', () => setTimeout(checkUrl, 0));
  window.addEventListener('hashchange', () => setTimeout(checkUrl, 0));

  RBC.session = {
    state: () => Object.assign({}, session),
  };
})();