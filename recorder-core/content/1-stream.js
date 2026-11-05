/* =============================================================================
 * 1-stream.js — 본문 루트 탐색 + 텍스트 스트림 구축
 *
 * 소유: raw, sig, segs, nodeIndex, breaks, contentRoot, art(본문 상자 판정), noiseMin, unfolded(노션 펼치기, #37)
 * 의존(직접 호출): 0-core, vendor/readability.js (전역 Readability)
 * 발행: unfold:lost(#37)   구독: record:started, record:stopped
 *
 * --- 본문 상자 판정 = noise (Readability, #11, 2026-10-28) ---------------------
 *   noise 정의(10-10 서현): 본문 루트 밖이 섞인 것만. 루트 안 글(끝인사 · 크레딧 · 관련 글 링크)은 noise 아님.
 *   여기서 "본문 루트"는 우리가 고른 루트(contentRoot)가 아니라 진짜 기사 본문이다 — 폴백 루트가 관련 기사 ·
 *   기자 박스까지 크게 잡힐 때 그 섞인 부분을 표시하려는 것. 루트 · 스트림 · 청킹은 이 판정과 무관하게 그대로다.
 *   - Readability 의 "정리된 결과"는 안 쓰고, 본문으로 "고른 상자(요소)"만 쓴다. Readability 는 본문 안의
 *     바이라인 · 관련 링크 · 캡션도 지우는데 그건 정의상 noise 가 아니다. 상자 안 = 본문, 상자 밖 = noise.
 *   - Readability 는 문서를 직접 고치므로 복사본에서 돈다. 상자를 원본에서 되찾는 법: 복사 직전 원본 요소를
 *     문서 순서로 줄 세우고, 복사본 요소에 같은 순서 번호(data-rbc-i)를 붙인다. 이 둘은 쉬는 틈 없이 한 번에
 *     실행되므로 그 사이에 페이지가 바뀔 수 없다. 결과에서 번호 붙은 가장 바깥 요소들 = 상자, 번호로 원본을 찾는다.
 *     번호는 속성이라 Readability 가 태그를 바꾸거나(_setNodeTag 가 속성 복사) HTML 문자열로 되돌려 재시도해도 남는다.
 *     원본 페이지에는 아무것도 쓰지 않는다(쓰면 7-observer 가 재스캔한다).
 *   - 되찾은 뒤 대조: 복사본 상자에 남은 글 표본이 원본 상자 글에 다 들어 있어야 한다. 아니면 실패.
 *   - 플랫폼 지정 루트(how: site) = 루트가 곧 본문(§6 결정) → Readability 를 안 돌리고 전부 본문.
 *   - 루트 글자 중 상자 안 비율 < noiseMin 이면 엉뚱한 곳을 고른 것으로 보고 미판정. noiseMin 은 근거 없는
 *     임시값 — 패널 슬라이더로 바꾼다(기록 중 잠김, 청킹과 같은 길).
 *   - 실패 · 미판정이면 조각에 noise 필드를 안 쓴다(없음 = 미판정, v3 그대로). 이유는 원문 그대로 art.why → 패널.
 *   언제 다시 판정하나: 조각을 새로 만들 때만(inArticle), 그중 루트가 바뀌었거나 상자가 DOM 에서 빠졌을 때,
 *   그리고 기록 중이 아닐 때 본문 글이 바뀌었을 때. 패널 · 오버레이(article)는 마지막 판정을 읽기만 한다.
 *   기록 중에는 처음 판정을 유지한다 — 새로 생긴 유닛도 같은 상자로 본다(한 구간 안 기준이 섞이지 않게).
 *   예외: 기록 중 상자가 DOM 에서 빠지면(SPA 재렌더) 다음 새 조각 때 다시 판정한다 — 그 결과가 실패면
 *   그 뒤 조각만 noise 필드가 없다(앞 조각은 그대로). 유지 단위는 구간(record:started ~ stopped).
 *   알려진 비용: 유닛이 있는 프레임은 primary 가 아니어도(광고 iframe 등) 스캔 때 판정이 돈다 — 스캔이 primary
 *   선출 전에 모든 프레임에서 돌기 때문. 기록 안 할 때 루트 글이 자주 바뀌는 페이지는 재스캔마다(최소 3초 간격) 다시 돈다.
 *
 * --- seg 하나 = 텍스트 노드 하나 (v3) -----------------------------------------
 *   { node, start, len, blk, link }
 *     blk  = 가장 가까운 DOM 블록 (nearestBlock). 2-units 가 이 값이 바뀌는 지점에서
 *            유닛을 조각으로 나눈다 (감사 §8-4). <br> 은 조각 경계가 아니다.
 *     link = <a> 안 텍스트인가. 스캔 때 한 번만 본다 (틱 비용 0).
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
 * --- 숨은 글자도 넣는다 (2026-10-05, 팀 결정) ------------------------------
 *   display:none 등으로 크기가 0 인 텍스트 노드도 스트림에 넣는다. 전에는 build() 가
 *   노드마다 사각형을 재서 크기 0 을 뺐는데, 그러면 창 폭 · 확대에 따라 반응형 레이아웃이
 *   숨기는 글이 달라져 같은 글의 pid 가 참가자마다 달라졌다 (인수인계 §5). 이제 스트림은
 *   DOM 과 elementFilter 만으로 정해지고 화면 배치와 무관하다.
 *   - 숨은 글이 실제로 보였는지는 매 틱 tick.vis 가 말한다. 숨은 조각은 사각형이 0 이라
 *     3-hittest 의 vis 조건(bottom > 0)에서 빠지고, 드러나면(광고 닫기 · "더보기") 그 틱부터 나온다.
 *   - 본문 아닌 숨은 글(접힌 메뉴 · 모바일 전용 중복 · 스크린리더 전용 글)은 noise 판정 몫.
 *   - 가려진 글(광고 · sticky 에 덮임)은 크기가 0 이 아니라 원래도 이 규칙과 무관했다.
 *   - aria-hidden="true" 제외는 유지 (DOM 속성이라 화면 배치와 무관).
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
  /* global Readability */
  const { CFG, bus } = RBC;
  const { isWs } = RBC.util;

  // --- 이 파일이 소유하는 상태 ---
  let raw = '';
  let sig = new Int32Array(1);
  let segs = [];
  let nodeIndex = new Map();
  let breaks = new Set();
  // 벽(wall): 앞 블록과 부모가 다른 블록이 시작하는 위치 (0-B 유닛 안정, 2026-10-08).
  //   청킹은 벽을 넘어 합치지 않는다. 노션처럼 블록마다 감싸고 토글을 열면 DOM 에 새 블록을 끼우는 사이트에서,
  //   기존 유닛 안으로 글이 끼는 일이 없어 기존 유닛 · pid 가 그대로 남는다.
  //   **플랫폼 지정 루트(SITE_ROOTS 의 walls: true)일 때만** 쓴다. 일반 사이트에 켜면 네이버 뉴스 기준선이
  //   22 → 23 으로 바뀌었다(캡션 등 다른 부모 줄이 따로 떨어짐). 티스토리 · 네이버 블로그의 접은글은 CSS 로만
  //   숨겨 글이 처음부터 스트림에 있으므로 끼어듦 자체가 없다.
  let walls = [];
  let contentRoot = null;
  let rootInfo = null;       // 루트를 왜 골랐나 — { how, sel, len, link, el }. 패널 · meta.root

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

  // [0-5] 적용 때 SKIP_TAGS 블록을 고치면서 이 정의가 같이 지워졌었다.
  // nearestBlock() 이 텍스트 노드마다 부르므로, 없으면 스캔이 매번
  // ReferenceError 로 죽고 유닛이 0개가 된다. content.js 원본 그대로 복원.
  const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD',
    'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV',
    'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH',
    'THEAD', 'TR', 'UL']);

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

  // 요소를 스트림에 넣을지. build() 와 measure() 가 같이 쓴다 — 루트를 고르는
  // 잣대와 실제로 뽑는 잣대가 달라서 헤럴드경제가 유닛 1개가 됐다(감사 §6-F).
  function elementFilter(el) {
    if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
    if (el.id === CFG.PANEL_ID) return NodeFilter.FILTER_REJECT;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true')
      return NodeFilter.FILTER_REJECT;
    if (isExcluded(el)) return NodeFilter.FILTER_REJECT;   // [0-5]
    return NodeFilter.FILTER_SKIP;
  }

  // ==========================================================================
  // 본문 루트 찾기
  //   innerText 가 아니라 textContent 를 쓴다. innerText 는 요소마다 강제
  //   레이아웃을 유발해서, 노션처럼 요소가 많은 페이지에서 수 초가 걸린다.
  // ==========================================================================
  //   textLen: 빠른 상한값. 공백 · 숨은 텍스트까지 세므로 measure().len 보다 항상 크거나 같다.
  //            후보를 싸게 걸러내는 데만 쓴다 (textLen < 문턱 이면 measure 도 < 문턱).
  //   measure: 스트림과 같은 잣대 — elementFilter 로 거르고 앞뒤 공백을 뺀 글자 수와,
  //            그중 <a> 안에 있는 글자 수. 판정은 이걸로 한다.
  //            build() 와 같은 잣대다 — 둘 다 숨은(크기 0) 노드를 뺀다 · 안 뺀다 구분이 없다 (2026-10-05).
  function textLen(el) {
    let n = (el.textContent || '').length;
    el.querySelectorAll('script,style,noscript').forEach(s => {
      n -= (s.textContent || '').length;
    });
    return Math.max(n, 0);
  }

  function measure(el) {
    let len = 0, link = 0, n;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (x) => (x.nodeType === 1 ? elementFilter(x) : NodeFilter.FILTER_ACCEPT),
    });
    while ((n = w.nextNode())) {
      const t = n.data.trim().length;
      if (!t) continue;
      len += t;
      if (n.parentElement && n.parentElement.closest('a')) link += t;
    }
    return { len, link };
  }

  // [tag, id, class, role] — 조각 path(2-units) 와 meta.root 가 같이 쓴다 (감사 §8-4).
  //   class 는 getAttribute 로 읽는다 (SVG 의 className 은 문자열이 아님).
  //   해시 클래스명도 그대로 남긴다. 해석은 백엔드.
  function attrs(el) {
    if (!el || el.nodeType !== 1) return null;
    const cls = (el.getAttribute('class') || '').replace(/\s+/g, ' ').trim();
    return [el.tagName, (el.id || '').slice(0, 40), cls.slice(0, 80),
      (el.getAttribute('role') || '').trim()];
  }

  function describe(el) {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
  }

  // 알려진 플랫폼의 본문 컨테이너 — 글자 수 문턱 없이 루트로 쓴다.
  //   노션: 토글이 다 닫히면 본문이 200자 미만이라 1) 에서 떨어지고, 2) 에서 사이드바가 이겼다
  //   (사이드바 항목은 <a> 가 아니라 div role=button 이라 링크 글자로 안 셈). 2026-10-08 stepK.
  //   기록 중 토글을 열면 루트가 사이드바 → 본문으로 바뀌어 앞 구간 데이터가 사이드바 것이 됐다.
  // walls: 벽 방식. 'toggle' = 노션 토글 둘레에만 벽 (2026-10-08 세 번째 안).
  //   1안 "부모가 다른 블록 사이" → 인라인 코드 조각까지 갈라 7자 유닛. 2안 "노션 블록마다" → 글머리표 하나하나가
  //   유닛이라 10~60자, 평정 불가. 지금: 토글 제목 · 토글 안쪽 · 토글 밖을 서로 다른 구역으로 보고, 구역이 바뀌는
  //   곳에만 벽. 같은 구역 안 문단 · 글머리표 · 코드는 일반 사이트처럼 200자 언저리로 합친다.
  //   토글을 열면 내용이 "토글 안쪽" 구역으로 끼므로 제목 · 앞뒤 유닛 글이 안 바뀐다 → pid 유지.
  //   네이버 블로그 (2026-10-09): SmartEditor ONE 본문 상자. 없으면 폴백이 스킨 전체(div#head-skin, PC)나
  //   글 아래 카드 목록까지 든 div#ct(모바일)를 골라 프로필 · 카테고리 · 다른 글 제목이 유닛이 됐다 → 참가자가 평정까지 해야 했음
  //   (stepL_iframe: 유닛 25 · 링크 글자 조각 119/345). 벽 없음(일반 사이트와 같은 청킹).
  //   실제 DOM 으로 확인 안 한 선택자 — 패널 루트 줄이 "div.se-main-container (site)" 인지로 확인. 옛 에디터 글은 이 상자가 없어 폴백 그대로.
  const SITE_ROOTS = [{ sel: '.notion-page-content', walls: 'toggle' }, { sel: '.se-main-container' }];
  const NOTION_BLOCK = '[data-block-id]';
  let useWalls = false;                 // 지금 루트의 벽 블록 선택자 | false (findContentRoot 가 정함)

  function findContentRoot() {
    // 0) 알려진 플랫폼
    useWalls = false;
    for (const site of SITE_ROOTS) {
      const el = document.querySelector(site.sel);
      if (!el || !textLen(el)) continue;
      const m = measure(el);
      rootInfo = { how: 'site', sel: describe(el), len: m.len, link: m.link, el: attrs(el), walls: site.walls || null };
      useWalls = site.walls || false;
      return el;
    }
    // 1) 시맨틱 태그: 선택자마다 첫 요소만 본다 (기존 동작 유지).
    //    바뀐 것은 문턱을 재는 잣대뿐 — textContent(공백 포함) → 스트림 글자 수.
    //    헤럴드경제는 main.view(제목 영역)가 textContent 1297 로 통과했지만
    //    스트림은 124자였다. 이제 여기서 떨어지고 2) 로 간다.
    //    지금 잘 되는 사이트는 첫 요소의 스트림이 이미 문턱을 넘으므로 결과가 같다.
    for (const sel of ['article', 'main', '[role="main"]']) {
      const el = document.querySelector(sel);
      if (!el || textLen(el) <= CFG.MIN_ROOT_TEXT) continue;
      const m = measure(el);
      if (m.len > CFG.MIN_ROOT_TEXT) {
        rootInfo = { how: 'semantic', sel: describe(el), len: m.len, link: m.link, el: attrs(el) };
        return el;
      }
    }
    // 2) 링크가 아닌 글자가 가장 많은 요소.
    //    링크 글자를 빼는 이유: 사이드바 · 인기기사 목록은 글자 수만 보면 본문을 이긴다
    //    (헤럴드: 인기기사 2422자 > 본문 1796자). 목록은 글자 대부분이 기사 제목 링크다.
    //    같은 원리: Mozilla Readability 의 링크 밀도 감점, Kohlschütter 외 WSDM 2010.
    let best = document.body || document.documentElement, bestScore = -1, bestM = null;
    const pool = (document.body || document.documentElement)
      .querySelectorAll('div, section, article, main, td');
    pool.forEach((el) => {
      if (el.id === CFG.PANEL_ID || el.closest('#' + CFG.PANEL_ID)) return;
      if (textLen(el) < CFG.MIN_ROOT_TEXT) return;
      const m = measure(el);
      if (m.len < CFG.MIN_ROOT_TEXT) return;
      const score = m.len - m.link;
      if (score > bestScore) { bestScore = score; best = el; bestM = m; }
    });
    rootInfo = bestM
      ? { how: 'fallback', sel: describe(best), len: bestM.len, link: bestM.link, el: attrs(best) }
      : { how: 'body', sel: describe(best), len: 0, link: 0, el: attrs(best) };
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
            const f = elementFilter(node);
            if (f === NodeFilter.FILTER_REJECT) return f;
            if (node.tagName === 'BR') return NodeFilter.FILTER_ACCEPT;
            return f;
          }
          if (!node.data || !node.data.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const newSegs = [];
    const newBreaks = new Set();
    const newWalls = [];
    let lastWallKey;                     // 지금 구역 (토글 제목 · 토글 안쪽 · 밖) — 바뀌면 벽
    // 노션 토글 판별: 클래스에 toggle 이 있거나, 이 블록 자신의 줄(자식 블록 말고)에 열고 닫는 버튼(aria-expanded)이 있음.
    //   닫힌 토글은 자식 블록이 DOM 에 없어서 "자식이 있나"로는 못 알아본다 — 그래서 버튼으로 본다.
    const togCache = new Map();
    const isToggle = (b) => {
      if (togCache.has(b)) return togCache.get(b);
      let t = /toggle/i.test(typeof b.className === 'string' ? b.className : '');
      if (!t) for (const x of b.querySelectorAll('[aria-expanded]')) if (x.closest(NOTION_BLOCK) === b) { t = true; break; }
      togCache.set(b, t);
      return t;
    };
    const inner = new Map();             // 토글 → "그 토글 안쪽" 구역 표식
    const zoneOf = (el) => {
      if (!el) return null;
      const own = el.closest(NOTION_BLOCK);
      let b = own;
      while (b && b !== root && root.contains(b)) {
        if (isToggle(b)) {
          if (b === own) return b;       // 토글 제목 줄
          if (!inner.has(b)) inner.set(b, { of: b });
          return inner.get(b);           // 토글 안쪽
        }
        b = b.parentElement ? b.parentElement.closest(NOTION_BLOCK) : null;
      }
      return root;                       // 토글 밖
    };
    const parts = [];
    let len = 0;
    let pendingBreak = true;
    let lastBlock = null;
    let n;

    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) { pendingBreak = true; continue; }  // <br>
      const blk = nearestBlock(n);
      if (blk !== lastBlock) pendingBreak = true;
      if (useWalls) {
        const key = zoneOf(n.parentElement);
        if (lastWallKey !== undefined && key !== lastWallKey) { newWalls.push(len); pendingBreak = true; }
        lastWallKey = key;
      }
      lastBlock = blk;

      if (pendingBreak) newBreaks.add(len);
      newSegs.push({
        node: n, start: len, len: n.data.length,
        blk,                                                     // 조각 경계 (v3)
        link: !!(n.parentElement && n.parentElement.closest('a')),  // linkChars (v3)
      });
      parts.push(n.data);
      len += n.data.length;
      pendingBreak = false;
    }

    if (useWalls && rootInfo) rootInfo.toggles = [...togCache.values()].filter(Boolean).length;
    return { raw: parts.join(''), segs: newSegs, breaks: newBreaks, walls: newWalls };
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
    walls = built.walls || [];
    sig = buildSig(raw);
    nodeIndex = new Map();
    for (const s of segs) nodeIndex.set(s.node, s);
  }

  // ==========================================================================
  // 본문 상자 판정 (noise) — 헤더 "본문 상자 판정" 참고
  // ==========================================================================
  const MARK = 'data-rbc-i';
  let noiseMin = 0.3;        // 근거 없는 임시값. 루트 글자 중 상자 안 비율이 이보다 낮으면 미판정 (패널 슬라이더)
  let art = null;            // { status: site|ok|fail, why, boxes[], ratio, ms, root, raw }
  let recordingNow = false;  // 5-recorder 소유 recording 의 미러. 기록 중엔 판정을 유지한다.
  bus.on('record:started', () => { recordingNow = true; });
  bus.on('record:stopped', () => { recordingNow = false; });

  const squash = (s) => (s || '').replace(/\s+/g, '');

  // 복사본에서 Readability 를 돌려 원본의 상자 요소들을 돌려준다. 실패면 { why }.
  function findBoxes() {
    if (typeof Readability !== 'function') return { why: 'Readability 로드 안 됨' };
    const orig = Array.from(document.getElementsByTagName('*'));
    const doc = document.cloneNode(true);
    const copy = Array.from(doc.getElementsByTagName('*'));
    if (copy.length !== orig.length) return { why: `복사본 요소 수 다름: 원본 ${orig.length} / 복사본 ${copy.length}` };
    for (let i = 0; i < copy.length; i++) copy[i].setAttribute(MARK, String(i));
    // 우리 화면 요소(패널 · 오버레이 · 라벨)는 본문 후보에서 뺀다
    doc.querySelectorAll('[id^="rbc-"]').forEach(el => el.remove());

    let res;
    try { res = new Readability(doc, { serializer: el => el }).parse(); }
    catch (e) { return { why: 'Readability 예외: ' + String(e && e.message || e) }; }
    if (!res || !res.content) return { why: 'Readability 결과 없음 (본문을 못 찾음)' };

    // 번호 붙은 가장 바깥 요소들 = 상자. 번호 없는 요소(Readability 가 만든 감싸개)는 안으로 내려간다.
    const found = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (c.hasAttribute(MARK)) found.push(c); else walk(c);
      }
    };
    walk(res.content);
    if (!found.length) return { why: '상자 번호 없음 (Readability 결과에 원본 요소가 안 남음)' };

    const boxes = [];
    for (const c of found) {
      const o = orig[+c.getAttribute(MARK)];
      if (!o) return { why: `상자 번호 ${c.getAttribute(MARK)} 가 원본에 없음` };
      // 대조: 복사본 상자에 남은 글 표본(최대 5개)이 원본 상자 글에 다 있어야 한다
      const have = squash(o.textContent);
      const tw = doc.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      let n, k = 0;
      while ((n = tw.nextNode()) && k < 5) {
        const s = squash(n.data);
        if (s.length < 10) continue;
        k++;
        if (!have.includes(s.slice(0, 30))) {
          return { why: `상자 대조 실패: "${s.slice(0, 30)}" 가 원본 ${describe(o)} 에 없음` };
        }
      }
      boxes.push(o);
    }
    return { boxes };
  }

  // 판정을 최신으로 맞춘다 (필요할 때만 다시 돈다). 2-units 가 조각을 만들 때 inArticle 을 통해 부른다.
  function judge() {
    if (!contentRoot) { art = null; return art; }
    if (art && art.root === contentRoot) {
      const alive = art.status !== 'ok' || art.boxes.every(b => b.isConnected);
      if (alive && (recordingNow || art.raw === raw)) return art;
    }
    const t0 = performance.now();
    if (rootInfo && rootInfo.how === 'site') {
      art = { status: 'site', why: '플랫폼 지정 루트 = 본문, 판정 생략', boxes: [], ratio: 1 };
    } else {
      const r = findBoxes();
      if (!r.boxes) {
        art = { status: 'fail', why: r.why, boxes: [], ratio: null };
      } else {
        // 루트 글자(공백 빼고) 중 상자 안 비율
        let inside = 0, total = 0;
        for (const s of segs) {
          const c = sig[s.start + s.len] - sig[s.start];
          total += c;
          if (r.boxes.some(b => b.contains(s.node))) inside += c;
        }
        art = { status: 'ok', why: '', boxes: r.boxes, ratio: total ? inside / total : 0 };
      }
    }
    art.ms = Math.round(performance.now() - t0);
    art.root = contentRoot;
    art.raw = raw;
    return art;
  }

  // 판정이 쓸 만한가: 플랫폼 지정이거나, 상자를 찾았고 비율이 문턱 이상.
  const decided = (a) => !!a && (a.status === 'site' || (a.status === 'ok' && a.ratio >= noiseMin));

  // 텍스트 노드가 본문 상자 안인가. true = 본문, false = noise, null = 미판정(필드 안 씀).
  function inArticle(node) {
    const a = judge();
    if (!decided(a)) return null;
    if (a.status === 'site') return true;
    return a.boxes.some(b => b.contains(node));
  }

  // 패널 · 오버레이용 요약 (기록 데이터에는 안 나감). 마지막 판정을 읽기만 한다 — 다시 판정하는 건
  //   조각을 만들 때(inArticle)뿐. 틱마다 부르는 표시 경로에서 Readability 가 돌지 않게(#11 검토).
  function article() {
    const a = art;
    if (!a) return null;
    return {
      status: a.status, why: a.why, ratio: a.ratio, min: noiseMin, decided: decided(a), ms: a.ms,
      boxes: a.boxes.map(describe), boxEls: a.boxes,
    };
  }

  // ==========================================================================
  // 노션 펼치기 (#37, 11-03 서현 — 노션에서만, 기록 중에만)
  //   노션은 화면 근처 블록만 DOM 에 둔다(가상화, 10-07~). 보이는 창마다 200자 자르는 위치가 달라져
  //   같은 글이 여러 pid 로 갈라졌다(#17 [18]). 스크롤 상자(.notion-scroller)와 그 조상의 높이 · overflow 제한을 풀고
  //   상자 높이를 글 전체 높이로 늘리면 노션이 블록을 전부 그리고 계속 붙여 둔다 — 창이 대신 스크롤한다.
  //   그러면 DOM 에 글이 다 있어 루트 · 스트림 · 청킹 코드가 그대로 가상화 전과 같은 유닛 · pid 를 만든다
  //   (11-03 jsdom: 다 모은 글로 청킹 = 10-10 기록과 pid 22/22 같음). 유닛 경계 · pid 규칙 · 기록 형식은 바꾸지 않는다.
  //   높이 따라 늘리기: 토글을 열면 글이 길어진다. 노션 가상 목록의 높이 상자(루트 바로 아래 inline height)를
  //     ResizeObserver 로 지켜 상자 높이를 맞춘다. 안 하면 펼친 높이를 넘는 블록이 안 붙고 창도 그만큼만 스크롤된다
  //     (11-03 그래픽스 글: 687/908 블록 · 스크롤 막힘 → 따라 늘리면 908/908).
  //   보던 위치: 상자 scrollTop → 창 scrollY 로 옮긴 뒤 화면 가운데 블록을 같은 자리로 맞춘다. 되돌릴 때 반대로.
  //   되돌리기는 우리가 바꾼 속성만 원래 값으로(노션이 그 사이 바꾼 다른 inline 스타일은 건드리지 않게).
  //   부르는 곳: 5-recorder 본문 준비 대기(펼침 · 가리개 · 실패 검사) · stop(되돌림). 노션 루트가 없으면 아무것도 안 한다.
  //   실패 검사(unfoldCheck): 대기가 끝날 때 상자가 아직 안쪽에서 스크롤되면(노션이 스타일을 되돌렸거나 구조가 바뀜)
  //     펼치기가 안 먹은 것 → 5-recorder 가 그 글은 기록하지 않는다(11-03 서현). 이유 원문은 패널 · 가리개에.
  //   기록 중 지키기(1초마다, #37 청크 3): 편집 · 노션 안 이동 · 재렌더로 펼친 상자가 화면에서 빠지면 새 상자로 다시 펼치고,
  //     노션이 우리 inline 스타일을 덮으면 다시 적용한다. 횟수는 패널 줄(다시 펼침 · 스타일 다시 적용). 기록 데이터에는 안 나감.
  //   가리개: 대기 동안 반투명 창으로 페이지를 덮고 휠 · 터치 · 스크롤 키를 막는다(서현 아이디어 — 팝업 문구는 잘 안 읽음).
  //     실패하면 같은 창에 이유를 띄우고 [확인]을 눌러야 닫힌다. 루트 밖(documentElement 끝)에 붙어 글자 · 유닛과 무관.
  // ==========================================================================
  const NOTION_ROOT = '.notion-page-content';
  const NOTION_SCROLLER = '.notion-scroller';
  const UNFOLD_PAD = 400;               // 상자 높이 여유(px) — 끝 블록이 경계에 걸려 떨어지지 않게
  const UNFOLD_PROPS = ['overflow', 'height', 'max-height'];
  const UNFOLD_SET = [['overflow', 'visible'], ['height', 'auto'], ['max-height', 'none']];
  const UNFOLD_KEEP_MS = 1000;          // 기록 중 펼침 지키기 간격
  let keepTimer = 0;
  let unfolded = null;                  // { sc, root, box, saved, styleEl, ro, fits } | null
  let unfoldInfo = null;                // 패널용 마지막 결과 { on, ms, why } | null(이 페이지에서 시도 안 함)
  let unfoldTest = false;               // 패널 [펼치기 실패 시험] — 켜져 있으면 unfoldCheck 가 실패, 기록 중이면 지키기가 unfold:lost
  let curtainEl = null;
  const CURTAIN_KEYS = new Set([' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End']);
  const curtainBlock = (e) => { e.preventDefault(); e.stopPropagation(); };
  const curtainKey = (e) => { if (curtainEl && CURTAIN_KEYS.has(e.key)) curtainBlock(e); };

  function setImp(el, prop, val) { el.style.setProperty(prop, val, 'important'); }

  // 보던 위치 = 화면 가운데 블록이 화면 어디에 있었나. 펼치면 위쪽 블록 높이가 어림값 → 실제값으로 바뀌어
  //   스크롤 숫자만 옮기면 어긋난다(11-03 시험 60px). 그 블록을 같은 자리로 다시 데려온다.
  function viewAnchor(root) {
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const el = hit && root.contains(hit) ? hit.closest(NOTION_BLOCK) : null;
    return el ? { el, top: el.getBoundingClientRect().top } : null;
  }
  function backToAnchor(a, scroll) {
    if (!a || !a.el.isConnected) return;
    const d = a.el.getBoundingClientRect().top - a.top;
    if (Math.abs(d) >= 1) scroll(d);
  }

  // 지키기용 보던 위치 = 가운데 블록 id + 화면 위치. 요소 대신 id 라 노션이 블록을 새로 그려도 찾아간다.
  //   스타일이 덮이거나 상자가 빠지면 창 스크롤이 맨 위로 튄다(11-05 시험) → 고친 뒤 이 블록으로 돌아간다.
  function markView(root) {
    const a = viewAnchor(root);
    const id = a && a.el.getAttribute('data-block-id');
    return id ? { id, top: a.top } : null;
  }
  function backToMark(m) {
    if (!m) return;
    const el = document.querySelector('[data-block-id="' + CSS.escape(m.id) + '"]');
    if (el) backToAnchor({ el, top: m.top }, (d) => window.scrollBy(0, d));
  }

  // 펼친 상자가 아직 지금 화면의 것인가 — 노션이 화면을 다시 그리거나(편집 · 노션 안 이동) 루트를 바꾸면 false
  function alive(u) {
    return u.root.isConnected && u.sc.isConnected && document.querySelector(NOTION_ROOT) === u.root;
  }

  // 우리가 바꾼 것만 원래대로 (스크롤 위치는 안 만진다)
  function drop(u) {
    u.ro.disconnect();
    u.styleEl.remove();
    for (const [e, p, v, pr] of u.saved) {
      if (v) e.style.setProperty(p, v, pr); else e.style.removeProperty(p);
    }
    if (unfolded === u) unfolded = null;
  }

  // 기록 중 지키기 (UNFOLD_KEEP_MS 마다): 화면이 다시 그려졌으면 새 상자로 다시 펼치고(relinks),
  //   노션이 우리 스타일을 덮었으면 다시 적용한다(fixes). 둘 다 패널 줄에 횟수로 보인다.
  //   다시 펼치기가 실패하면(또는 [펼치기 실패 시험] 켜짐) unfold:lost → 5-recorder 가 구간을 닫고 실패 창 (11-05 서현).
  function keepUnfolded() {
    const u = unfolded;
    if (!u) { clearInterval(keepTimer); keepTimer = 0; return; }
    if (unfoldTest) { bus.emit('unfold:lost', { why: unfoldCheck() }); return; }
    if (!document.querySelector(NOTION_ROOT)) return;          // 이동 중 잠깐 루트가 없음 → 다음 번에
    if (!alive(u)) {
      if (!unfoldNotion()) bus.emit('unfold:lost', { why: unfoldInfo.why });
      return;
    }
    let fixed = false;
    for (const [e] of u.saved) {
      for (const [p, v] of UNFOLD_SET) {
        if (p === 'height' && e === u.sc) continue;            // 상자 높이는 fit 이 맞춘다
        if (e.style.getPropertyValue(p) !== v || e.style.getPropertyPriority(p) !== 'important') { setImp(e, p, v); fixed = true; }
      }
    }
    if (!document.getElementById('rbc-notion-unfold')) { (document.head || document.documentElement).appendChild(u.styleEl); fixed = true; }
    u.fit();
    if (fixed) { unfoldInfo.fixes++; backToMark(u.mark); }
    u.mark = markView(u.root);
  }

  function unfoldNotion() {
    if (unfolded && alive(unfolded)) return true;
    const root = document.querySelector(NOTION_ROOT);
    if (!root) return false;                                   // 노션 아님
    const t0 = performance.now();
    const sc = root.closest(NOTION_SCROLLER);
    if (!sc) {
      unfoldInfo = Object.assign({}, unfoldInfo, { on: false, ms: 0, why: '스크롤 상자(' + NOTION_SCROLLER + ')를 못 찾음' }); // 횟수는 남긴다
      return false;
    }
    const anchor = viewAnchor(root);
    const again = unfolded;                                    // 펼쳐 둔 상자가 화면에서 빠짐 → 새 상자로 다시
    if (again) drop(again);
    const y = sc.scrollTop;
    const saved = [];                                          // [el, prop, 옛 값, 옛 우선순위]
    for (let e = sc; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      for (const p of UNFOLD_PROPS) saved.push([e, p, e.style.getPropertyValue(p), e.style.getPropertyPriority(p)]);
      for (const [p, v] of UNFOLD_SET) setImp(e, p, v);
    }
    const styleEl = document.createElement('style');
    styleEl.id = 'rbc-notion-unfold';
    styleEl.textContent = 'html,body{height:auto!important;overflow:auto!important}';
    (document.head || document.documentElement).appendChild(styleEl);
    const box = [...root.children].find(c => c.style && c.style.height) || root;   // 가상 목록 높이 상자
    const u = { sc, root, box, saved, styleEl, ro: null, fits: 0, fit: null, mark: null };
    unfolded = u;
    const fit = u.fit = () => {
      if (unfolded !== u) return;
      const want = Math.ceil(box.getBoundingClientRect().bottom - sc.getBoundingClientRect().top) + UNFOLD_PAD;
      if (Math.abs(want - (parseFloat(sc.style.height) || 0)) < 2) return;
      setImp(sc, 'height', want + 'px');
      u.fits++;
    };
    fit();
    u.ro = new ResizeObserver(fit);
    u.ro.observe(box);
    window.scrollTo(0, sc.getBoundingClientRect().top + window.scrollY + y);   // 보던 위치: 먼저 대략
    backToAnchor(anchor, (d) => window.scrollBy(0, d));                        // 그다음 가운데 블록 기준으로 정확히
    if (again) backToMark(again.mark);                                         // 다시 펼침: 빠지기 전 1초 안에 보던 블록으로
    u.mark = markView(root);
    const n = again && unfoldInfo ? unfoldInfo : { relinks: 0, fixes: 0, fitsBefore: 0 };
    if (again) { n.relinks++; n.fitsBefore += again.fits; }
    unfoldInfo = { on: true, ms: Math.round(performance.now() - t0), why: '', relinks: n.relinks, fixes: n.fixes, fitsBefore: n.fitsBefore };
    if (!keepTimer) keepTimer = setInterval(keepUnfolded, UNFOLD_KEEP_MS);
    return true;
  }

  // 대기가 끝날 때 펼치기가 실제로 먹었나 → '' | 실패 이유 원문 (패널 줄에도 남긴다)
  function unfoldCheck() {
    const u = unfolded;
    let why = '';
    if (unfoldTest) why = '시험용 실패 (패널 [펼치기 실패 시험] 켜짐)';
    else if (!u) why = (unfoldInfo && unfoldInfo.why) || '펼치지 않음';
    else if (!u.sc.isConnected) why = '스크롤 상자가 DOM 에서 빠짐 (노션이 화면을 다시 그림)';
    else if (u.sc.scrollHeight - u.sc.clientHeight > 2) {
      why = `스크롤 상자가 아직 안쪽에서 스크롤됨 (글 높이 ${u.sc.scrollHeight}px / 상자 ${u.sc.clientHeight}px, overflow ${getComputedStyle(u.sc).overflowY})`;
    }
    if (why && unfoldInfo) unfoldInfo = Object.assign({}, unfoldInfo, { why });
    else if (why) unfoldInfo = { on: false, ms: 0, why };
    return why;
  }

  // 가리개. mode = 'wait'(문구만) | 'fail'(이유 + [확인]) | null(닫기)
  function curtain(mode, why) {
    if (curtainEl) {
      curtainEl.remove();
      curtainEl = null;
      window.removeEventListener('keydown', curtainKey, true);
    }
    if (!mode) return;
    const el = document.createElement('div');
    el.id = 'rbc-notion-curtain';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.45);' +
      'display:flex;align-items:center;justify-content:center;font:15px/1.6 system-ui,sans-serif';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;color:#111;border-radius:12px;padding:22px 26px;max-width:420px;' +
      'box-shadow:0 10px 30px rgba(0,0,0,.25);text-align:center';
    if (mode === 'wait') {
      box.innerHTML = '<b style="font-size:17px">노션 글을 기록할 준비 중이에요</b><br>' +
        '노션은 글 전체를 한 번에 불러와야 기록할 수 있어요.<br>잠시만 기다려 주세요. 준비가 끝나면 이 창은 저절로 사라져요.';
    } else {
      box.innerHTML = '<b style="font-size:17px;color:#b91c1c">이 노션 글은 기록하지 못해요</b><br>' +
        '글 전체를 불러오지 못했어요. 다른 글 · 다른 탭은 계속 기록돼요.<br>' +
        '<span style="color:#666;font-size:12px"></span><br><button style="margin-top:12px;padding:6px 22px;' +
        'border:0;border-radius:8px;background:#111;color:#fff;font:inherit;cursor:pointer">확인</button>';
      box.querySelector('span').textContent = '이유: ' + (why || '-');
      box.querySelector('button').onclick = () => curtain(null);
    }
    el.appendChild(box);
    el.addEventListener('wheel', curtainBlock, { passive: false });
    el.addEventListener('touchmove', curtainBlock, { passive: false });
    window.addEventListener('keydown', curtainKey, true);
    document.documentElement.appendChild(el);
    curtainEl = el;
  }

  function restoreNotion() {
    if (curtainEl && !curtainEl.querySelector('button')) curtain(null);   // 대기 가리개는 같이 닫는다 (실패 창은 [확인]으로)
    const u = unfolded;
    if (!u) return;
    clearInterval(keepTimer); keepTimer = 0;
    const y = Math.max(0, -u.sc.getBoundingClientRect().top);  // 창에서 상자 위쪽이 지나간 만큼 = 상자 안 위치
    const anchor = viewAnchor(u.root);
    drop(u);
    u.sc.scrollTop = y;
    backToAnchor(anchor, (d) => { u.sc.scrollTop += d; });
    unfoldInfo = Object.assign({}, unfoldInfo, { on: false });   // 실패 뒤 되돌림이면 이유 · 횟수를 남긴다
  }

  // 패널용 (기록 데이터에는 안 나감). 블록 수 = 지금 DOM 에 붙은 노션 블록
  function unfoldState() {
    if (!unfoldInfo) return null;
    const root = unfolded ? unfolded.root : document.querySelector(NOTION_ROOT);
    return Object.assign({}, unfoldInfo, {
      fits: (unfoldInfo.fitsBefore || 0) + (unfolded ? unfolded.fits : 0),
      blocks: root ? root.querySelectorAll(NOTION_BLOCK).length : 0,
    });
  }

  // ==========================================================================
  // 공개
  // ==========================================================================
  RBC.stream = {
    unfoldNotion,                       // 노션이면 펼침 (#37) → true(펼침 · 이미 펼침) | false(노션 아님 · 실패, unfoldState().why)
    restoreNotion,                      // 펼친 것을 되돌림 (안 펼쳤으면 아무것도 안 함)
    unfoldState,                        // 패널용 { on, ms, why, fits, blocks } | null
    unfoldCheck,                        // 펼치기가 먹었나 → '' | 실패 이유
    isNotion: () => !!document.querySelector(NOTION_ROOT),
    curtain,                            // 가리개 'wait' | 'fail' | null
    unfoldTest: () => unfoldTest,
    setUnfoldTest: (v) => { unfoldTest = !!v; },
    build,                              // → {raw, segs, breaks}  (커밋 안 함)
    commit,                             // 커밋 + sig 재계산

    raw: () => raw,
    len: () => raw.length,
    sig: () => sig,                     // 배열 그대로. 청킹 hot loop 때문.
    breaks: () => breaks,
    walls: () => walls,                 // 오름차순 원문 위치 (청킹이 넘지 않는 경계)
    segs: () => segs,
    segFor: (node) => nodeIndex.get(node),
    root: () => contentRoot,
    rootInfo: () => rootInfo,           // { how: semantic|fallback|body, sel, len, link, el }
    attrs,                              // el → [tag, id, class, role]
    inArticle,                          // 텍스트 노드 → true(본문) | false(noise) | null(미판정)
    article,                            // 판정 요약 { status, why, ratio, min, decided, ms, boxes, boxEls }
    noiseMin: () => noiseMin,
    setNoiseMin: (v) => { noiseMin = v; },   // 기록 중 차단은 6-frames(chunk 명령) · 9-panel
  };
})();