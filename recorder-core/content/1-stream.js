/* =============================================================================
 * 1-stream.js — 본문 루트 탐색 + 텍스트 스트림 구축
 *
 * 소유: raw, sig, segs, nodeIndex, breaks, tables · layouts(표, #54), contentRoot, art(본문 상자 판정), noiseMin, unfolded(노션 펼치기, #37)
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
 *   - 사이트 지정 본문 칸(SITE_BOXES, #43) = 루트는 그대로 두고 Readability 대신 그 칸들을 전부 상자로(art.by).
 *     칸 안의 뺄 칸(art.skip, 광고 자리, #45)은 상자 밖처럼 noise. 뺄 칸은 기록 중에도 조각마다 조상으로 다시 본다 —
 *     광고가 나중에 채워지면 그 뒤 조각부터 noise(앞 조각 · 비율은 처음 그대로). 아래 "기록 중" 의 또 다른 예외.
 *     기록 중에도 칸이 늘면(이어 붙는 기사) 새 조각부터 늘어난 칸으로 본다 — 아래 "기록 중" 의 예외.
 *     칸이 줄거나 0개가 돼도 다시 판정한다(0개면 Readability 로).
 *     칸이 하나라도 잡히면 Readability 는 안 돌린다 — 칸 여럿을 따로 잡는 규칙은 그중 일부만 있는 페이지에서
 *     그 칸만 상자가 된다(#53 우체국 EMS 탭 없는 페이지에서 제목만 상자 → 미판정, 그 페이지용 칸을 더함). 다시 판정한 비율이 문턱을 넘나들면 같은 구간 안에서
 *     앞 조각은 noise 있음 · 뒤 조각은 미판정처럼 섞일 수 있다(블로터는 칸이 늘면 비율이 오르는 쪽이라 드물 것, 예상).
 *   - Readability 상자가 루트를 통째로 감싸면(상자 밖이 없음) 루트 안에 하나뿐인 itemprop="articleBody" 칸으로 바꾼다
 *     (art.alt, #53). 없으면 하나뿐인 itemprop="text" 칸. 칸이 없거나 여럿이면 Readability 상자 그대로.
 *   - 루트 글자 중 상자 안 비율 < noiseMin 이면 상자가 루트 안에 거의 없는 것(루트 밖을 고름)으로 보고 미판정.
 *     비율로는 엉뚱한 상자를 못 거른다 — "페이지 없음" 화면의 푸터 상자도 31~100% 였다(#53 jsdom). 반대로 짧은
 *     기사 + 메뉴 많은 루트는 상자가 맞아도 19~30% 라 낮게 둔다. noiseMin 은 근거 없는
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
 *   - 본문 아닌 숨은 글(접힌 메뉴 · 모바일 전용 중복 · 스크린리더 전용 글)은 noise 판정 몫(예외: 위키백과 `.cite-accessibility-label` 은 아래 AD_WIDGETS 에서 뺀다).
 *   - 가려진 글(광고 · sticky 에 덮임)은 크기가 0 이 아니라 원래도 이 규칙과 무관했다.
 *   - aria-hidden="true" 제외는 유지 (DOM 속성이라 화면 배치와 무관).
 *   - 본문 아님이 확실한 위젯(AD_WIDGETS — 광고 · 떠다니는 추천 상자 · 공유 상자, #51 · #53)은 통째로 뺀다.
 *     예외: 위키백과 각주의 스크린리더 전용 글(아주 먼 화면 밖에 놓여 조각 사각형을 늘림)도 여기서 뺀다(#53) — 역시 DOM 만 보고 정한다.
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
  // 표 (#54): 자료 표 { el, start, end(원문 위치, 표 안 첫 글자 ~ 끝 글자), rows, cols, why } · 배치용 표 { el, why }.
  //   seg.tbl = 이 목록 번호, seg.cell = [줄, 칸] | null. 2-units 가 표 구간을 유닛 하나로, seg.cell 을 조각 cell 로 쓴다.
  let tables = [];
  let layouts = [];
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

  // 본문 아닌 위젯 (#51 → #53, 11-06 서현) — 본문이 아닌 게 확실한 칸(광고 · 떠다니는 추천 상자 · 공유 상자)만
  //   통째로 스트림에서 뺀다. 모든 사이트. 이름은 #51 때 광고만 넣던 그대로 AD_WIDGETS.
  //   본문 아닌 글은 보통 조각에 noise 로 표시만 하지만(§6), 이 칸들은 방문마다 붙었다 안 붙었다 · 내용이 바뀌어
  //   넣어 두면 같은 글의 주변 유닛 pid 가 방문마다 갈린다. 빼면 위젯 유무와 상관없이 같은 유닛이 된다.
  //   목록은 사람이 확인한 것만 넣는다(이름으로 본문 아님이 확실한 것). 오버레이가 회색 점선으로 보여 준다.
  //   .gliaplayer-container = GliaStudios 동영상 광고 플레이어. 뉴시스 기사 본문 사이에 끼고,
  //     안의 숨은 조작 글자(play_arrow · volume_mute · AD …)가 빈 동영상 자리에 조각으로 찍혔다(#51).
  //   [data-area-name="플로팅추천영역"] = 한국일보 떠다니는 추천 기사 상자(스크립트가 넣음, sticky · 평소 숨김).
  //     댓글 뒤에 붙어 마지막 유닛 끝 조각이 됐고, 숨어 있어도 자리가 있어 본문 위를 떠다니며 찍혔다(#53).
  //   [id^="svcad_"] = 서울경제 광고 자리(svcad_28 이노레임 글 광고 · 구글 광고 등). 스크립트가 본문 첫 문단 앞뒤로
  //     옮겨 넣고 광고 글이 방문마다 바뀌어, 본문 유닛에 본문으로 섞이고 그 유닛 pid 가 방문마다 갈렸다(#53 jsdom).
  //   .sharedaddy · #jp-relatedposts = 워드프레스 Jetpack 공유 · 좋아요 상자("Share this:" · Like)와 관련 글 상자.
  //     본문 칸(.entry-content) 안 끝에 붙어 마지막 유닛 끝 조각이 됐다(#53, 워드프레스닷컴 블로그 jsdom).
  //   .cite-accessibility-label = 위키백과(미디어위키) 각주의 스크린리더 전용 글 "이동: ". 위젯은 아니지만 예외로 여기 둔다.
  //     페이지 스크립트가 나중에 넣고, 문서 맨 위보다 약 10만 px 위에 놓아 숨긴다. 그래서 그 각주 조각의
  //     외곽 사각형이 그 위치부터 각주까지 늘어나, 각주보다 위 어디를 봐도 매 틱 vis 에 들어갔다(#53, 11-09 서현).
  const AD_WIDGETS = '.gliaplayer-container, [data-area-name="플로팅추천영역"], [id^="svcad_"], .sharedaddy, #jp-relatedposts, ' +
    '.cite-accessibility-label';

  // 요소를 스트림에 넣을지. build() 와 measure() 가 같이 쓴다 — 루트를 고르는
  // 잣대와 실제로 뽑는 잣대가 달라서 헤럴드경제가 유닛 1개가 됐다(감사 §6-F).
  function elementFilter(el) {
    if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
    if (el.id === CFG.PANEL_ID) return NodeFilter.FILTER_REJECT;
    if (el.matches && el.matches(AD_WIDGETS)) return NodeFilter.FILTER_REJECT;   // #51 · #53
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
  // 표 (#54) — 자료 표를 찾고 칸마다 [줄, 칸] 을 매긴다. 표 구간 = 표 유닛 하나(2-units).
  //   자료 표 / 배치용 표 판정 = Readability _markDataTables · _getRowAndColumnCount 규칙 그대로(파이어폭스가
  //   화면 읽기 프로그램용으로 쓰는 규칙). 문턱을 새로 만들지 않는다(11-09 서현).
  //   표 유닛이 될 표 = 글자에서 위로 올라가며 만나는 표 중 가장 바깥 자료 표. 자료 표 안의 표는 바깥 표에 속하고,
  //   배치용 표 안의 자료 표는 따로 표가 된다(옛날식 전체 배치 표 안에 든 요금표 등).
  //   칸 번호 = 그 표의 줄 · 칸 격자(합친 칸은 시작 칸, rowspan="0" 은 1로). 표 안의 표 글자는 그 표가 든 바깥 칸.
  //   표 제목(caption) 처럼 칸 밖 글자는 칸 번호 없음.
  // ==========================================================================
  function tableSize(t) {                // Readability _getRowAndColumnCount 그대로 (표 안의 표 줄도 센다)
    let rows = 0, cols = 0;
    for (const tr of t.getElementsByTagName('tr')) {
      rows += parseInt(tr.getAttribute('rowspan'), 10) || 1;
      let c = 0;
      for (const td of tr.getElementsByTagName('td')) c += parseInt(td.getAttribute('colspan'), 10) || 1;
      cols = Math.max(cols, c);
    }
    return { rows, cols };
  }

  // → 판정 이유 문자열. 'data:…' = 자료 표, 'layout:…' = 배치용 (Readability _markDataTables 순서 그대로)
  function tableKind(t) {
    if (t.getAttribute('role') === 'presentation') return 'layout:role';
    if (t.getAttribute('datatable') === '0') return 'layout:datatable';
    if (t.getAttribute('summary')) return 'data:summary';
    const cap = t.getElementsByTagName('caption')[0];
    if (cap && cap.childNodes.length) return 'data:caption';
    for (const tag of ['col', 'colgroup', 'tfoot', 'thead', 'th']) if (t.getElementsByTagName(tag)[0]) return 'data:' + tag;
    if (t.getElementsByTagName('table')[0]) return 'layout:nested';
    const { rows, cols } = tableSize(t);
    if (cols === 1 || rows === 1) return 'layout:1줄';
    if (rows >= 10 || cols > 4) return 'data:size';
    return rows * cols > 10 ? 'data:size' : 'layout:size';
  }

  // 표의 칸 → [줄, 칸]. 자기 줄만(t.rows = thead · tbody · tfoot 줄, 표 안의 표 줄은 안 셈).
  function cellGrid(t) {
    const map = new Map(), taken = [];
    let cols = 0;
    Array.from(t.rows).forEach((tr, r) => {
      let c = 0;
      for (const cell of tr.cells) {
        while (taken[r] && taken[r][c]) c++;
        map.set(cell, [r, c]);
        const rs = Math.max(1, cell.rowSpan | 0), cs = Math.min(Math.max(1, cell.colSpan | 0), 1000);
        for (let i = 0; i < rs; i++) {
          taken[r + i] = taken[r + i] || [];
          for (let j = 0; j < cs; j++) taken[r + i][c + j] = true;
        }
        c += cs;
      }
      cols = Math.max(cols, c);
    });
    return { map, rows: t.rows.length, cols };
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
    // 표 (#54): 표 요소 → 판정 이유 · 자료 표 → 표 목록 칸 번호
    const kindOf = new Map();
    const kind = (t) => { if (!kindOf.has(t)) kindOf.set(t, tableKind(t)); return kindOf.get(t); };
    const newTables = [];                // 자료 표 = 표 유닛 후보 { el, start, end, rows, cols, why, grid }
    const tblIdx = new Map();            // 표 요소 → newTables 번호
    const newLayouts = new Set();        // 글자가 든 배치용 표 (자료 표 안에 든 것은 빼고)
    // 글자 → { t: 표 번호, cell: [줄, 칸] | null } | null
    const tableOf = (node) => {
      let top = null;
      const lays = [];
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        if (el.tagName !== 'TABLE') continue;
        if (kind(el).startsWith('data:')) { top = el; lays.length = 0; } else lays.push(el);
      }
      // 가장 바깥 자료 표 밖에 있는 배치용 표만 남긴다 (lays 는 top 보다 바깥 것만 남아 있음)
      for (const l of lays) newLayouts.add(l);
      if (!top) return null;
      if (!tblIdx.has(top)) {
        const g = cellGrid(top);
        tblIdx.set(top, newTables.length);
        newTables.push({ el: top, start: -1, end: -1, rows: g.rows, cols: g.cols, why: kind(top).slice(5), grid: g.map });
      }
      const t = tblIdx.get(top);
      let cell = null;
      for (let el = node.parentElement; el && el !== top; el = el.parentElement) {
        if ((el.tagName === 'TD' || el.tagName === 'TH') && el.closest('table') === top) { cell = newTables[t].grid.get(el) || null; break; }
      }
      return { t, cell };
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
      const seg = {
        node: n, start: len, len: n.data.length,
        blk,                                                     // 조각 경계 (v3)
        link: !!(n.parentElement && n.parentElement.closest('a')),  // linkChars (v3)
      };
      const tb = tableOf(n);
      if (tb) {                                                  // 자료 표 안 글자 (#54)
        seg.tbl = tb.t;
        seg.cell = tb.cell;
        const T = newTables[tb.t];
        if (T.start < 0) T.start = len;
        T.end = len + n.data.length;
      }
      newSegs.push(seg);
      parts.push(n.data);
      len += n.data.length;
      pendingBreak = false;
    }

    if (useWalls && rootInfo) rootInfo.toggles = [...togCache.values()].filter(Boolean).length;
    for (const T of newTables) delete T.grid;
    return { raw: parts.join(''), segs: newSegs, breaks: newBreaks, walls: newWalls,
      tables: newTables, layouts: [...newLayouts].map(el => ({ el, why: kind(el).slice(7) })) };
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
    tables = built.tables || [];
    layouts = built.layouts || [];
    sig = buildSig(raw);
    nodeIndex = new Map();
    for (const s of segs) nodeIndex.set(s.node, s);
  }

  // ==========================================================================
  // 본문 상자 판정 (noise) — 헤더 "본문 상자 판정" 참고
  // ==========================================================================
  const MARK = 'data-rbc-i';
  let noiseMin = 0.05;       // 근거 없는 임시값. 루트 글자 중 상자 안 비율이 이보다 낮으면 미판정 (패널 슬라이더)
                             //   30 → 5 (#53): 상자가 맞는데 디지털데일리 29.8% · 이데일리 19.0% 로 미판정이었다
  let art = null;            // { status: site|ok|fail, by?(사이트 지정 칸 이름), why, boxes[], ratio, ms, root, raw }
  let recordingNow = false;  // 5-recorder 소유 recording 의 미러. 기록 중엔 판정을 유지한다.
  bus.on('record:started', () => { recordingNow = true; });
  bus.on('record:stopped', () => { recordingNow = false; });

  const squash = (s) => (s || '').replace(/\s+/g, '');

  // 사이트 지정 본문 칸 (#43) — 이 사이트에서는 Readability 대신 이 칸들을 전부 본문 상자로 쓴다. 루트는 그대로.
  //   블로터: 읽다가 스크롤하면 다음 기사 1개를 #enters 에 이어 붙인다(articleScrollAdd.php, 주소 그대로).
  //   루트가 두 기사를 다 담고 Readability 는 하나만 골라 아래 기사를 고르자 위 기사(주소의 기사)가 전부 noise 였다.
  //   붙는 기사도 같은 id 라 id 가 겹친다 → [id=…] 로 전부 잡는다. 비율 · 문턱은 Readability 상자와 같게 본다.
  //   전자신문(#45): 모바일 판에서 Readability 가 본문 칸 옆 기사 머리(분류 · 제목 · 발행일)까지 고른다 — 옆 칸 점수가
  //   본문 점수의 20% 를 넘으면 붙이는 규칙이라 짧은 기사일수록 붙는다. 본문 칸 #articleBody 만 상자로.
  //   skip = 상자 안에서 뺄 칸(광고 자리). 그 안 글 = 상자 밖과 같게 noise, 비율에서도 상자 밖으로 센다.
  //     전자신문은 광고 자리(쿠팡 광고 · 뉴스룸 홍보)가 본문 칸 안에 있고 스크립트가 나중에 채운다 → 판정 때
  //     목록을 저장하지 않고 조각마다 조상으로 본다(기록 중에 채워져도 빠지게). 해시태그 · 기자 줄은 본문(11-06 서현).
  const SITE_BOXES = [
    { host: /(^|\.)bloter\.net$/, sel: '[id="article-view-content-div"]', name: '블로터' },
    { host: /(^|\.)etnews\.com$/, sel: '[id="articleBody"]', name: '전자신문',
      skip: '.ad-300x250, #newsroom_etview_promotion' },
    // 경향신문(#45): Readability 상자(section.art_cont)가 사실상 #articleBody 하나라 본문은 잘 잡는다. 칸 안 광고 자리
    //   (사진 아래 텍스트 광고 #articleImageTxtAd · 본문 배너)가 전부 .ad-wrapper 로 감싸져 있어 그것만 뺀다.
    { host: /(^|\.)khan\.co\.kr$/, sel: '[id="articleBody"]', name: '경향신문', skip: '.ad-wrapper' },
    // 서울경제(#53): Readability 상자(div.article-content)가 위 도구 막대(뉴스 듣기 · 글자 크기 …) · 기사 머리 ·
    //   기자 구독 · 오른쪽 "많이 본 뉴스" 까지 다 담는다. 본문 칸 #article-body 만 상자로. 광고 자리는 AD_WIDGETS.
    { host: /(^|\.)sedaily\.com$/, sel: '[id="article-body"]', name: '서울경제' },
    // 이데일리(#61): 같은 페이지 구조인데 기사에 따라 Readability 가 본문 칸 div.news_body 를 고르기도,
    //   한 단계 바깥 div.article_news(제목 · 등록 시각 · 기자 이름 · 랭킹뉴스 · 주요뉴스 · 저작권 줄까지)를 고르기도 한다.
    //   늘 본문 칸만 상자로. 제목 · 부제는 noise 그대로(예전 기록과 같게, 11-09 서현).
    { host: /(^|\.)edaily\.co\.kr$/, sel: '.news_body', name: '이데일리' },
    // 향토문화전자대전(#53): Readability 상자는 본문 칸(.info_div)만 — 위 정보 표(항목 ID · 별칭 · 지역 · 집필자 …) ·
    //   [상세정보] · 아래 [참고문헌] 이 noise 가 된다. 위키백과 정보 상자처럼 본문으로 넣는다(11-09 서현).
    //   네 칸이 형제라 전부 상자로(표 밑 안내문 "※ 본 항목의 내용은 …" 도 본문, 11-09 서현).
    { host: /(^|\.)grandculture\.net$/, sel: '[id="pic_info_div"], .info_detail, .info_div, .info_reference',
      name: '향토문화전자대전' },
    // 국립국어원 온라인가나다(#53): Readability 상자(div.boardView)가 질문 · 답변 아래 이전 글 · 다음 글(.page)까지 담고,
    //   비밀번호 창 · 재질문 · 목록 버튼까지 본문이 된다. 질문 · 답변의 머리(제목 · 작성자)와 몸만 상자로.
    { host: /(^|\.)korean\.go\.kr$/, sel: '.boardView > .head, .boardView > .body', name: '국립국어원' },
    // 우체국 EMS(#53): 요금표 페이지는 글이 거의 다 표라 Readability 가 버튼 칸(div.btn_wrap)을 골라 비율 0% → 미판정,
    //   왼쪽 메뉴까지 noise 표시 없이 들어간다. 제목과 탭 안 내용(요금표 · 아래 안내문)만 상자로 — 탭 이름 · 요금계산기 ·
    //   인쇄 버튼은 밖. 탭이 없는 페이지(통관 수수료 안내 등)는 본문 칸 .contents 통째로 — 안 그러면 제목만 상자가 돼 미판정.
    { host: /(^|\.)ems\.epost\.go\.kr$/, sel: '[id="contents_layout3"] > .page_title > h3, [id="contents_layout3"] .menu_wrap > .tab_contents, '
      + '[id="contents_layout3"] > .contents:not(:has(.tab_contents))',
      name: '우체국 EMS' },
    // MDN(#70): main#content 안이 머리 칸(.layout__header — 제목 h1 · 소개 문단) · 오른쪽 목차 · 몸 칸(.layout__body —
    //   상태 · 구문 · 예제 · 명세서 · 호환성 · 같이 보기)으로 나뉜 형제 구조. 몸 칸 글이 짧은 페이지(HTTP 418)는
    //   Readability 가 머리 칸만 골라 몸 칸이 전부 noise 가 됐다. 머리 칸 + 몸 칸을 상자로(h1 도 본문, 11-10 서현).
    //   번역 안내 띠 · 설문 자리 · 맨 아래 피드백 칸("Help improve MDN" · GitHub 링크)은 뺀다. 목차는 상자 밖 = noise.
    { host: /(^|\.)developer\.mozilla\.org$/, sel: 'main#content > .layout__header, main#content > .layout__body',
      skip: '.translation-banner, mdn-survey, .article-footer', name: 'MDN' },
  ];
  const siteBoxRule = () => SITE_BOXES.find(r => r.host.test(location.hostname)) || null;
  const siteBoxes = (rule) => Array.from(document.querySelectorAll(rule.sel)).filter(el => textLen(el));
  // 노드가 상자 안의 뺄 칸 안인가 (뺄 칸이 상자 밖 조상이면 아님)
  const inSkip = (a, box, node) => {
    const el = a.skip && (node.nodeType === 1 ? node : node.parentElement);
    const s = el && el.closest(a.skip);
    return !!s && s !== box && box.contains(s);
  };
  const inBox = (a, node) => a.boxes.some(b => b.contains(node) && !inSkip(a, b, node));
  const sameEls = (a, b) => a.length === b.length && a.every((el, i) => el === b[i]);

  // 복사본에서 Readability 를 돌려 원본의 상자 요소들을 돌려준다. 실패면 { why }.
  let onAttrs = null;                     // 마지막 findBoxes 가 복사본에서 지운 on* 속성 수 (#27, 패널 표시용)
  function findBoxes() {
    onAttrs = null;
    if (typeof Readability !== 'function') return { why: 'Readability 로드 안 됨' };
    const orig = Array.from(document.getElementsByTagName('*'));
    const doc = document.cloneNode(true);
    const copy = Array.from(doc.getElementsByTagName('*'));
    if (copy.length !== orig.length) return { why: `복사본 요소 수 다름: 원본 ${orig.length} / 복사본 ${copy.length}` };
    for (let i = 0; i < copy.length; i++) copy[i].setAttribute(MARK, String(i));
    // 우리 화면 요소(패널 · 오버레이 · 라벨)는 본문 후보에서 뺀다
    doc.querySelectorAll('[id^="rbc-"]').forEach(el => el.remove());
    // 복사본의 인라인 이벤트 속성(onclick 등)을 지운다 (#27). 글이 짧으면 Readability 가 복사본에 HTML 문자열을 다시
    //   넣어 재시도하는데(readability.js _grabArticle `page.innerHTML = pageCacheHtml`), 그때 이 속성들이 페이지 CSP
    //   (구글 검색 = nonce)에 막혀 확장 오류 페이지에 위반 경고가 쌓였다. 판정은 이벤트 속성을 안 본다 → 결과 그대로(jsdom 확인).
    onAttrs = 0;
    for (const el of doc.getElementsByTagName('*')) {
      for (const at of Array.from(el.attributes)) {
        if (at.name.length > 2 && at.name.startsWith('on')) { el.removeAttribute(at.name); onAttrs++; }
      }
    }

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

  // Readability 상자가 루트를 통째로 감싸면(상자 밖이 없어 아무것도 못 가림) 사이트가 직접 표시한 본문 칸
  //   (schema.org itemprop="articleBody")이 루트 안에 딱 하나 있을 때 그 칸으로 바꾼다 (#53, 11-06 서현).
  //   Gatsby 블로그(ppeper.github.io): Readability 가 #article-body(점수 69)를 고르고도 "부모 점수가 더 높으면 올라간다"
  //   규칙으로 페이지 맨 바깥 div#___gatsby 까지 올라가 제목 줄 · 시리즈 목록 · 이전/다음 글 · 글쓴이 소개가 다 본문이 됐다.
  //   articleBody 칸이 없으면 itemprop="text"(schema.org 글 CreativeWork 의 본문)를 본다 — Jekyll Minimal Mistakes 테마
  //   (stg0123.github.io)는 본문 칸이 section.page__content[itemprop="text"]. text 는 댓글 · 답변에도 붙어(Stack Overflow 49개)
  //   딱 하나일 때만 쓴다 (#53 청크 6, 11-09 서현).
  //   상자가 루트 안에 있으면(대부분의 사이트) 안 건드린다 — 늘 itemprop 을 쓰면 매경 · 이데일리 판정이 바뀐다.
  //   돌려주는 것: { el, prop } | null.
  function itempropBox(boxes) {
    if (!boxes.some(b => b !== contentRoot && b.contains(contentRoot))) return null;
    for (const prop of ['articleBody', 'text']) {
      const els = Array.from(contentRoot.querySelectorAll(`[itemprop="${prop}"]`)).filter(el => textLen(el));
      if (els.length) return els.length === 1 ? { el: els[0], prop } : null;
    }
    return null;
  }

  // 판정을 최신으로 맞춘다 (필요할 때만 다시 돈다). 2-units 가 조각을 만들 때 inArticle 을 통해 부른다.
  function judge() {
    if (!contentRoot) { art = null; return art; }
    const rule = siteBoxRule();
    if (art && art.root === contentRoot) {
      const alive = art.status !== 'ok' || art.boxes.every(b => b.isConnected);
      if (alive && (recordingNow || art.raw === raw)) {
        if (!art.by || art.raw === raw) return art;
        // 기록 중 본문 글이 바뀜 + 사이트 지정 칸: 칸이 그대로면 유지, 늘었으면(붙은 기사) 다시 판정.
        //   앞 조각은 그대로고 새 조각만 새 칸 목록으로 본다. 확인은 글이 바뀐 스캔마다 한 번(조각마다 아님).
        if (sameEls(art.boxes, siteBoxes(rule))) { art.raw = raw; return art; }
      }
    }
    const t0 = performance.now();
    // 루트 글자(공백 빼고) 중 상자 안 비율
    const ratioOf = (boxes, skip) => {
      const a = { boxes, skip };
      let inside = 0, total = 0;
      for (const s of segs) {
        const c = sig[s.start + s.len] - sig[s.start];
        total += c;
        if (inBox(a, s.node)) inside += c;
      }
      return total ? inside / total : 0;
    };
    const ruleEls = rule ? siteBoxes(rule) : [];
    if (rootInfo && rootInfo.how === 'site') {
      art = { status: 'site', why: '플랫폼 지정 루트 = 본문, 판정 생략', boxes: [], ratio: 1 };
    } else if (ruleEls.length) {
      const skip = rule.skip || null;
      art = { status: 'ok', by: rule.name, why: '', boxes: ruleEls, skip, ratio: ratioOf(ruleEls, skip) };
    } else {
      // 사이트 지정 칸이 없으면(그 사이트의 다른 모양 페이지) Readability 로 간다
      const r = findBoxes();
      if (!r.boxes) {
        art = { status: 'fail', why: r.why, boxes: [], ratio: null };
      } else {
        art = { status: 'ok', why: '', boxes: r.boxes, ratio: ratioOf(r.boxes) };
        const alt = itempropBox(r.boxes);
        if (alt) art = { status: 'ok', why: '', boxes: [alt.el], ratio: ratioOf([alt.el]), alt: alt.prop, altFrom: r.boxes.map(describe) };
      }
      art.onAttrs = onAttrs;
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
    return inBox(a, node);
  }

  // 패널 · 오버레이용 요약 (기록 데이터에는 안 나감). 마지막 판정을 읽기만 한다 — 다시 판정하는 건
  //   조각을 만들 때(inArticle)뿐. 틱마다 부르는 표시 경로에서 Readability 가 돌지 않게(#11 검토).
  function article() {
    const a = art;
    if (!a) return null;
    // 뺄 칸은 나중에 채워질 수 있어 읽을 때마다 찾는다(상자 안만, 글 있는 것만)
    const skipEls = a.skip ? a.boxes.flatMap(b => Array.from(b.querySelectorAll(a.skip))).filter(el => textLen(el)) : [];
    return {
      status: a.status, by: a.by || null, alt: a.alt || null, altFrom: a.altFrom || null, why: a.why, ratio: a.ratio, min: noiseMin, decided: decided(a), ms: a.ms,
      onAttrs: a.onAttrs == null ? null : a.onAttrs,
      boxes: a.boxes.map(describe), boxEls: a.boxes, skips: skipEls.map(describe), skipEls,
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
    adWidgets: () => Array.from(document.querySelectorAll(AD_WIDGETS)),   // 스트림에서 뺀 본문 아닌 위젯 칸 (#51 · #53, 오버레이용)
    tables: () => tables,               // 자료 표 (#54) [{ el, start, end, rows, cols, why }]
    layouts: () => layouts,             // 글자가 든 배치용 표 (#54) [{ el, why }] — 오버레이용
    tableStat: () => ({                 // 패널용 (#54)
      data: tables.map(t => ({ rows: t.rows, cols: t.cols, why: t.why, chars: t.end - t.start })),
      layout: layouts.map(l => l.why),
    }),
    noiseMin: () => noiseMin,
    setNoiseMin: (v) => { noiseMin = v; },   // 기록 중 차단은 6-frames(chunk 명령) · 9-panel
  };
})();