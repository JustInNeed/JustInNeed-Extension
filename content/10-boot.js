/* =============================================================================
 * 10-boot.js — 부팅
 *
 * 소유: 없음
 * 의존(직접 호출): 0-core, 6-frames
 * 발행: 없음   구독: 없음
 *
 * --- 여기 남은 것이 이렇게 적은 이유 ----------------------------------------
 *   전에는 init() 이 리스너 등록·패널 렌더·옵저버 부착·첫 스캔을 다 했다.
 *   지금은 각 파일이 자기 것을 자기가 건다 — 4-input 은 DOM 리스너를,
 *   7-observer 는 MutationObserver 를, 9-panel 은 자기 자신을.
 *   그래서 부팅에 남는 건 "언제 첫 스캔을 돌릴 것인가" 하나뿐이다.
 *
 * --- 왜 첫 스캔만 지연시키나 -------------------------------------------------
 *   run_at 이 document_idle 이라 대개 DOM 은 이미 있다. 그래도 본문이
 *   늦게 붙는 사이트가 있어 FIRST_SCAN_DELAY 만큼 기다린다.
 *   그때도 못 잡으면 6-frames 의 재시도와 7-observer 의 복구가 받는다.
 *   최상위 프레임만 스캔을 주관한다(doScan 안에서 걸러진다).
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG } = RBC;

  function boot() {
    setTimeout(() => RBC.frames.doScan(), CFG.FIRST_SCAN_DELAY);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();