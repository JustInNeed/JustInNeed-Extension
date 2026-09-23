#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_session.py
================
content.js가 export한 세션 JSON의 *구조적 불변식*을 검사한다.

왜 이게 필요한가:
  content.js를 파일 여러 개로 쪼개는 동안, "동작이 안 깨졌는지"를 확인할
  회귀 테스트를 만들 수가 없다. 사람의 스크롤을 재현할 수 없으므로 출력이
  매번 다르기 때문이다.
  대신 "제대로 돌았다면 반드시 성립하는 성질"을 검사한다. 분할 과정에서
  실제로 깨지는 종류의 버그(상태 소유권 이관 실패, pid 오염, 틱 지연)는
  전부 여기 걸린다.

사용법:
  python check_session.py session.json
  python check_session.py *.json          # 여러 개 한 번에
  python check_session.py a.json --units-baseline baseline_units.txt

  # 기준선 파일 만들기 (Step 0)
  python check_session.py baseline_session.json --dump-units > baseline_units.txt

종료 코드: 0 = 전부 통과, 1 = FAIL 있음
"""

import argparse
import json
import statistics
import sys

TICK_TOLERANCE = 0.20     # 틱 간격 중앙값 허용 오차 (±20%)
OK, WARN, FAIL = "PASS", "WARN", "FAIL"


class Report:
    def __init__(self, path):
        self.path = path
        self.rows = []

    def add(self, level, name, detail=""):
        self.rows.append((level, name, detail))

    @property
    def failed(self):
        return any(lv == FAIL for lv, _, _ in self.rows)

    def show(self):
        print(f"\n=== {self.path} ===")
        mark = {OK: "  ok ", WARN: "  !! ", FAIL: "  XX "}
        for lv, name, detail in self.rows:
            print(f"{mark[lv]}[{lv}] {name}" + (f" — {detail}" if detail else ""))


def ticks_of(timeline):
    return [e for e in timeline if e.get("type") == "tick"]


def all_pids_used(timeline):
    """timeline이 참조하는 모든 pid."""
    used = set()
    for e in timeline:
        for k in ("centerPid", "cursorPid", "pid"):
            v = e.get(k)
            if v:
                used.add(v)
        p = e.get("pids")
        if isinstance(p, list):
            used.update(x for x in p if x)
    return used


# --- 개별 검사 -------------------------------------------------------------
def check_schema(rep, meta):
    """[0] 현재 수집기(v2.2+)가 만든 파일인가.

    이게 아니면 나머지 검사가 전부 무의미하다. 가장 흔한 사고는
    `ls -t ~/Downloads/rbc_*.json | head -1` 이 예전에 받아둔 파일을 집는 것 —
    새 파일을 mv 로 계속 빼내다 보면 Downloads 에는 옛 파일만 남는다.
    """
    v = meta.get("schemaVersion")
    if v is None:
        rep.add(FAIL, "스키마 버전",
                "schemaVersion 없음 — v2.2 이전 파일이다. 현재 수집기가 만든 게 아니므로 "
                "나머지 결과를 믿지 말 것. 패널에서 JSON 을 다시 내보낼 것")
    elif v != 2:
        rep.add(FAIL, "스키마 버전", f"v{v} — 이 검사기는 v2 용이다")
    else:
        started = meta.get("startedAt", "?")
        rep.add(OK, "스키마 버전", f"v2 · 기록 시작 {started}")


def check_pid_integrity(rep, meta, timeline):
    """[1] timeline이 쓰는 pid가 전부 meta.paragraphs에 있는가. 가장 중요."""
    declared = {p["pid"] for p in meta.get("paragraphs", [])}
    used = all_pids_used(timeline)
    orphan = used - declared
    if not declared:
        rep.add(FAIL, "pid 정합성", "meta.paragraphs가 비어 있음 (스캔 실패 세션)")
    elif orphan:
        rep.add(FAIL, "pid 정합성",
                f"meta에 없는 pid {len(orphan)}개가 timeline에 있음 "
                f"(예: {sorted(orphan)[:3]}) — 기록 중 재청킹(BUG-1) 의심")
    else:
        rep.add(OK, "pid 정합성", f"선언 {len(declared)}개 / 사용 {len(used)}개")


def check_tick_interval(rep, meta, ticks):
    """[2] 틱 간격 중앙값이 설정값에 붙어 있는가."""
    want = meta.get("tickMs", 150)
    if len(ticks) < 10:
        rep.add(WARN, "틱 간격", f"틱이 {len(ticks)}개뿐이라 판정 불가")
        return
    gaps = [b["t"] - a["t"] for a, b in zip(ticks, ticks[1:])]
    # 탭 이탈 구간(틱 미기록)은 큰 구멍을 만든다 → 상위 5%는 제외하고 본다
    gaps = sorted(gaps)[: max(1, int(len(gaps) * 0.95))]
    med = statistics.median(gaps)
    lo, hi = want * (1 - TICK_TOLERANCE), want * (1 + TICK_TOLERANCE)
    detail = f"중앙값 {med:.0f}ms (설정 {want}ms)"
    if lo <= med <= hi:
        rep.add(OK, "틱 간격", detail)
    else:
        rep.add(FAIL, "틱 간격", detail + " — 틱 경로에 무거운 코드가 들어옴")


def check_focus_ms(rep, meta, ticks):
    """[3] focusMs == 기록된 틱 수 × tickMs."""
    want = len(ticks) * meta.get("tickMs", 150)
    got = meta.get("focusMs")
    if got is None:
        rep.add(WARN, "focusMs", "필드 없음 (구버전 로그)")
    elif got == want:
        rep.add(OK, "focusMs", f"{got}ms = 틱 {len(ticks)}개")
    else:
        rep.add(FAIL, "focusMs",
                f"기록 {got}ms ≠ 계산 {want}ms — recordedTicks 소유권 이관 실패")


def check_visible_range(rep, meta, ticks):
    """[4] visTop ≤ order(centerPid) ≤ visBot.  — 정보성(WARN까지만).

    틱 하나만 놓고 보면 이게 깨질 수 있고, 그건 정상이다.
    중앙선은 CENTER_Y_TOL(44px)로 여백 너머까지 유닛을 잡는 반면
    가장자리 탐색은 EDGE_Y_TOL(8px)로 엄격하고 H/8 간격으로 건너뛴다.
    두 측정의 해상도가 다르므로 경계에서 1칸 어긋나는 건 설계상 당연하다.
    실제로 문제가 되는 건 이게 누적돼서 노출시간 < 체류시간이 되는 경우이고,
    그건 아래 check_viewport_covers_dwell 이 FAIL 로 잡는다.
    """
    order = {p["pid"]: p.get("order", -1) for p in meta.get("paragraphs", [])}
    checked = bad = 0
    for e in ticks:
        cp, a, b = e.get("centerPid"), e.get("visTop"), e.get("visBot")
        if not cp or a is None or b is None:
            continue
        o = order.get(cp)
        if o is None or o < 0:
            continue
        lo, hi = (a, b) if a <= b else (b, a)
        checked += 1
        if not (lo <= o <= hi):
            bad += 1
    if checked == 0:
        rep.add(WARN, "히트테스트 정합성", "visTop/visBot이 있는 틱이 없음")
    elif bad == 0:
        rep.add(OK, "히트테스트 정합성", f"{checked}개 틱 전부 일관")
    else:
        # 비율로 FAIL 을 매기지 않는다. 짧은 세션에서는 같은 2초짜리 구간이
        # 6% 도 되고 19% 도 된다 — 임계값이 세션 길이에 좌우되면 기준이 아니다.
        # 실제 손상 여부는 check_viewport_covers_dwell 이 절대 기준으로 판정한다.
        ratio = bad / checked
        rep.add(WARN, "히트테스트 정합성",
                f"{bad}/{checked} ({ratio:.1%})에서 중앙선이 노출 범위 밖. "
                f"페이지 최상단 정지 구간이면 정상 — diag_hittest.py 로 확인")


def check_viewport_covers_dwell(rep, meta, ticks):
    """[8] 유닛별 노출시간 >= 중앙선 체류시간 — 원본값 기준. 정보성(WARN까지만).

    원본에서는 이게 깨질 수 있고, 그건 코드가 틀린 게 아니다.
    visTop/visBot 은 뷰포트 상/하단을 H/8 간격으로 찔러 얻은 값이라
    페이지 최상단처럼 가장자리가 헤더·여백인 구간에서 첫 유닛을 놓친다.
    그 사이 중앙선(tol 44px)은 그 유닛을 잡고 있다.

    extract_features.py 가 노출을 "visTop..visBot ∪ centerPid의 order" 로
    합집합 계산해서 이 차이를 메운다. 여기서는 그 보정이 얼마나 필요한지를
    보고만 한다 — 값이 크면 visibleRange 를 실제로 손볼 때가 된 것이다.

    분할 작업의 통과/실패를 가르는 건 구조적 검사([1] pid 정합성,
    [3] focusMs, [5] 카운터, [7] order, 유닛 기준선)이지 이 항목이 아니다.
    """
    order = {p["pid"]: p.get("order", -1) for p in meta.get("paragraphs", [])}
    tick_ms = meta.get("tickMs", 150)

    center = {}
    vis = {}
    for e in ticks:
        cp = e.get("centerPid")
        if cp:
            center[cp] = center.get(cp, 0) + 1
        a, b = e.get("visTop"), e.get("visBot")
        if a is None or b is None:
            continue
        lo, hi = (a, b) if a <= b else (b, a)
        for o in range(lo, hi + 1):
            vis[o] = vis.get(o, 0) + 1

    if not center:
        rep.add(WARN, "노출 ≥ 체류", "중앙선에 걸린 유닛이 없음")
        return

    broken = []
    for pid, n in center.items():
        o = order.get(pid, -1)
        if o < 0:
            continue
        v = vis.get(o, 0)
        if v < n:
            broken.append((o, n * tick_ms / 1000, v * tick_ms / 1000))

    if not broken:
        rep.add(OK, "노출 ≥ 체류(원본)", f"{len(center)}개 유닛 전부 성립")
    else:
        broken.sort()
        head = ", ".join(f"#{o}({d:.1f}s>{vv:.1f}s)" for o, d, vv in broken[:3])
        deficit = sum(d - vv for _, d, vv in broken)
        rep.add(WARN, "노출 ≥ 체류(원본)",
                f"{len(broken)}/{len(center)}개 유닛에서 노출 < 체류 ({head}), "
                f"부족분 합 {deficit:.1f}s — extract_features 가 중앙선 합집합으로 보정")


def check_counters(rep, ticks):
    """[5] mouseEvents / scrollEvents가 살아 있는가 (drain 이관 실패 탐지)."""
    if not ticks:
        rep.add(FAIL, "이벤트 카운터", "틱이 없음")
        return
    mouse = sum(e.get("mouseEvents", 0) or 0 for e in ticks)
    scroll = sum(e.get("scrollEvents", 0) or 0 for e in ticks)
    moved = sum(1 for e in ticks if e.get("cursorMoved"))
    if "mouseEvents" not in ticks[0]:
        rep.add(WARN, "이벤트 카운터", "mouseEvents 필드 없음 (v2.2 이전 로그)")
    elif mouse == 0 and moved > 0:
        rep.add(FAIL, "이벤트 카운터",
                f"cursorMoved 틱이 {moved}개인데 mouseEvents 합이 0 "
                f"— input.drain() 이관 실패")
    else:
        rep.add(OK, "이벤트 카운터", f"mouse {mouse} / scroll {scroll}")


def check_rescan(rep, timeline):
    """[6] 본문 교체가 일어났는가."""
    modes = [e.get("mode") for e in timeline if e.get("type") == "rescan"]
    if "disruptive-skipped" in modes:
        rep.add(FAIL, "본문 교체", "disruptive-skipped 발생 — 이 세션은 학습에서 제외")
    elif modes:
        rep.add(OK, "본문 교체", f"append 재스캔 {modes.count('append')}회 (정상)")
    else:
        rep.add(OK, "본문 교체", "없음")


def check_order_continuity(rep, meta):
    """[7] 유닛 order가 0..n-1 연속인가."""
    paras = meta.get("paragraphs", [])
    orders = sorted(p.get("order", -1) for p in paras)
    if not paras:
        rep.add(FAIL, "유닛 order", "유닛 없음")
    elif orders == list(range(len(paras))):
        rep.add(OK, "유닛 order", f"0..{len(paras) - 1} 연속")
    else:
        rep.add(FAIL, "유닛 order", "불연속/중복 — assignIds 이관 실패")


def check_units_baseline(rep, meta, baseline_path):
    """분할 전후로 유닛 pid 목록이 동일한가. 가장 강력한 회귀 테스트."""
    with open(baseline_path, encoding="utf-8") as f:
        base = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    now = [f"{p.get('order')}\t{p['pid']}\t{p.get('charLen')}"
           for p in meta.get("paragraphs", [])]
    if base == now:
        rep.add(OK, "유닛 기준선", f"{len(now)}개 유닛 완전 일치")
        return
    diff = [i for i, (a, b) in enumerate(zip(base, now)) if a != b]
    rep.add(FAIL, "유닛 기준선",
            f"기준선 {len(base)}개 vs 현재 {len(now)}개, "
            f"첫 불일치 index {diff[0] if diff else len(min(base, now, key=len))} "
            f"— 청킹 로직 이관 중 손실")


# --- main -----------------------------------------------------------------
def run(path, baseline=None):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    meta = data.get("meta", {})
    timeline = data.get("timeline", [])
    ticks = ticks_of(timeline)

    rep = Report(path)
    check_schema(rep, meta)
    check_pid_integrity(rep, meta, timeline)
    check_tick_interval(rep, meta, ticks)
    check_focus_ms(rep, meta, ticks)
    check_visible_range(rep, meta, ticks)
    check_viewport_covers_dwell(rep, meta, ticks)
    check_counters(rep, ticks)
    check_rescan(rep, timeline)
    check_order_continuity(rep, meta)
    if baseline:
        check_units_baseline(rep, meta, baseline)

    rep.show()
    print(f"  -- 유닛 {len(meta.get('paragraphs', []))}개 · 틱 {len(ticks)}개 · "
          f"이벤트 {len(timeline)}개 · schema v{meta.get('schemaVersion', '?')}")
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--units-baseline", help="기준선 유닛 목록 파일")
    ap.add_argument("--dump-units", action="store_true",
                    help="유닛 목록을 stdout으로 출력 (기준선 파일 생성용)")
    args = ap.parse_args()

    if args.dump_units:
        with open(args.inputs[0], encoding="utf-8") as f:
            meta = json.load(f).get("meta", {})
        print(f"# {meta.get('url')}")
        for p in meta.get("paragraphs", []):
            print(f"{p.get('order')}\t{p['pid']}\t{p.get('charLen')}")
        return

    reports = [run(p, args.units_baseline) for p in args.inputs]
    bad = [r for r in reports if r.failed]
    print()
    if bad:
        print(f"FAIL — {len(bad)}/{len(reports)} 파일에서 불변식 위반")
        sys.exit(1)
    print(f"통과 — {len(reports)}개 파일 전부 OK")


if __name__ == "__main__":
    main()