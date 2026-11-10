/* =============================================================================
 * tools/vis-compare/compare.js — 실제 크롬에서 옛/새 visPieces() 대조 (#73)
 *
 * 왜: jsdom 에는 레이아웃이 없어 vis(조각 사각형)를 못 본다. 진짜 사이트를 실제 크롬으로 열고
 *     같은 페이지 · 같은 스크롤 위치에서 옛 3-hittest 와 새 3-hittest 의 visPieces() 결과를 한 칸씩 비교한다.
 *     기록 JSON 의 vis 가 그대로인지(불일치 0)와 걸린 시간을 본다.
 *
 * 쓰는 법 (Claude 가 앱 안 브라우저에서):
 *   1. python3 tools/vis-compare/serve.py  (서현 맥에서는 git 밖 .claude/launch.json 의 "vis-compare" 로 띄움)
 *   2. 글을 localhost 로 연다 (진짜 사이트는 localhost 로 가는 fetch 를 막아서 — 나무위키 11-10 확인):
 *        http://localhost:8761/page/<저장한 HTML>?url=<원래 주소>   또는   /page/-?url=<주소> (서버가 받아 옴)
 *      서버가 사이트 스크립트를 빼고 <base> 로 원래 CSS 를 쓰게 한 뒤 이 파일을 붙인다. 페이지 콘솔에서:
 *        await VC.load('http://localhost:8761')            // 엔진 + 옛/새 3-hittest 올림, 재청킹
 *        VC.start({ jumps: 30 }); … VC.result()            // 각본은 비동기로 돈다 — 끝나면 result().done
 *   옛 = /old/ (기본 origin/main), 새 = /cur/ (이 작업 폴더). 청크 1 에선 둘 다 main 이라 불일치 0 이 당연.
 *
 * 페이지 본 환경에서 돈다(확장은 격리 환경) — 레이아웃 · 사각형은 같다고 본다(예상).
 * 이 파일은 확장에 들어가지 않는다(build.command 대상 아님).
 * ========================================================================== */
(() => {
  'use strict';
  const FILES = ['vendor/readability.js', 'content/0-core.js', 'content/1-stream.js', 'content/2-units.js'];
  const S = { oldH: null, newH: null, steps: [], mism: [], done: false, err: null, info: null };

  async function get(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' → ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return r.text();
  }
  const geval = (code) => (0, eval)(code);   // 전역에서 — 엔진 IIFE 가 window.RBC 를 본다

  async function load(base, ref) {
    if (window.RBC) throw new Error('이미 RBC 가 있음 — 페이지를 새로 고친 뒤 다시');
    const q = ref ? '?ref=' + encodeURIComponent(ref) : '';
    for (const f of FILES) geval(await get(`${base}/cur/recorder-core/${f}`));
    geval(await get(`${base}/old/recorder-core/content/3-hittest.js${q}`));
    S.oldH = window.RBC.hittest;
    geval(await get(`${base}/cur/recorder-core/content/3-hittest.js`));
    S.newH = window.RBC.hittest;
    if (S.oldH === S.newH) throw new Error('옛/새 hittest 가 같은 객체');
    const t = performance.now();
    window.RBC.units.rescan({});
    const all = window.RBC.units.all();
    S.info = {
      url: location.href, w: innerWidth, h: innerHeight, rescanMs: Math.round(performance.now() - t),
      units: all.length, pieces: all.reduce((s, u) => s + (u.pieces || []).length, 0),
      details: document.querySelectorAll('details').length,
    };
    return S.info;
  }

  const same = (a, b) => a.length === b.length && a.every((x, i) => x.join() === b[i].join());

  // 한 걸음: 레이아웃을 먼저 확정하고, 옛/새 순서를 번갈아 재서 "먼저 부른 쪽이 레이아웃 비용을 무는" 치우침을 없앤다
  function step(label) {
    void document.body.offsetHeight;
    const flip = S.steps.length % 2 === 1;
    const run = (h) => { const t = performance.now(); const v = h.visPieces(); return [v, performance.now() - t]; };
    let o, n;
    if (flip) { n = run(S.newH); o = run(S.oldH); } else { o = run(S.oldH); n = run(S.newH); }
    const ok = same(o[0], n[0]);
    const rec = { label, y: Math.round(scrollY), oldMs: o[1], newMs: n[1], vis: o[0].length, ok,
      foldedOld: S.oldH.stats().folded, foldedNew: S.newH.stats().folded };
    S.steps.push(rec);
    if (!ok && S.mism.length < 20) {
      const key = (v) => new Set(v.map(x => x.join()));
      const ko = key(o[0]), kn = key(n[0]);
      S.mism.push({ label, y: rec.y,
        onlyOld: o[0].filter(x => !kn.has(x.join())).slice(0, 5),
        onlyNew: n[0].filter(x => !ko.has(x.join())).slice(0, 5) });
    }
    return rec;
  }

  // requestAnimationFrame 은 앱 안 브라우저 창이 숨어 있으면 안 돈다(document.hidden 이 false 여도, 11-10 확인) → setTimeout.
  //   사각형은 visPieces 가 레이아웃을 강제해서 화면을 그렸는지와 무관하다.
  const frame = () => new Promise(r => setTimeout(r, 16));
  async function goTo(y, label) { scrollTo(0, y); await frame(); step(label); }

  // 결정적 난수 (같은 글이면 같은 점프)
  function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

  async function scenario(opt) {
    const H = innerHeight;
    const max = () => document.documentElement.scrollHeight - H;
    await goTo(0, 'top');
    for (let y = H / 2; y <= max(); y += H / 2) await goTo(y, 'walk');
    await goTo(max(), 'bottom');
    const r = rng(opt.seed || 73);
    for (let i = 0; i < (opt.jumps ?? 30); i++) await goTo(Math.round(r() * max()), 'jump');
    // 접힌 <details> 펼치기 → 그 자리 · 조금 아래 → 다시 접기 (바깥 것만, 앞에서 opt.toggles 개)
    const ds = [...document.querySelectorAll('details:not([open])')]
      .filter(d => !d.parentElement || !d.parentElement.closest('details')).slice(0, opt.toggles ?? 4);
    for (const d of ds) {
      d.scrollIntoView({ block: 'center' }); await frame(); step('fold:before');
      d.open = true; await frame(); step('fold:open');
      scrollBy(0, H / 3); await frame(); step('fold:open+');
      d.open = false; await frame(); step('fold:closed');
    }
    // 화면 안 가로 스크롤 상자를 끝까지 밀었다가 되돌림
    const sc = [...document.querySelectorAll('*')].filter(e => {
      const s = getComputedStyle(e);
      return /(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1 && e.checkVisibility();
    }).slice(0, opt.scrollers ?? 3);
    for (const e of sc) {
      e.scrollIntoView({ block: 'center' }); await frame(); step('hscroll:0');
      e.scrollLeft = e.scrollWidth; await frame(); step('hscroll:end');
      e.scrollLeft = 0; await frame();
    }
    await goTo(0, 'top-again');
  }

  function q(arr, p) { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0; }
  const r1 = v => Math.round(v * 10) / 10;

  function result() {
    const st = S.steps;
    const o = st.map(s => s.oldMs), n = st.map(s => s.newMs);
    return {
      done: S.done, err: S.err, info: S.info, steps: st.length,
      mismatchSteps: st.filter(s => !s.ok).length,
      oldMs: { p50: r1(q(o, 0.5)), p95: r1(q(o, 0.95)), max: r1(Math.max(0, ...o)) },
      newMs: { p50: r1(q(n, 0.5)), p95: r1(q(n, 0.95)), max: r1(Math.max(0, ...n)) },
      visMax: Math.max(0, ...st.map(s => s.vis)),
      foldSteps: st.filter(s => s.label.startsWith('fold')).map(s => [s.label, s.vis, s.ok, s.foldedOld, s.foldedNew]),
      mism: S.mism,
    };
  }

  function start(opt = {}) {
    S.steps = []; S.mism = []; S.done = false; S.err = null;
    scenario(opt).then(() => { S.done = true; }, (e) => { S.err = String(e && e.stack || e); S.done = true; });
    return 'started';
  }

  window.VC = { load, start, step, result, state: S };
})();
