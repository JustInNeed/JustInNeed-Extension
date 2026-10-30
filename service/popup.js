/* =============================================================================
 * popup.js — 실사용 버전 기록 제어 (popup.html 전용)
 *
 * background 에 요청만 한다 (규칙 3). 시작/정지의 실제 반영은 background 방송이고,
 * 이 화면은 1초마다 status 를 다시 읽어 그린다 — 낙관적으로 먼저 바꾸지 않는다.
 *
 * 새 기록 시작은 이전 기록을 지운다 (background start, 서버 전송이 없는 동안). 쌓인 기록이 있으면
 * 두 번 눌러야 시작한다. 정지는 한 번 — 실사용 버전에는 평가가 없어 정지로 잃는 것이 없다.
 *
 * 디버그 패널 보이기는 데이터 수집 버전의 참여 정보 페이지와 같은 키(chrome.storage.local 'ui:panel')에
 *   직접 쓴다. 11-session 이 그 키를 보고 패널을 켠다. 실사용 버전에는 그 페이지가 없어 여기 둔다.
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

  function render() {
    $('loading').hidden = true;
    $('v-main').hidden = false;
    $('dot').classList.toggle('on', st.recording);
    $('state').textContent = st.recording ? '기록 중' : '기록 대기';
    $('meta').textContent = st.records > 0 ? `글 ${st.pages}개 · 유닛 ${st.units}개 · 기록 ${st.records}건` : '';
    if (!armTimer) {
      const btn = $('btn-rec');
      btn.className = st.recording ? '' : 'primary';
      btn.textContent = st.recording ? '기록 정지' : '기록 시작';
    }
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
      }
    } catch (e) {
      show(e.message);
    }
    await refresh();
  });

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

  refresh();
  setInterval(refresh, 1000);
})();
