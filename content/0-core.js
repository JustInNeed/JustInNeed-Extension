/* =============================================================================
 * 0-core.js — 네임스페이스 · 이벤트 버스 · 설정 · 순수 유틸
 *
 * 소유: CFG, IS_TOP, TAG, bus, util
 * 의존(직접 호출): 없음 (최하위 레이어)
 * 발행: 없음   구독: 없음
 *
 * 이 파일에는 상태가 없다. DOM도 안 건드린다.
 * 다른 모든 파일이 여기에 의존하므로 manifest의 js 배열 맨 앞에 와야 한다.
 *
 * --- 규칙 ------------------------------------------------------------------
 *   직접 호출은 "명령"이고 큰 번호 → 작은 번호 방향으로만 한다.
 *   버스 이벤트는 "사실 통보"이고 방향 제약이 없다.
 *   버스는 프레임 안에서만 돈다. iframe 경계를 넘는 건 6-frames.js의 postMessage.
 * ========================================================================== */
(() => {
  'use strict';

  // 같은 프레임에 두 번 주입된 경우. 기존 인스턴스를 살려두고 2회차는 전부 빠진다.
  // (나머지 파일은 전부 맨 위에서 RBC.dup 을 확인한다)
  if (window.RBC) { window.RBC.dup = true; return; }

  // ==========================================================================
  // CONFIG
  //   TODO(Step 2): TARGET_CHARS / MIN_CHARS / MAX_CHARS / MIN_UNIT_CHARS 는
  //   패널 슬라이더가 런타임에 덮어쓰는 가변값이다. const 객체 안에 불변값과
  //   섞여 있는 게 BUG-1의 배경이었다. 2-units.js 를 만들 때 RBC.chunkOpts 로
  //   분리한다. 지금 옮기면 content.js 쪽도 같이 고쳐야 해서 Step 1의 변경
  //   범위가 넓어지므로 미룬다.
  // ==========================================================================
  const CFG = {
    SCHEMA_VERSION: 2,        // [C9]
    TICK_MS: 150,             // 마스터 클럭
    CENTER_RATIO: 0.49,       // GVAM 중앙선 (뷰포트 세로 비율)

    // --- 청킹 ---
    TARGET_CHARS: 200,
    MIN_CHARS: 110,
    MAX_CHARS: 340,
    MIN_UNIT_CHARS: 15,

    // --- 히트 테스트 ---
    CENTER_Y_TOL: 44,         // 중앙선이 여백에 걸렸을 때 허용할 세로 거리(px)
    EDGE_Y_TOL: 8,            // [C1] 뷰포트 가장자리 탐색은 엄격하게
    EDGE_STEPS: 8,            // [C1] 가장자리에서 안쪽으로 몇 번 찔러볼지
    CURSOR_TOL: 3,

    MIN_ROOT_TEXT: 200,
    STAT_EVERY: 4,

    // --- 스캔 / DOM 감시 ---
    FIRST_SCAN_DELAY: 600,
    SCAN_COLLECT_MS: 400,
    SCAN_RETRY_MAX: 5,
    SCAN_RETRY_MS: 1500,
    MUTATION_DEBOUNCE: 800,
    MUTATION_DEBOUNCE_REC: 5000,
    RESCAN_MIN_GAP_REC: 15000,

    // --- 세션 ---
    IDLE_TIMEOUT_MS: 30 * 60 * 1000,   // [C5] 30분 무동작 → 자동 종료
    ACTIVITY_PING_MS: 5000,            // [C5] 최상위 프레임의 활동을 primary에 알리는 주기

    PANEL_ID: 'rbc-panel',
  };

  // ==========================================================================
  // 프레임 식별
  // ==========================================================================
  const IS_TOP = (() => { try { return window.top === window; } catch (e) { return false; } })();
  const TAG = Math.random().toString(36).slice(2, 7);

  // ==========================================================================
  // 이벤트 버스
  //   한 프레임 안에서만 동작한다. 구독자가 던진 예외는 삼키고 로그만 남긴다
  //   (한 구독자가 터져서 틱 전체가 멈추면 안 되므로).
  //   디버깅: 콘솔에서 RBC.bus.debug = true
  // ==========================================================================
  const bus = (() => {
    const map = new Map();
    const api = {
      debug: false,
      on(ev, fn) {
        if (!map.has(ev)) map.set(ev, []);
        map.get(ev).push(fn);
      },
      emit(ev, data) {
        if (api.debug) console.log('[RBC bus]', TAG, ev, data);
        const list = map.get(ev);
        if (!list) return;
        for (const fn of list) {
          try { fn(data); } catch (e) { console.error('[RBC]', ev, e); }
        }
      },
      // 분할 중에 "이 이벤트를 아무도 안 듣고 있나?" 확인용
      listeners(ev) { return (map.get(ev) || []).length; },
    };
    return api;
  })();

  // ==========================================================================
  // 순수 유틸 — 상태를 안 읽고 안 쓴다
  // ==========================================================================

  // 원본 content.js 의 이 두 정규식에는 눈에 보이지 않는 U+200B(제로폭 공백)가
  // 문자 클래스 안에 직접 들어 있었다. 동작은 같지만 편집기에서 실수로 지우면
  // 조용히 깨지므로 \u200B 이스케이프로 바꿨다. 동작은 완전히 동일하다.
  const WS = /[\s\u200B]/;
  const WS_RUN = /[\s\u200B]+/g;

  function isWs(ch) { return ch !== undefined && WS.test(ch); }
  function clean(s) { return s.replace(WS_RUN, ' ').trim(); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function hash(str) {                       // FNV-1a → base36
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  function uuid() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* noop */ }
    return 'sid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // [C8] referrer가 검색 결과 페이지면 쿼리를 뽑는다.
  //      단, Referrer-Policy 때문에 origin만 오는 사이트가 많다 → 실패 시 패널 입력으로 보완.
  const SEARCH_HOSTS = /(^|\.)(google|bing|duckduckgo|daum|naver|yahoo|search\.brave)\./i;
  const SEARCH_KEYS = ['q', 'query', 'p', 'wd', 'text', 'keyword'];

  function searchQueryFromReferrer() {
    try {
      if (!document.referrer) return null;
      const u = new URL(document.referrer);
      if (!SEARCH_HOSTS.test(u.hostname)) return null;
      for (const k of SEARCH_KEYS) {
        const v = u.searchParams.get(k);
        if (v && v.trim()) return v.trim();
      }
    } catch (e) { /* noop */ }
    return null;
  }

  // ==========================================================================
  // 공개
  // ==========================================================================
  window.RBC = {
    version: 'v2.2-split-step1',
    dup: false,
    CFG,
    IS_TOP,
    TAG,
    bus,
    util: { isWs, clean, esc, hash, uuid, searchQueryFromReferrer },
  };
})();