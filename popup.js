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

  function render() {
    $('loading').hidden = true;
    const c = st.consent;
    const joined = !!(c && c.valid);
    $('v-consent').hidden = joined;
    $('v-joined').hidden = !joined;
    if (!joined) {
      $('consent-text').textContent = c
        ? '안내 내용이 바뀌어 다시 동의가 필요합니다. 참여 번호는 그대로 유지됩니다.'
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
    $('tid').textContent = c.testId;
  }

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
        await bg({ rbc: 'start', query: q || null });
        qTouched = false;
      }
    } catch (e) {
      show(e.message);
    }
    await refresh();
  });

  $('q').addEventListener('input', () => { qTouched = true; });
  $('btn-consent').addEventListener('click', () => openPage(''));
  $('btn-info').addEventListener('click', () => openPage(''));
  $('btn-export').addEventListener('click', () => openPage('#export'));

  refresh();
  setInterval(refresh, 1000);
})();