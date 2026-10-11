/* =============================================================================
 * popup.js — 참가자용 기록 제어 (popup.html 전용)
 *
 * background 에 요청만 한다 (규칙 3). 시작/정지의 실제 반영은 background 방송이고,
 * 이 화면은 1초마다 status 를 다시 읽어 그린다 — 낙관적으로 먼저 바꾸지 않는다.
 *
 * 검색어는 기록 시작 전에만 입력받아 start 에 싣는다. 기록 중 변경은 막는다:
 *   background 의 query 는 세션 값만 바꾸고 열린 탭의 5-recorder 에는 전달되지 않아
 *   세션과 페이지의 검색어가 갈린다.
 *
 * 새 기록 시작은 이전 기록을 지운다 (background start). 쌓인 기록이 있으면
 * 경고를 띄우고 두 번 눌러야 시작한다.
 *
 * 읽는 목적도 검색어와 같은 규칙 — 기록 시작 전에만 받는다.
 * "다 읽었어요"(기록 중에만): 지금 보고 있는 탭에 라벨 모드를 켜고 팝업을 닫는다.
 *
 * 기록 시작 뒤 "본문 준비 중" (0-B, 2026-10-08): 시작을 누르면 바로 닫지 않는다. 페이지가 본문이 조용해질
 *   때까지 기다렸다 구간을 여는데(5-recorder), 그동안 이 창이 "본문 준비 중"을 보여 주고 ping 으로 확인해
 *   기록이 실제로 시작되면 닫힌다. 최대 PREP_MAX_MS. 참가자에게 대기를 보여 줄 곳이 여기뿐이다(패널은 숨김).
 *
 * 내보내기 · 참여 정보는 consent.html 탭을 연다 (#export 면 그 탭이 바로 내보낸다).
 *
 * 화면은 기본이 '불러오는 중…' 이고 첫 render 가 지운다. 스크립트가 안 뜨면 그 문구에서
 * 멈춰 보인다 (빈 화면으로 조용히 실패하지 않게).
 * ========================================================================== */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const WHY = {
    'no-consent': '동의가 없어 기록을 시작할 수 없습니다.',
    'not-recording': '기록 중일 때만 중요한 부분을 고를 수 있습니다.',
    'no-tab': '지금 보고 있는 탭을 찾지 못했습니다.',
    'no-content': '이 탭에서는 고를 수 없습니다. 페이지를 새로고침한 뒤 다시 시도하세요.',
  };

  async function bg(msg) {
    let r;
    try {
      r = await chrome.runtime.sendMessage(msg);
    } catch (e) {
      throw new Error(`확장과 연결되지 않았습니다. (${msg.rbc}: ${e.message || e})`);
    }
    if (r == null) throw new Error(`확장이 응답하지 않았습니다. (${msg.rbc}: no-reply)`);
    if (r.ok === false) throw new Error(WHY[r.why] || `처리하지 못했습니다. (${msg.rbc}: ${r.why})`);
    return r;
  }

  function show(text) {
    $('msg').textContent = text || '';
    $('msg').hidden = !text;
  }

  function openPage(hash) {
    chrome.tabs.create({ url: chrome.runtime.getURL('consent.html') + (hash || '') });
    window.close();
  }

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}시간 ${m}분` : `${m}분 ${sec}초`;
  }

  // ---------------------------------------------------------------------------
  // 그리기
  // ---------------------------------------------------------------------------
  let st = null;
  let qTouched = false;       // 사용자가 검색어 칸을 건드렸으면 status 로 덮어쓰지 않는다
  let sTouched = false;       // 읽는 목적 칸도 같은 규칙
  let preparing = false;      // 기록 시작 뒤 본문 준비 중 (이 창이 닫히기 전까지)

  function render() {
    $('loading').hidden = true;
    const c = st.consent;
    const joined = !!(c && c.valid);
    $('v-consent').hidden = joined;
    $('v-joined').hidden = !joined;
    if (!joined) {
      $('consent-text').textContent = c
        ? '안내 내용이 바뀌어 다시 동의가 필요합니다. 동의 페이지에서 참여 번호를 확인해 주세요.'
        : '기록을 시작하려면 먼저 테스트 참여에 동의해야 합니다.';
      return;
    }

    const rec = st.recording;
    $('dot').classList.toggle('on', rec);
    $('state').textContent = rec ? '기록 중' : '기록 대기';
    $('elapsed').textContent = rec && st.startedAt ? fmtElapsed(Date.now() - st.startedAt) : '';
    $('meta').textContent = st.records ? `글 ${st.pages}개, 유닛 ${st.units}개` : '쌓인 기록 없음';

    $('q-edit').hidden = rec;
    $('q-show').hidden = !rec || !st.query;
    $('q-val').textContent = st.query || '';
    if (!rec && !qTouched) $('q').value = st.query || '';
    $('s-edit').hidden = rec;
    $('s-show').hidden = !rec || !st.scenario;
    $('s-val').textContent = st.scenario || '';
    if (!rec && !sTouched) $('s').value = st.scenario || '';
    $('btn-label').hidden = !rec;

    const btn = $('btn-rec');
    if (!btn.classList.contains('armed')) {
      btn.className = rec ? '' : 'primary';
      btn.innerHTML = rec ? '<i class="stop-mark"></i>기록 정지' : '기록 시작';
    }
    const willWipe = !rec && st.records > 0;
    $('warn').hidden = !willWipe;
    $('warn').textContent = willWipe
      ? `새로 시작하면 지금 쌓인 기록(글 ${st.pages}개)이 지워집니다. 필요하면 먼저 내보내세요.` : '';

    $('btn-export').disabled = rec || !st.records;
    $('btn-export').title = rec ? '기록을 정지한 뒤에 내보낼 수 있습니다' : '';
    $('hint').textContent = rec
      ? '이 창을 닫고 글을 읽으세요. 끝까지 내리면 평가 질문이 뜹니다. 안 뜨면 다시 열어 [다 읽었어요]를 누르세요.'
      : '기록 시작을 누르면 이 창이 닫힙니다. 창이 닫힌 뒤 글을 읽으세요.';
    $('tid').textContent = c.participantNo || '';
    renderConn(rec);
    if (preparing) renderPreparing();
  }

  function renderPreparing() {
    $('state').textContent = '본문 준비 중…';
    $('dot').classList.remove('on');
    $('elapsed').textContent = '';
    $('btn-rec').disabled = true;
    $('btn-label').hidden = true;
    $('hint').textContent = '페이지가 다 그려질 때까지 잠깐 기다려요. 이 창이 저절로 닫히면 그때부터 읽으세요.';
  }

  // ---------------------------------------------------------------------------
  // 이 탭 연결 확인 (참가자용, 0-B)
  //   확장을 새로 설치 · 업데이트한 뒤 새로고침 안 한 탭은 수집 코드가 없거나 끊겨 있다(고아 탭).
  //   그 상태로 기록을 시작하면 아무것도 안 쌓인다 → 팝업에서 바로 알려 주고 새로고침 버튼을 준다.
  //   tab = 지금 창의 활성 탭. 응답 = 11-session 의 ping (최상위 프레임).
  // ---------------------------------------------------------------------------
  //   activeTab 권한: 팝업을 연 순간 활성 탭 주소를 읽을 수 있다(설치 경고 없음). 브라우저 내부 페이지
  //   (chrome://, 웹 스토어, 새 탭, PDF 뷰어 등)는 확장이 들어갈 수 없어서 새로고침해도 안 된다 — 따로 알린다.
  let tabId = null;
  let conn = null;                 // null = 확인 중, { ok:true, units, … } | { ok:false, closed? }
  const CLOSED = /^(chrome|chrome-extension|edge|about|view-source|devtools|data|file):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;
  async function pingTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) { conn = { ok: false }; return; }
      tabId = tab.id;
      // activeTab 은 일반 웹 페이지에서만 주소를 준다. chrome:// 같은 내부 페이지는 권한이 안 나와서 url 이 비어 있다
      //   (2026-10-08 실측: chrome://extensions 에서 url 없음). 그래서 "주소가 안 보임" 자체를 내부 페이지로 본다.
      if (!tab.url || CLOSED.test(tab.url)) { conn = { ok: false, closed: true }; return; }
      const r = await chrome.tabs.sendMessage(tab.id, { rbc: 'ping' });
      conn = r && r.ok ? r : { ok: false };
    } catch (e) {
      conn = { ok: false };        // Receiving end does not exist — 수집 코드가 없음
    }
  }

  function renderConn(rec) {
    const box = $('conn');
    const bad = conn && !conn.ok;
    box.className = 'conn' + (conn ? (bad ? ' bad' : ' ok') : '');
    $('conn-text').textContent = !conn ? '이 탭 확인 중…'
      : bad && conn.closed ? '이 페이지는 브라우저 내부 페이지라 기록할 수 없어요. 읽을 글을 연 탭에서 다시 열어 주세요.'
      : bad ? '이 탭은 기록할 준비가 안 됐어요. [이 탭 새로고침]을 누른 뒤 다시 열어 주세요.'
        : conn.units ? `이 탭 연결됨 · 본문 ${conn.units}부분 인식`
          : '이 탭 연결됨 · 본문을 찾는 중 — 잠시 뒤 다시 열어 보세요';
    $('btn-reload').hidden = !bad || !!conn.closed;
    if (!rec && bad) $('btn-rec').disabled = true;
    else $('btn-rec').disabled = false;
  }

  $('btn-reload').addEventListener('click', async () => {
    if (tabId == null) return;
    try { await chrome.tabs.reload(tabId); } catch (e) { show(e.message); return; }
    window.close();
  });

  async function refresh() {
    try {
      st = await bg({ rbc: 'status' });
      render();
    } catch (e) {
      show(e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // 기록 시작 / 정지
  //   쌓인 기록이 있으면 첫 클릭은 무장만 한다 (4초 안에 다시 누르면 시작).
  //   정지도 두 번 눌러야 한다 (2026-10-11): 정지하면 그 글은 평가할 길이 없고(평가 화면은 기록 중에만 열림),
  //   테스트 모드는 평가 [완료] 때만 파일이 저장되므로 정지 뒤 [기록 시작]을 누르면 그 기록이 지워진다.
  //   평가하려는 사람은 [다 읽었어요 · 평가하기]를 쓰게 안내한다. 숨기지 않는 이유: 잘못 연 글 · 망가진 페이지에서 빠져나갈 길.
  // ---------------------------------------------------------------------------
  let armTimer = null;
  function disarm() {
    clearTimeout(armTimer); armTimer = null;
    $('btn-rec').classList.remove('armed');
    if (st) render();
  }

  $('btn-rec').addEventListener('click', async () => {
    if (!st) return;
    show(null);
    const btn = $('btn-rec');
    try {
      if (st.recording) {
        if (!armTimer) {
          btn.className = 'armed';
          btn.textContent = '한 번 더 누르면 평가 없이 정지';
          show('정지하면 이 글은 평가할 수 없어요. 평가하려면 [다 읽었어요 · 평가하기]를 누르세요.');
          armTimer = setTimeout(() => { show(null); disarm(); }, 4000);
          return;
        }
        disarm();
        await bg({ rbc: 'stop', reason: 'user' });
      } else {
        if (st.records > 0 && !armTimer) {
          btn.className = 'armed';
          btn.textContent = '한 번 더 누르면 새로 시작';
          armTimer = setTimeout(disarm, 4000);
          return;
        }
        disarm();
        const q = $('q').value.replace(/\s+/g, ' ').trim();
        const sc = $('s').value.replace(/\s+/g, ' ').trim();
        await bg({ rbc: 'start', query: q || null, scenario: sc || null });
        qTouched = false;
        sTouched = false;
        waitReady();                      // 본문 준비가 끝나면 닫힌다 — 시작 = 페이지로 돌아감
        return;
      }
    } catch (e) {
      show(e.message);
    }
    await refresh();
  });

  // 기록 시작 뒤: 이 탭이 실제로 기록을 시작할 때까지 기다렸다 닫는다.
  //   닫는 조건: ping 이 recording && !settling / ping 실패(닫고 페이지로) / PREP_MAX_MS 지남.
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

  $('q').addEventListener('input', () => { qTouched = true; });
  $('s').addEventListener('input', () => { sTouched = true; });

  $('btn-label').addEventListener('click', async () => {
    show(null);
    try {
      await bg({ rbc: 'label' });
      window.close();                     // 페이지로 돌아가서 평가한다
    } catch (e) {
      show(e.message);
    }
  });
  $('btn-consent').addEventListener('click', () => openPage(''));
  $('btn-info').addEventListener('click', () => openPage(''));
  $('btn-export').addEventListener('click', () => openPage('#export'));

  refresh();
  pingTab().then(() => { if (st) render(); });
  setInterval(refresh, 1000);
})();