/* =============================================================================
 * consent.js — 동의 · 참여 정보 페이지 (consent.html 전용)
 *
 * background 에 요청만 한다. 동의 여부 판정·저장·게이트는 전부 background 소유다.
 *   status   → 어느 화면을 보여줄지 (동의 없음 / 안내 변경 / 참여 중)
 *   consent  → { version, name, tag }. version 은 이 페이지 고지문의 버전
 *   clear    → 기록만 삭제 (기록 중이면 거절)
 *   withdraw → 정지 + 기록 · 참여 정보 삭제
 *
 * 조용히 실패하지 않는다: background 에 못 닿거나 거절되면 사유 원문을 배너에 띄운다.
 * 되돌릴 수 없는 버튼(삭제 · 철회)은 두 번 눌러야 실행된다.
 * ========================================================================== */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const VERSION = Number($('main').dataset.consentVersion);

  // 알려진 거절 사유 → 사용자 문장. 모르는 사유는 원문 그대로 보여준다.
  const WHY = {
    'no-consent': '동의가 없어 처리할 수 없습니다.',
    'no-name': '이름을 입력하세요.',
    'consent-version': '안내 내용이 바뀌었습니다. 이 페이지를 새로고침한 뒤 다시 동의하세요.',
    'recording': '기록 중에는 삭제할 수 없습니다. 먼저 기록을 정지하세요.',
  };

  // ---------------------------------------------------------------------------
  // background 통신
  // ---------------------------------------------------------------------------
  async function bg(msg) {
    let r;
    try {
      r = await chrome.runtime.sendMessage(msg);
    } catch (e) {
      throw new Error(`확장과 연결되지 않았습니다. 이 페이지를 새로고침하세요. (${msg.rbc}: ${e.message || e})`);
    }
    if (r == null) throw new Error(`확장이 응답하지 않았습니다. (${msg.rbc}: no-reply)`);
    if (r.ok === false) throw new Error(WHY[r.why] || `처리하지 못했습니다. (${msg.rbc}: ${r.why})`);
    return r;
  }

  let msgFromRefresh = false;   // 연결 오류 배너는 다음 성공 때 스스로 지운다
  function show(text, kind) {
    msgFromRefresh = false;
    const el = $('msg');
    if (!text) { el.hidden = true; return; }
    el.className = 'banner' + (kind ? ' ' + kind : '');
    el.textContent = text;
    el.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // 화면
  // ---------------------------------------------------------------------------
  let st = null;          // 마지막 status 응답
  let view = null;        // 'consent' | 'joined'

  function fmtDate(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}시간 ${m}분` : `${m}분 ${sec}초`;
  }

  function setView(v) {
    if (view === v) return;
    view = v;
    $('view-consent').hidden = v !== 'consent';
    $('view-joined').hidden = v !== 'joined';
    // 고지문은 한 벌만 둔다. 참여 화면에서는 접힌 칸으로 옮겨 보여준다.
    const notice = $('notice');
    if (v === 'joined') $('notice-slot-joined').appendChild(notice);
    else $('form').before(notice);
  }

  function render() {
    const c = st.consent;
    if (!c || !c.valid) {
      setView('consent');
      // 안내 버전이 바뀐 재동의: 이름 · 태그를 채워두고 참여 번호가 유지된다고 알린다
      if (c && !c.valid && !$('f-name').value) {
        $('f-name').value = c.name || '';
        $('f-tag').value = c.tag || '';
        show('안내 내용이 바뀌어 다시 동의가 필요합니다. 참여 번호는 그대로 유지됩니다.', 'warn');
      }
      syncAgree();
      return;
    }

    setView('joined');
    $('j-id').textContent = c.testId;
    $('j-name').textContent = c.name;
    $('j-tag').textContent = c.tag || '없음';
    $('j-at').textContent = fmtDate(c.at);

    $('s-dot').classList.toggle('on', st.recording);
    $('s-state').textContent = st.recording ? '기록 중' : '기록 대기';
    const parts = [];
    if (st.recording && st.startedAt) parts.push(fmtElapsed(Date.now() - st.startedAt));
    if (st.records) parts.push(`글 ${st.pages}개`, `유닛 ${st.units}개`);
    else parts.push('쌓인 기록 없음');
    $('s-detail').textContent = parts.join(', ');

    $('btn-clear').disabled = st.recording || !st.records;
    $('btn-clear').title = st.recording ? '기록을 정지한 뒤에 지울 수 있습니다' : '';
  }

  async function refresh() {
    try {
      st = await bg({ rbc: 'status' });
      if (msgFromRefresh) show(null);
      render();
    } catch (e) {
      show(e.message, 'err');
      msgFromRefresh = true;
    }
  }

  // ---------------------------------------------------------------------------
  // 동의 폼
  // ---------------------------------------------------------------------------
  function syncAgree() {
    $('btn-agree').disabled = !($('f-name').value.trim() && $('f-agree').checked);
  }
  $('f-name').addEventListener('input', syncAgree);
  $('f-agree').addEventListener('change', syncAgree);

  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if ($('btn-agree').disabled) return;
    $('btn-agree').disabled = true;
    try {
      const r = await bg({ rbc: 'consent', version: VERSION, name: $('f-name').value, tag: $('f-tag').value });
      show(`참여 번호가 발급됐습니다: ${r.consent.testId}. 이제 기록을 시작할 수 있습니다.`);
      await refresh();
      window.scrollTo(0, 0);
    } catch (e) {
      show(e.message, 'err');
      syncAgree();
    }
  });

  // ---------------------------------------------------------------------------
  // 되돌릴 수 없는 버튼: 첫 클릭은 무장, 4초 안에 두 번째 클릭이면 실행
  // ---------------------------------------------------------------------------
  function twoStep(btn, armedText, run) {
    const label = btn.textContent;
    let timer = null;
    const disarm = () => { clearTimeout(timer); timer = null; btn.classList.remove('armed'); btn.textContent = label; };
    btn.addEventListener('click', async () => {
      if (!timer) {
        btn.classList.add('armed');
        btn.textContent = armedText;
        timer = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      btn.disabled = true;
      try { await run(); } catch (e) { show(e.message, 'err'); }
      btn.disabled = false;
      await refresh();
    });
  }

  twoStep($('btn-clear'), '한 번 더 누르면 삭제', async () => {
    await bg({ rbc: 'clear' });
    show('기록을 삭제했습니다. 참여 정보는 그대로입니다.');
  });

  twoStep($('btn-withdraw'), '한 번 더 누르면 철회', async () => {
    await bg({ rbc: 'withdraw' });
    $('f-name').value = ''; $('f-tag').value = ''; $('f-agree').checked = false;
    show('동의를 철회했습니다. 이 브라우저의 기록과 참여 정보를 모두 지웠습니다.');
  });

  // ---------------------------------------------------------------------------
  // 시작 · 갱신 (보이는 동안만 1초마다 — 경과 시간과 기록 상태)
  // ---------------------------------------------------------------------------
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 1000);
})();