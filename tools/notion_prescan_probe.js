// 노션 미리 훑기 실현 가능성 점검 — 노션 페이지 DevTools 콘솔에 통째로 붙여 넣고 Enter.
// 하는 일: 스크롤 상자를 위→아래로 자동 스크롤하며 [data-block-id] 블록을 순서대로 모으고,
//          다시 맨 위로 돌아온 뒤 결과를 출력한다. 두 번 돌려 같은 결과가 나오는지 본다.
(async () => {
  const root = document.querySelector('.notion-page-content');
  if (!root) return console.log('본문(.notion-page-content) 없음');
  let sc = root.parentElement;
  while (sc && !(sc.scrollHeight > sc.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
  if (!sc) return console.log('스크롤 상자 못 찾음');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function prescan() {
    const order = [];                 // 블록 id 순서 (창들을 이어 붙임)
    const text = new Map();           // id → 자기 글(자식 블록 제외한 잎 블록만)
    let maxMounted = 0;
    const t0 = performance.now();
    sc.scrollTop = 0; await sleep(400);
    for (let step = 0; step < 400; step++) {
      const els = [...root.querySelectorAll('[data-block-id]')];
      maxMounted = Math.max(maxMounted, els.length);
      let anchor = -1;
      for (const el of els) {
        const id = el.getAttribute('data-block-id');
        const k = order.indexOf(id);
        if (k >= 0) { anchor = k; }
        else { order.splice(anchor + 1, 0, id); anchor += 1; }
        if (!el.querySelector('[data-block-id]')) text.set(id, (el.innerText || '').trim());
      }
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      if (atBottom) break;
      sc.scrollTop += sc.clientHeight * 0.8;
      await sleep(250);
    }
    sc.scrollTop = 0;
    const chars = [...text.values()].reduce((s, t) => s + t.length, 0);
    return { order, chars, maxMounted, ms: Math.round(performance.now() - t0) };
  }

  const a = await prescan();
  await sleep(800);
  const b = await prescan();
  const same = a.order.length === b.order.length && a.order.every((id, i) => id === b.order[i]);
  console.log(`블록 ${a.order.length}개 · 글자 ${a.chars} · 한 번에 붙어 있던 블록 최대 ${a.maxMounted} · 걸린 시간 ${a.ms}ms`);
  console.log(`두 번째: 블록 ${b.order.length}개 · 글자 ${b.chars} · ${b.ms}ms · 순서 일치 ${same ? '예' : '아니오'}`);
})();