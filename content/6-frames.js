/* =============================================================================
 * 6-frames.js — 프레임 간 통신 · primary 선출 · export 저장
 *
 * 소유: isPrimary, primaryTag, seenMsg, scanBucket/Timer/Tries
 * 의존(직접 호출): 0-core, 2-units, 5-recorder
 * 발행: cmd:*, primary:changed, scan:progress, scan:failed, scan:done
 * 구독: units:scanned, units:list, stat, export:ready, record:stopped,
 *       activity, focus:broadcast
 *
 * --- 이 레이어가 하는 일 ----------------------------------------------------
 *   버스는 프레임 안에서만 돈다. 프레임 경계를 넘는 건 postMessage 뿐이고,
 *   그 변환을 여기서만 한다. 밖에서 들어온 명령은 cmd:* 로 풀어 버스에 흘리고,
 *   안에서 나가는 사실(stat, units:list, export:ready)은 최상위로 중계한다.
 *
 * --- 왜 명령을 해석하지 않는가 ----------------------------------------------
 *   전에는 handleCmd 하나가 청킹·녹화·오버레이·패널을 전부 직접 호출했다.
 *   전송 계층이 도메인 로직을 전부 알고 있으니, 통신 코드를 건드릴 때마다
 *   전 기능을 다시 검증해야 했다.
 *   지금은 "누가 primary인가"만 알고, 나머지는 각 모듈이 자기 명령을 구독한다.
 *   그래서 각 모듈은 primary 개념 자체를 몰라도 된다.
 *
 * --- primary 선출 -----------------------------------------------------------
 *   전 프레임에 주입된 뒤 각자 스캔하고, 유닛이 가장 많은 프레임 1개를 고른다.
 *   (네이버 블로그: 본문이 #mainFrame iframe 안 → 그 프레임이 primary)
 *   패널은 최상위 프레임에만 뜨므로, primary 가 iframe 이면 통계·목록·payload 가
 *   전부 이 중계를 타고 올라온다.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus, IS_TOP, TAG } = RBC;

  // --- 소유 상태 ---
  let isPrimary = IS_TOP;      // 선출 전까지의 잠정값. 단일 프레임 페이지면 이게 맞다.
  let primaryTag = null;
  const seenMsg = new Set();

  let scanBucket = [];
  let scanTimer = null;
  let scanTries = 0;

  // ==========================================================================
  // 전송
  // ==========================================================================
  function toChildren(msg) {
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage(msg, '*'); } catch (e) { /* noop */ }
    }
  }

  function toTop(msg) {
    try { window.top.postMessage(Object.assign({ __rbc: 1, tag: TAG }, msg), '*'); }
    catch (e) { /* noop */ }
  }

  function send(cmd, extra) {
    const msg = Object.assign(
      { __rbc: 1, cmd, id: Math.random().toString(36).slice(2) }, extra || {});
    handleCmd(msg);            // 자기 프레임에도 적용
    seenMsg.add(msg.id);
    toChildren(msg);
    if (seenMsg.size > 1000) seenMsg.clear();   // 장시간 세션에서 무한 증가 방지
  }

  // ==========================================================================
  // 명령 해석 — primary 게이트만 걸고 버스로 넘긴다
  // ==========================================================================
  function handleCmd(m) {
    switch (m.cmd) {
      case 'scan':
        bus.emit('cmd:scan');                   // primary 아닌 프레임도 돈다 (선출 근거)
        break;
      case 'primary':
        isPrimary = (m.tag === TAG);
        bus.emit('primary:changed', { isPrimary });
        if (!isPrimary) bus.emit('cmd:overlay', { on: false });
        break;

      // 전 프레임이 알아야 하는 것
      case 'focus':    bus.emit('cmd:focus', m); break;      // [C2]
      case 'activity': bus.emit('cmd:activity'); break;      // [C5]
      case 'query':    bus.emit('cmd:query', m); break;      // [C8]

      case 'chunk':
        if (RBC.recorder.isRecording()) break;               // BUG-1
        if (isPrimary) bus.emit('cmd:chunk', m);
        break;

      // primary 전용
      case 'start':   if (isPrimary) bus.emit('cmd:start', m); break;
      case 'stop':    if (isPrimary) bus.emit('cmd:stop'); break;
      case 'overlay': if (isPrimary) bus.emit('cmd:overlay', m); break;
      case 'list':    if (isPrimary) bus.emit('cmd:list'); break;
      case 'export':  if (isPrimary) bus.emit('cmd:export'); break;
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.__rbc !== 1) return;
    if (m.cmd) {
      if (m.id && seenMsg.has(m.id)) return;
      if (m.id) seenMsg.add(m.id);
      handleCmd(m);
      toChildren(m);                     // 중첩 프레임까지 전파
      return;
    }
    // 응답은 최상위만 처리한다.
    if (!IS_TOP) return;
    if (m.res === 'scan') collectScan(m);
    else if (m.res === 'stat') bus.emit('stat', m);
    else if (m.res === 'export') download(m.payload);
    else if (m.res === 'list') bus.emit('units:list', m.list);
    else if (m.res === 'autostop') bus.emit('record:stopped', { reason: 'idle' });
  });

  // ==========================================================================
  // 스캔 + primary 선출
  //   주의: onclick 에 doScan 을 직접 넣으면 이벤트 객체가 auto 인자로 들어가
  //         재시도 카운터가 리셋되지 않는다. 호출부는 doScan() 으로 부를 것.
  // ==========================================================================
  function doScan(auto) {
    if (!IS_TOP) return;                            // 선출은 최상위가 주관한다
    if (RBC.recorder.isRecording()) return;         // BUG-1/2: 기록 중 재스캔 금지
    if (auto && scanTries >= CFG.SCAN_RETRY_MAX) return;
    if (!auto) scanTries = 0;

    scanBucket = [];
    clearTimeout(scanTimer);
    send('scan');

    scanTimer = setTimeout(() => {
      if (!scanBucket.length) {
        if (scanTries < CFG.SCAN_RETRY_MAX) {
          scanTries++;
          bus.emit('scan:progress', { tries: scanTries, max: CFG.SCAN_RETRY_MAX });
          setTimeout(() => doScan(true), CFG.SCAN_RETRY_MS);
        } else {
          bus.emit('scan:failed');
        }
        return;
      }
      scanTries = 0;
      scanBucket.sort((a, b) => b.units - a.units || b.chars - a.chars);
      const win = scanBucket[0];
      primaryTag = win.tag;

      send('primary', { tag: primaryTag });
      send('focus', { on: !document.hidden && document.hasFocus() });   // [C2] 초기 동기화
      const q = RBC.recorder.query();                                    // [C8]
      if (q) send('query', { q });

      bus.emit('scan:done', {
        frames: scanBucket.length,
        tag: win.tag,
        isSelf: win.tag === TAG,
        units: win.units,
        chars: win.chars,
      });
    }, CFG.SCAN_COLLECT_MS);
  }

  function collectScan(m) {
    if (m.units > 0) scanBucket.push(m);
  }

  // ==========================================================================
  // export 저장
  //   최상위 프레임에서만 실제로 파일이 떨어진다.
  // ==========================================================================
  function download(payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const sid = (payload.meta.sessionId || 'nosid').slice(0, 8);
    a.download = `rbc_${sid}_${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ==========================================================================
  // 구독 — 안에서 나가는 사실을 최상위로 중계
  // ==========================================================================

  // 2-units 가 스캔을 마치면 선출의 입력이 된다.
  bus.on('units:scanned', (d) => {
    const info = { tag: TAG, units: d.count, href: location.href, chars: d.chars };
    if (IS_TOP) collectScan(info); else toTop(Object.assign({ res: 'scan' }, info));
  });

  bus.on('units:list', (list) => { if (!IS_TOP) toTop({ res: 'list', list }); });
  bus.on('stat', (s) => { if (!IS_TOP) toTop(s); });

  bus.on('export:ready', (payload) => {
    if (IS_TOP) download(payload); else toTop({ res: 'export', payload });
  });

  // 자동 종료는 최상위 패널이 알아야 버튼이 돌아온다.
  bus.on('record:stopped', (d) => {
    if (!IS_TOP && d && d.reason === 'idle') toTop({ res: 'autostop' });
  });

  // 최상위의 활동·포커스를 하위 프레임으로 브로드캐스트한다.
  bus.on('activity', () => send('activity'));
  bus.on('focus:broadcast', (d) => send('focus', { on: d.on }));

  // ==========================================================================
  // 공개
  // ==========================================================================
  RBC.frames = {
    send,
    doScan,
    isPrimary: () => isPrimary,
    primaryTag: () => primaryTag,
  };
})();