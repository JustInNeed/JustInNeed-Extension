/* =============================================================================
 * consent.js — 동의 · 참여 정보 페이지 (consent.html 전용)
 *
 * background 에 요청만 한다. 동의 여부 판정·저장·게이트는 전부 background 소유다.
 *   status   → 어느 화면을 보여줄지 (동의 없음 / 안내 변경 / 참여 중)
 *   consent  → { version, participantNo, name, tag }. version 은 이 페이지 고지문의 버전
 *              참여 번호 = 연구자가 준 번호(필수). testId 는 화면에서 '설치 ID' 로 부른다
 *   clear    → 기록만 삭제 (기록 중이면 거절)
 *   withdraw → 정지 + 기록 · 참여 정보 삭제
 *   export   → bundle 을 받아 JSON 파일로 저장 (6-frames download() 와 같은 파일명)
 *
 * 주소가 #export 로 열리면(팝업의 내보내기) 첫 status 뒤 한 번 바로 내보낸다.
 *
 * 예외: '연구자용 설정'의 디버그 패널 보이기는 chrome.storage.local 'ui:panel' 에 직접 쓴다.
 *   세션 · 동의 데이터가 아닌 화면 설정이라 background 를 거치지 않는다. content 쪽은 11-session 이 읽는다.
 *
 * 조용히 실패하지 않는다: background 에 못 닿거나 거절되면 사유 원문을 배너에 띄운다.
 * 화면 기본은 '불러오는 중…' 이고 첫 render 가 지운다 — 스크립트가 안 뜨면 그 문구에서 멈춘다.
 * 되돌릴 수 없는 버튼(삭제 · 철회)은 두 번 눌러야 실행된다.
 * ========================================================================== */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const VERSION = Number($('main').dataset.consentVersion);

  // 알려진 거절 사유 → 사용자 문장. 모르는 사유는 원문 그대로 보여준다.
  const WHY = {
    'no-consent': '동의가 없어 처리할 수 없습니다.',
    'no-participant': '참여 번호를 입력하세요.',
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
    $('loading').hidden = true;
    const c = st.consent;
    if (!c || !c.valid) {
      setView('consent');
      // 안내 버전이 바뀐 재동의: 아는 값을 채워둔다 (설치 ID 는 background 가 유지)
      if (c && !c.valid && !$('f-name').value) {
        $('f-no').value = c.participantNo || '';
        $('f-name').value = c.name || '';
        $('f-tag').value = c.tag || '';
        show('안내 내용이 바뀌어 다시 동의가 필요합니다. 참여 번호를 확인하고 다시 동의하세요.', 'warn');
      }
      syncAgree();
      return;
    }

    setView('joined');
    $('j-no').textContent = c.participantNo;
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

    $('btn-export').disabled = st.recording || !st.records;
    $('btn-export').title = st.recording ? '기록을 정지한 뒤에 내보낼 수 있습니다' : '';
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
    $('btn-agree').disabled = !($('f-no').value.trim() && $('f-name').value.trim() && $('f-agree').checked);
  }
  $('f-no').addEventListener('input', syncAgree);
  $('f-name').addEventListener('input', syncAgree);
  $('f-agree').addEventListener('change', syncAgree);

  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if ($('btn-agree').disabled) return;
    $('btn-agree').disabled = true;
    try {
      const r = await bg({ rbc: 'consent', version: VERSION, participantNo: $('f-no').value,
                           name: $('f-name').value, tag: $('f-tag').value });
      show(`참여 번호 ${r.consent.participantNo} 로 동의했습니다. 이제 기록을 시작할 수 있습니다.`);
      await refresh();
      window.scrollTo(0, 0);
    } catch (e) {
      show(e.message, 'err');
      syncAgree();
    }
  });

  // ---------------------------------------------------------------------------
  // 내보내기 — 파일명은 6-frames download() 와 같다 (터미널의 rbc_*.json 규칙 유지)
  // ---------------------------------------------------------------------------
  async function exportFile() {
    const bundle = await bg({ rbc: 'export' });
    if (!bundle || bundle.kind !== 'rbc-session') throw new Error('내보낼 기록을 만들지 못했습니다. (export: 형식 불일치)');
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });   // 한 줄 (팀 결정, 용량)
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const sid = (bundle.session.sessionId || 'nosid').slice(0, 8);
    a.download = `rbc_${sid}_${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);   // 탭이라 여유 있게
    show(`파일로 내보냈습니다: 글 ${bundle.pages.length}개. 다운로드 폴더를 확인하세요.`);
  }

  $('btn-export').addEventListener('click', async () => {
    $('btn-export').disabled = true;
    try { await exportFile(); } catch (e) { show(e.message, 'err'); }
    await refresh();
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
    $('f-no').value = ''; $('f-name').value = ''; $('f-tag').value = ''; $('f-agree').checked = false;
    show('동의를 철회했습니다. 이 브라우저의 기록과 참여 정보를 모두 지웠습니다.');
  });

  // ---------------------------------------------------------------------------
  // 연구자용 설정: 디버그 패널 보이기 (기본 꺼짐)
  // ---------------------------------------------------------------------------
  const K_PANEL = 'ui:panel';
  chrome.storage.local.get(K_PANEL)
    .then((r) => { $('f-panel').checked = r[K_PANEL] === true; })
    .catch((e) => show(`설정을 읽지 못했습니다. (ui:panel: ${e.message || e})`, 'err'));
  $('f-panel').addEventListener('change', async () => {
    try {
      await chrome.storage.local.set({ [K_PANEL]: $('f-panel').checked });
    } catch (e) {
      show(`설정을 저장하지 못했습니다. (ui:panel: ${e.message || e})`, 'err');
    }
  });

  // ---------------------------------------------------------------------------
  // 시작 · 갱신 (보이는 동안만 1초마다 — 경과 시간과 기록 상태)
  // ---------------------------------------------------------------------------
  // 팝업의 내보내기로 열렸으면 한 번만 내보낸다 (새로고침해도 반복되지 않게 해시를 지운다)
  const wantExport = location.hash === '#export';
  if (wantExport) history.replaceState(null, '', location.pathname);

  refresh().then(async () => {
    if (!wantExport || !st || view !== 'joined') return;
    if (st.recording) { show('기록 중에는 내보낼 수 없습니다. 먼저 기록을 정지하세요.', 'err'); return; }
    if (!st.records) { show('내보낼 기록이 없습니다.', 'warn'); return; }
    try { await exportFile(); } catch (e) { show(e.message, 'err'); }
  });
  setInterval(() => { if (!document.hidden) refresh(); }, 1000);
})();