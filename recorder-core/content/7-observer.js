/* =============================================================================
 * 7-observer.js — DOM 변경 감시
 *
 * 소유: mo, moTarget, mutTimer, firstMutAt, lastRescanAt
 * 의존(직접 호출): 0-core, 1-stream, 2-units, 5-recorder, 6-frames
 * 발행: 없음
 * 구독: units:changed
 *
 * --- 목적은 무한스크롤 대응이 아니다 ---------------------------------------
 *   (1) 첫 스캔이 너무 일렀을 때의 복구 — 이게 주 목적이다.
 *       페이지 로드 600ms 뒤 자동 스캔인데 그 시점에 본문이 아직 없으면
 *       (클라이언트 렌더링, 늦게 오는 iframe, 느린 네트워크) 스트림이 빈 채로
 *       굳는다. 복구 경로가 없으면 사용자가 수동으로 스캔을 누르기 전까지
 *       그 페이지는 데이터가 통째로 없다.
 *   (2) 본문 뒤에 내용이 덧붙는 경우의 꼬리 청킹.
 *
 *   글자 기준 유닛이라 이미지 lazy-load 에는 면역이다. 레이아웃이 밀려도
 *   스트림 문자열이 안 바뀌므로 아무 일도 일어나지 않는다.
 *
 * --- 감시 범위를 옮기는 이유 -------------------------------------------------
 *   첫 스캔 전에는 document 전체를 봐야 '늦게 도착하는 본문'을 잡는다.
 *   본문 루트가 정해진 뒤에는 그 안으로 좁혀 광고 노이즈를 끊는다.
 *   최초 observe 시점엔 본문 루트가 아직 null 이므로, 스캔 성공 후
 *   disconnect → 재 observe 하는 retarget 이 필요하다. 한 번만 걸면 무효가 된다.
 *
 * --- 기록 중 부하 억제 -------------------------------------------------------
 *   characterData 는 감시하지 않는다 (시계 위젯 하나로도 초당 콜백이 튄다).
 *   디바운스 · 재스캔 최소 간격을 둔다. stream.build() 는 TreeWalker 전체 순회라 너무 잦으면 틱이 흔들린다.
 *
 * --- 언제 재스캔하나 (0-B, 2026-10-08 고침) -------------------------------------
 *   예약 시각 = max( min(마지막 변경 + 디바운스, 첫 변경 + MAX_WAIT), 직전 재스캔 + 최소 간격 ).
 *   전에는 두 가지 버그가 있었다:
 *     (1) 최소 간격 안에 온 변경은 재스캔을 예약하지 않고 버렸다 → 그 뒤 변경이 또 와야 반영됐다.
 *         노션 토글을 연 직후 아무것도 안 하면 열린 내용이 끝까지 유닛이 안 될 수 있었다.
 *     (2) 디바운스가 변경마다 다시 시작돼, 변경이 끊이지 않는 페이지에선 재스캔이 영영 안 왔다.
 *   기록 중 값도 5초/15초 → 0.7초/1.5초로 줄였다(0-core). 기록 중 재스캔은 splice 라 바뀐 구간만 다시 자른다.
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG, bus } = RBC;

  let mutTimer = null;
  let lastRescanAt = 0;
  let mo = null, moTarget = null;

  function retarget() {
    if (!mo) return;
    const root = RBC.stream.root();
    const target = (RBC.units.count() && root) ? root : document.documentElement;
    if (moTarget === target) return;
    mo.disconnect();
    moTarget = target;
    mo.observe(target, { childList: true, subtree: true, characterData: false });
  }

  // 기록 중이 아닐 때도 재청킹 최소 간격을 둔다. 광고·애니메이션이 많은
  // 페이지에서는 DOM 변경이 끊이지 않아서, 간격이 없으면 800ms마다 스트림
  // 전체를 다시 훑게 된다. 대기 상태에서 그만큼 자주 다시 자를 이유가 없다.
  const RESCAN_MIN_GAP_IDLE = 3000;

  let firstMutAt = 0;                // 이번 묶음의 첫 변경 시각 (재스캔하면 0)

  function fire() {
    mutTimer = null;
    firstMutAt = 0;
    if (!RBC.units.count()) {
      // 이 프레임에 본문이 없다. 여기서 재청킹할 것도 없고, 복구 스캔은
      // "아직 아무 프레임도 선출되지 않았을 때"만 돈다.
      //
      // primaryTag 를 안 보고 units.count() 만 보면, iframe 사이트
      // (네이버 블로그의 #mainFrame)의 최상위 프레임에서 무한 반복이 된다.
      // 거기선 본문이 없는 게 정상 상태인데 조건이 계속 참이고, 스캔이
      // 성공할 때마다 scanTries 가 0 으로 리셋돼 재시도 상한도 안 걸린다.
      // 증상: 패널이 scan:done 과 stat 사이를 초당 몇 번씩 왕복.
      if (!RBC.frames.primaryTag()) RBC.frames.doScan(true);
      return;
    }
    lastRescanAt = Date.now();
    RBC.units.rescan({ preserve: true });
  }

  mo = new MutationObserver(() => {
    const recording = RBC.recorder.isRecording();
    const now = Date.now();
    if (!firstMutAt) firstMutAt = now;
    const debounce = recording ? CFG.MUTATION_DEBOUNCE_REC : CFG.MUTATION_DEBOUNCE;
    const gap = recording ? CFG.RESCAN_MIN_GAP_REC : RESCAN_MIN_GAP_IDLE;
    const due = Math.max(Math.min(now + debounce, firstMutAt + CFG.MUTATION_MAX_WAIT), lastRescanAt + gap);
    clearTimeout(mutTimer);
    mutTimer = setTimeout(fire, Math.max(0, due - now));
  });

  // [R1] 전: rescan() 이 retargetObserver() 를 직접 호출했다.
  bus.on('units:changed', retarget);

  retarget();                       // 최초 부착 (이 시점엔 document 전체)

  RBC.observer = { retarget };
})();