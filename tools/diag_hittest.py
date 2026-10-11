#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diag_hittest.py
===============
check_session.py 의 [4] 히트테스트 정합성이 FAIL 났을 때, 그게
 (a) 측정 해상도 차이로 생긴 무해한 불일치인지
 (b) dwell_viewport_sec 를 실제로 망가뜨리는 버그인지
를 가르기 위한 진단 스크립트.

핵심은 맨 아래 3번 표다.
  viewport 노출 시간 < 중앙선 dwell 시간  인 유닛이 하나라도 있으면 (b),
  전부 viewport >= dwell 이면 (a) 로 보고 넘어가도 된다.
  (노출은 정의상 중앙선 체류의 상위 집합이어야 하므로)

사용법:
  python3 diag_hittest.py baseline_session.json
"""

import json
import sys
from collections import Counter


def main():
    if len(sys.argv) < 2:
        print("사용법: python3 diag_hittest.py <session.json>", file=sys.stderr)
        sys.exit(2)

    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)

    meta = data.get("meta", {})
    timeline = data.get("timeline", [])
    tick_ms = meta.get("tickMs", 150)
    order = {p["pid"]: p.get("order", -1) for p in meta.get("paragraphs", [])}
    text = {p.get("order", -1): p.get("text", "")[:30] for p in meta.get("paragraphs", [])}
    ticks = [e for e in timeline if e.get("type") == "tick"]

    # ---------------------------------------------------------------- 1) 위반 틱
    bad = []
    checked = 0
    for i, e in enumerate(ticks):
        cp, a, b = e.get("centerPid"), e.get("visTop"), e.get("visBot")
        if not cp or a is None or b is None:
            continue
        o = order.get(cp)
        if o is None or o < 0:
            continue
        checked += 1
        lo, hi = (a, b) if a <= b else (b, a)
        if not (lo <= o <= hi):
            bad.append((i, e, o, lo, hi))

    print(f"\n[1] 위반 틱  {len(bad)} / {checked} 검사 대상 "
          f"({len(bad) / checked:.1%})" if checked else "[1] 검사 대상 없음")
    if not bad:
        print("    위반 없음.")
    else:
        print(f"\n{'idx':>5} {'t(s)':>7} {'scrollY':>8} {'spd':>7} "
              f"{'center':>6} {'visTop':>6} {'visBot':>6} {'gap':>4}  방향")
        for i, e, o, lo, hi in bad:
            gap = (lo - o) if o < lo else (o - hi)
            side = "center < visTop" if o < lo else "center > visBot"
            print(f"{i:>5} {e.get('t', 0) / 1000:>7.1f} {e.get('scrollY', 0):>8} "
                  f"{e.get('scrollSpeed', 0):>7} {o:>6} {lo:>6} {hi:>6} {gap:>4}  {side}")

    # ---------------------------------------------------------------- 2) 연속 구간
    if bad:
        runs = []
        prev = None
        for i, *_ in bad:
            if prev is not None and i - prev <= 3:
                runs[-1].append(i)
            else:
                runs.append([i])
            prev = i
        print(f"\n[2] 연속 구간 {len(runs)}개 — "
              + ", ".join(f"{r[0]}~{r[-1]}({len(r)}틱)" for r in runs))
        print("    한두 구간에 뭉쳐 있으면 특정 지점(사진·표) 문제.")
        print("    전 구간에 흩어져 있으면 구조적 문제.")

        gaps = Counter((lo - o) if o < lo else (o - hi) for _, _, o, lo, hi in bad)
        print(f"    gap 분포: " + ", ".join(f"{g}칸 {n}회" for g, n in sorted(gaps.items())))
        print("    전부 1칸이면 경계 해상도 차이. 2칸 이상이 섞이면 탐색이 크게 어긋난 것.")

    # ------------------------------------------------- 3) 파이프라인 영향 (핵심)
    center_ticks = Counter(e["centerPid"] for e in ticks if e.get("centerPid"))
    vis_ticks = Counter()
    for e in ticks:
        a, b = e.get("visTop"), e.get("visBot")
        if a is None or b is None:
            continue
        lo, hi = (a, b) if a <= b else (b, a)
        for o in range(lo, hi + 1):
            vis_ticks[o] += 1

    print(f"\n[3] 파이프라인 영향 — dwell_viewport_sec >= dwell_sec 인가")
    print(f"{'unit':>5} {'dwell(B)':>10} {'viewport':>10}  {'':2} 본문")
    broken = 0
    for pid, n in sorted(center_ticks.items(), key=lambda kv: order.get(kv[0], -1)):
        o = order.get(pid, -1)
        v = vis_ticks.get(o, 0)
        bad_row = v < n
        broken += bad_row
        mark = "XX" if bad_row else "ok"
        print(f"{o:>5} {n * tick_ms / 1000:>10.2f} {v * tick_ms / 1000:>10.2f}  {mark} "
              f"{text.get(o, '')}")

    print()
    if broken:
        print(f"=> (b) 실제 버그. {broken}개 유닛에서 노출시간 < 체류시간. "
              f"visibleRange 가 유닛을 놓치고 있다 — 고쳐야 함.")
        sys.exit(1)
    else:
        print("=> (a) 무해. 모든 유닛에서 노출시간 >= 체류시간이 성립한다.")
        print("   틱 단위 불일치는 CENTER_Y_TOL(44px) 과 EDGE_Y_TOL(8px) 의 "
              "해상도 차이로 상쇄됐다.")
        print("   check_session.py 의 [4] 검사를 WARN 으로 낮추고 진행해도 된다.")


if __name__ == "__main__":
    main()