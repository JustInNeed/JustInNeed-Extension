/* =============================================================================
 * 1-stream.js — 본문 루트 탐색 + 텍스트 스트림 구축
 *
 * 소유: raw, sig, segs, nodeIndex, breaks, contentRoot
 * 의존(직접 호출): 0-core
 * 발행: 없음   구독: 없음
 *
 * --- 이 레이어가 하는 일 ----------------------------------------------------
 *   TreeWalker로 본문 영역의 텍스트 노드를 DOM 순서대로 전부 모아
 *   하나의 긴 문자열(raw)과 [노드, 시작오프셋] 인덱스(segs)를 만든다.
 *   셀렉터를 쓰지 않는다. <p>든 <br>이든 <span>이든 전부 동일하게 처리한다.
 *
 *   여기서는 자르지 않는다. 청킹은 2-units.js 의 일이다.
 *   이 분리가 load-bearing 인 이유: "무엇을 본문으로 볼 것인가"(여기)와
 *   "본문을 어떻게 자를 것인가"(2-units)는 서로 다른 이유로 바뀐다.
 *
 * --- sig 가 뭔가 -----------------------------------------------------------
 *   sig[i] = raw의 0..i 구간에 있는 "의미 있는 글자 수" 누적값.
 *   연속 공백을 1글자로 세므로, 공백투성이 마크업에서도 청킹이 일정해진다.
 *   청킹 루프가 글자 단위로 sig[i] 를 수만 번 읽기 때문에
 *   접근자 함수로 감싸지 않고 배열을 그대로 노출한다.
 *
 * --- 입력 필드 제외 [0-5] — 여기까지만 한다 ---------------------------------
 *   막는 것: 네이티브 입력 태그(INPUT/TEXTAREA/SELECT/BUTTON/OPTION)와
 *            role="searchbox|combobox|spinbutton" 인 검색·선택 위젯.
 *   검색어와 로그인 아이디는 여기서 전부 걸린다. TEXTAREA/SELECT 는 원래부터
 *   있었고, INPUT 은 value 도 placeholder 도 텍스트 노드가 아니라 사실상
 *   no-op 이지만 자식 텍스트로 흉내내는 구현을 대비해 명시해 둔다.
 *
 *   막지 않는 것: contenteditable.
 *   이유는 실측이다. 노션 문서 한 페이지에 [contenteditable="true"] 가 130개다.
 *   블록마다 편집 가능이라 "편집 가능 = 입력창"으로 보면 문서 전체가 사라진다.
 *   위키·사내 문서 도구 상당수가 같은 구조다. "유튜브·인스타 같은 소수를 빼면
 *   모든 텍스트 사이트에서 수집한다"는 목표와 정면으로 충돌한다.
 *
 *   beforeinput 으로 "이번 세션에 실제로 타이핑한 편집 영역"만 빼는 안도
 *   만들어봤다가 뺐다. 블록마다 contenteditable 인 노션에서는 입력한 블록만
 *   빠져서 잘 도는데, 문서 전체를 contenteditable 하나로 감싸는 에디터에서는
 *   한 글자 입력에 문서 전체가 빠진다. 조용히 유닛 0개가 되는 종류의 실패라
 *   사이트별로 확인하기 전에는 켤 수 없다.
 *
 *   그래서 남아 있는 노출은 하나다: 리치텍스트(contenteditable) 댓글창이
 *   contentRoot 안에 있는 경우. findContentRoot 가 article/main 을 먼저
 *   고르고 댓글 영역은 보통 그 바깥이라 실제로 걸리는 경우가 드물다.
 *   확정 정책은 제외 URL 설정 + 원문 저장 범위와 함께 따로 정한다.
 *   (claude/0-5-입력텍스트-제외-검토.md)
 * ========================================================================== */
(() => {
  'use strict';
  const RBC = window.RBC;
  if (!RBC || RBC.dup) return;
  const { CFG } = RBC;
  const { isWs } = RBC.util;

  // --- 이 파일이 소유하는 상태 ---
  let raw = '';
  let sig = new Int32Array(1);
  let segs = [];
  let nodeIndex = new Map();
  let breaks = new Set();
  let contentRoot = null;

  // ==========================================================================
  // 태그 분류
  //   SKIP_TAGS  = 본문이 아닌 것. 통째로 건너뛴다.
  //   BLOCK_TAGS = 블록 경계. 여기가 바뀌면 청킹의 1순위 절단 후보가 된다.
  // ==========================================================================
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG',
    'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO', 'SELECT', 'TEXTAREA', 'BUTTON',
    'NAV', 'HEADER', 'FOOTER', 'ASIDE',
    // [0-5] INPUT 의 value 는 텍스트 노드가 아니라 원래도 안 잡히지만,
    //   placeholder 를 자식 텍스트로 흉내내는 구현이 있어 명시해 둔다.
    'INPUT', 'OPTION', 'OPTGROUP']);

  // [0-5] 검색·선택 위젯 role. div 로 만든 검색창이 여기 걸린다.
  //   'textbox' 는 일부러 뺐다 — 문서 편집기가 본문 블록에 쓰는 경우가 있어서,
  //   넣으면 노션류 사이트가 통째로 빠진다.
  const WIDGET_ROLES = new Set(['searchbox', 'combobox', 'spinbutton']);

  function isExcluded(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute) {
      const role = el.getAttribute('role');
      if (role && WIDGET_ROLES.has(role.trim().toLowerCase())) return true;
    }
    return false;
  }

  // ==========================================================================
  // 본문 루트 찾기
  //   innerText 가 아니라 textContent 를 쓴다. innerText 는 요소마다 강제
  //   레이아웃을 유발해서, 노션처럼 요소가 많은 페이지에서 수 초가 걸린다.
  // ==========================================================================
  function textLen(el) {
    let n = (el.textContent || '').length;
    el.querySelectorAll('script,style,noscript').forEach(s => {
      n -= (s.textContent || '').length;
    });
    return Math.max(n, 0);
  }

  function findContentRoot() {
    for (const sel of ['article', 'main', '[role="main"]']) {
      const el = document.querySelector(sel);
      if (el && textLen(el) > CFG.MIN_ROOT_TEXT) return el;
    }
    // 시맨틱 태그가 없으면 "텍스트는 많고 링크는 적은" 요소를 고른다.
    // 링크 비율로 깎는 이유: 사이드바·추천목록은 텍스트 길이만 보면 본문을 이긴다.
    let best = document.body || document.documentElement, bestScore = -1;
    const pool = (document.body || document.documentElement)
      .querySelectorAll('div, section, article, main, td');
    pool.forEach((el) => {
      if (el.id === CFG.PANEL_ID || el.closest('#' + CFG.PANEL_ID)) return;
      const len = textLen(el);
      if (len < CFG.MIN_ROOT_TEXT) return;
      let linkLen = 0;
      el.querySelectorAll('a').forEach(a => { linkLen += (a.textContent || '').length; });
      const score = len * (1 - Math.min(linkLen / (len + 1), 1));
      if (score > bestScore) { bestScore = score; best = el; }
    });
    return best;
  }

  // ==========================================================================
  // 텍스트 스트림 구축
  // ==========================================================================
  function nearestBlock(node) {
    let el = node.parentElement;
    while (el && el !== document.documentElement) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // 커밋하지 않고 새 스트림만 만들어 돌려준다.
  // "이번 스캔 결과가 이전 것의 순수한 append 인가"를 2-units 가 판단해야 하므로,
  // 만드는 것과 반영하는 것을 분리한다.
  function build() {
    contentRoot = findContentRoot();
    const root = contentRoot;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === 1) {
            const el = node;
            if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
            if (el.id === CFG.PANEL_ID) return NodeFilter.FILTER_REJECT;
            if (el.getAttribute && el.getAttribute('aria-hidden') === 'true')
              return NodeFilter.FILTER_REJECT;
            if (isExcluded(el)) return NodeFilter.FILTER_REJECT;   // [0-5]
            if (el.tagName === 'BR') return NodeFilter.FILTER_ACCEPT;
            return NodeFilter.FILTER_SKIP;
          }
          if (!node.data || !node.data.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const newSegs = [];
    const newBreaks = new Set();
    const parts = [];
    let len = 0;
    let pendingBreak = true;
    let lastBlock = null;
    let n;

    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) { pendingBreak = true; continue; }  // <br>
      const blk = nearestBlock(n);
      if (blk !== lastBlock) pendingBreak = true;
      lastBlock = blk;

      const r = document.createRange();
      r.selectNodeContents(n);
      const rect = r.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;   // display:none / 0px

      if (pendingBreak) newBreaks.add(len);
      newSegs.push({ node: n, start: len, len: n.data.length });
      parts.push(n.data);
      len += n.data.length;
      pendingBreak = false;
    }

    return { raw: parts.join(''), segs: newSegs, breaks: newBreaks };
  }

  function buildSig(s) {
    const a = new Int32Array(s.length + 1);
    let c = 0, prevWs = true;
    for (let i = 0; i < s.length; i++) {
      if (isWs(s[i])) { if (!prevWs) c++; prevWs = true; }
      else { c++; prevWs = false; }
      a[i + 1] = c;
    }
    return a;
  }

  function commit(built) {
    raw = built.raw;
    segs = built.segs;
    breaks = built.breaks;
    sig = buildSig(raw);
    nodeIndex = new Map();
    for (const s of segs) nodeIndex.set(s.node, s);
  }

  // ==========================================================================
  // 공개
  // ==========================================================================
  RBC.stream = {
    build,                              // → {raw, segs, breaks}  (커밋 안 함)
    commit,                             // 커밋 + sig 재계산

    raw: () => raw,
    len: () => raw.length,
    sig: () => sig,                     // 배열 그대로. 청킹 hot loop 때문.
    breaks: () => breaks,
    segs: () => segs,
    segFor: (node) => nodeIndex.get(node),
    root: () => contentRoot,
  };
})();
