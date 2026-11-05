/* =============================================================================
 * popup.js — 실사용 버전 기록 제어 (popup.html 전용)
 *
 * background 에 요청만 한다 (규칙 3). 시작/정지의 실제 반영은 background 방송이고,
 * 이 화면은 1초마다 status 를 다시 읽어 그린다 — 낙관적으로 먼저 바꾸지 않는다.
 *
 * 새 기록 시작은 이전 기록을 지운다 (background start, 서버 전송이 없는 동안). 쌓인 기록이 있으면
 * 두 번 눌러야 시작한다. 정지는 한 번 — 실사용 버전에는 평가가 없어 정지로 잃는 것이 없다.
 *
 * 기록 시작 뒤 "본문 준비 중": 데이터 수집 버전 popup.js 와 같은 규칙(#19 서현 요청). 시작을 누르면 바로 닫지 않고
 *   이 탭에 ping 을 보내 기록이 실제로 시작되면(recording && !settling) 닫힌다. ping 실패 · PREP_MAX_MS 지남도 닫힌다.
 *
 * 디버그 패널 보이기는 데이터 수집 버전의 참여 정보 페이지와 같은 키(chrome.storage.local 'ui:panel')에
 *   직접 쓴다. 11-session 이 그 키를 보고 패널을 켠다. 실사용 버전에는 그 페이지가 없어 여기 둔다.
 *
 * 로그인(#30): status 의 login 이 없으면 로그인 화면(v-login)만 보인다. 로그인 실패 원문(loginErr)은 화면 아래 빨간 줄,
 *   알림(loginNote, 예: 팝업을 저절로 못 엶)은 회색 줄. 열릴 때마다 whoami 로 로그인 확인을 건다. [로그아웃]은 회원 줄 옆.
 *
 * 서버 전송(#34): status 의 sink 로 "보낼 청크 N개 · 마지막 자름 #n · 안 자른 기록 K건" 회색 줄,
 *   그 아래 "보냄 #n · N초 전" (지운 청크가 있으면 그 수), 자르기 · 보내기 실패 원문은 빨간 줄.
 *   로그아웃 화면에도 못 보낸 청크 수를 띄운다(로그인하면 보냄).
 *   마지막 청크를 만든 뒤에 늦게 와서 청크에 못 넣은 기록이 있으면 그 수도 띄운다(정지 뒤 조용해질 때까지 최대 약 35초 기다림).
 *   [보내지 않은 청크 지우기](#40): 보낼 청크가 있을 때만 보인다. 두 번 눌러야 지운다. 기록 중 · 마지막 청크 만드는 중엔
 *   막혀 있고 이유가 버튼 글자로 보인다. background 도 같은 조건으로 다시 거절한다(화면만 믿지 않는다).
 *
 * 화면은 기본이 '불러오는 중…' 이고 첫 render 가 지운다. 스크립트가 안 뜨면 그 문구에서
 * 멈춰 보인다 (빈 화면으로 조용히 실패하지 않게).
 * ========================================================================== */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const K_PANEL = 'ui:panel';

  async function bg(msg) {
    let r;
    try {
      r = await chrome.runtime.sendMessage(msg);
    } catch (e) {
      throw new Error(`확장과 연결되지 않았습니다. (${msg.rbc}: ${e.message || e})`);
    }
    if (r == null) throw new Error(`확장이 응답하지 않았습니다. (${msg.rbc}: no-reply)`);
    if (r.ok === false) throw new Error(`처리하지 못했습니다. (${msg.rbc}: ${r.why})`);
    return r;
  }

  function show(text) {
    $('msg').textContent = text || '';
    $('msg').hidden = !text;
  }

  let st = null;
  let armTimer = null;
  let preparing = false;      // 기록 시작 뒤 본문 준비 중 (이 창이 닫히기 전까지)
  let tabId = null;           // 지금 창의 활성 탭 — 본문 준비 확인(ping) 대상

  function render() {
    $('loading').hidden = true;
    $('test-server').textContent = st.testServer ? `시험 서버에 연결됨: ${st.testServer}` : '';
    $('test-server').hidden = !st.testServer;
    // 로그인 전이면 로그인 화면만 (#30). 기록 중에 웹에서 로그아웃됐으면 정지할 수 있게 기록 화면을 그대로 둔다.
    const needLogin = !st.login && !st.recording;
    $('v-login').hidden = !needLogin;
    $('v-main').hidden = needLogin;
    for (const id of ['login-err', 'main-err']) {
      $(id).textContent = st.loginErr || '';
      $(id).hidden = !st.loginErr;
    }
    $('who').textContent = st.login ? `회원 ${st.login.memberId} 로그인됨` : '로그아웃됨 — 이 기록은 시작 때 회원으로 남아요';
    $('btn-logout').hidden = !st.login;
    $('main-note').textContent = st.loginNote || '';
    $('main-note').hidden = !st.loginNote;
    const k = st.sink;
    $('login-sink').textContent = k && k.queued ? `보내지 못한 청크 ${k.queued}개가 있어요 — 로그인하면 보내요 (3일 지나면 지워져요)` : '';
    $('login-sink').hidden = !(k && k.queued);
    if (needLogin) return;
    renderSink(k);
    $('dot').classList.toggle('on', st.recording);
    $('state').textContent = st.recording ? '기록 중' : '기록 대기';
    $('meta').textContent = st.records > 0 ? `글 ${st.pages}개 · 유닛 ${st.units}개 · 기록 ${st.records}건` : '';
    if (!armTimer) {
      const btn = $('btn-rec');
      btn.className = st.recording ? '' : 'primary';
      btn.textContent = st.recording ? '기록 정지' : '기록 시작';
    }
    if (preparing) {
      $('dot').classList.remove('on');
      $('state').textContent = '본문 준비 중…';
      $('meta').textContent = '페이지가 다 그려질 때까지 잠깐 기다려요. 이 창이 저절로 닫히면 그때부터 읽으세요.';
      $('btn-rec').disabled = true;
    }
  }

  function ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return s < 60 ? `${s}초 전` : `${Math.floor(s / 60)}분 전`;
  }

  function renderSink(k) {
    if (!k) { $('sink').textContent = ''; $('sink-err').hidden = true; return; }
    const parts = [`보낼 청크 ${k.queued}개 (${Math.ceil(k.queuedBytes / 1024)}KB)`];
    if (k.lastN) parts.push(`마지막 자름 #${k.lastN}${k.finalDone ? ' (마지막 청크)' : ''}${k.lastCutAt ? ' · ' + ago(k.lastCutAt) : ''}`);
    if (k.uncut) parts.push(`안 자른 기록 ${k.uncut}건`);
    if (k.late) parts.push(`마지막 청크 뒤에 늦게 와서 빠진 기록 ${k.late}건`);
    $('sink').textContent = '서버 전송: ' + parts.join(' · ');
    const sent = [];
    if (k.lastSent) sent.push(`보냄 #${k.lastSent.n}${k.lastSent.duplicate ? ' (서버에 이미 있었음)' : ''} · ${ago(k.lastSent.at)}`);
    if (k.waiting) sent.push(k.waiting);
    if (k.dropped && k.dropped.other) sent.push(`다른 회원 청크 ${k.dropped.other}개 지움`);
    if (k.dropped && k.dropped.expired) sent.push(`3일 지난 청크 ${k.dropped.expired}개 지움`);
    if (k.dropped && k.dropped.missing) sent.push(`내용이 없어 뺀 청크 ${k.dropped.missing}개`);
    $('sink-sent').textContent = sent.join(' · ');
    $('sink-sent').hidden = !sent.length;
    const errs = [k.err && `청크 자르기 실패: ${k.err}`, k.sendErr && `보내기 실패: ${k.sendErr}`].filter(Boolean);
    $('sink-err').textContent = errs.join(' / ');
    $('sink-err').hidden = !errs.length;
    renderClear(k);
  }

  // [보내지 않은 청크 지우기] (#40): 보낼 청크가 있을 때만. 기록 중 · 마지막 청크 만드는 중엔 막고 이유를 버튼에.
  function renderClear(k) {
    const btn = $('btn-clear');
    if (!k.queued) { disarmClear(); btn.hidden = true; return; }
    btn.hidden = false;
    const why = st.recording ? '기록 중에는 지울 수 없어요' : k.cutting ? '마지막 청크를 만드는 중이에요 — 잠시 뒤 지울 수 있어요' : null;
    if (why) disarmClear();
    btn.disabled = !!why;
    if (clearTimer) return;
    btn.className = 'small';
    btn.textContent = why || `보내지 않은 청크 ${k.queued}개 지우기`;
  }

  async function refresh() {
    try {
      st = await bg({ rbc: 'status' });
      render();
    } catch (e) {
      show(e.message);
    }
  }

  function disarm() {
    clearTimeout(armTimer); armTimer = null;
    if (st) render();
  }

  $('btn-rec').addEventListener('click', async () => {
    if (!st) return;
    show(null);
    try {
      if (st.recording) {
        await bg({ rbc: 'stop', reason: 'user' });
      } else {
        if (st.records > 0 && !armTimer) {
          const btn = $('btn-rec');
          btn.className = 'armed';
          btn.textContent = '한 번 더 누르면 이전 기록을 지우고 시작';
          armTimer = setTimeout(disarm, 4000);
          return;
        }
        disarm();
        await bg({ rbc: 'start' });
        waitReady();                      // 본문 준비가 끝나면 닫힌다 — 시작 = 페이지로 돌아감
        return;
      }
    } catch (e) {
      show(e.message);
    }
    await refresh();
  });

  // 보내지 않은 청크 지우기 (#40): 두 번 눌러야 지운다(기록 시작과 같은 방식). 지운 수는 따로 남기지 않는다(11-05 서현).
  let clearTimer = null;
  function disarmClear() { clearTimeout(clearTimer); clearTimer = null; }
  $('btn-clear').addEventListener('click', async () => {
    if (!st || !st.sink) return;
    show(null);
    if (!clearTimer) {
      const btn = $('btn-clear');
      btn.className = 'small armed';
      btn.textContent = `한 번 더 누르면 ${st.sink.queued}개를 지워요 — 서버로 가지 않아요`;
      clearTimer = setTimeout(() => { clearTimer = null; if (st) render(); }, 4000);
      return;
    }
    disarmClear();
    try {
      await bg({ rbc: 'clearOut' });
    } catch (e) {
      show(e.message);
    }
    await refresh();
  });

  // 로그인하러 가기 (#30): background 가 웹 연결 페이지를 새 탭으로 연다. 새 탭이 앞에 오며 이 창은 닫힌다.
  $('btn-login').addEventListener('click', async () => {
    show(null);
    try {
      await bg({ rbc: 'login' });
    } catch (e) {
      show(e.message);
    }
  });

  // 로그아웃 (#30): background 가 토큰을 지우고 서버에 알린다. 화면은 다음 status 에서 로그인 화면으로 바뀐다.
  $('btn-logout').addEventListener('click', async () => {
    show(null);
    try {
      await bg({ rbc: 'logout' });
    } catch (e) {
      show(e.message);
    }
    await refresh();
  });

  // 기록 시작 뒤: 이 탭이 실제로 기록을 시작할 때까지 기다렸다 닫는다 (데이터 수집 popup.js 와 같은 값).
  //   페이지 쪽 최대 대기(SETTLE_MAX_MS 6초)보다 길게 — 그 안에 대개 풀린다.
  const PREP_MAX_MS = 8000, PREP_POLL_MS = 300;
  function waitReady() {
    preparing = true;
    if (st) render();
    const t0 = Date.now();
    const poll = async () => {
      let r = null;
      try { if (tabId != null) r = await chrome.tabs.sendMessage(tabId, { rbc: 'ping' }); } catch (e) { r = null; }
      if (!r || !r.ok || (r.recording && !r.settling) || Date.now() - t0 > PREP_MAX_MS) { window.close(); return; }
      setTimeout(poll, PREP_POLL_MS);
    };
    setTimeout(poll, PREP_POLL_MS);
  }

  chrome.tabs.query({ active: true, currentWindow: true })
    .then(([t]) => { tabId = t ? t.id : null; })
    .catch((e) => show(`지금 탭을 찾지 못했습니다. (tabs.query: ${e.message || e})`));

  chrome.storage.local.get(K_PANEL)
    .then((r) => { $('f-panel').checked = r[K_PANEL] === true; })
    .catch((e) => show(`설정을 읽지 못했습니다. (ui:panel: ${e.message || e})`));
  $('f-panel').addEventListener('change', async () => {
    try {
      await chrome.storage.local.set({ [K_PANEL]: $('f-panel').checked });
    } catch (e) {
      show(`설정을 저장하지 못했습니다. (ui:panel: ${e.message || e})`);
    }
  });

  // 열릴 때마다 로그인이 아직 살아 있는지 서버에 확인 (#30). 결과는 1초 status 에 나온다.
  bg({ rbc: 'whoami' }).catch((e) => show(e.message));
  refresh();
  setInterval(refresh, 1000);
})();
