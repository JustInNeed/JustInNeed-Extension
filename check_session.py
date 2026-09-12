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
    """[4] visTop ≤ order(centerPid) ≤ visBot."""
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
        ratio = bad / checked
        lvl = FAIL if ratio > 0.02 else WARN
        rep.add(lvl, "히트테스트 정합성",
                f"{bad}/{checked} ({ratio:.1%})에서 중앙선이 노출 범위 밖 "
                f"— visibleRange/unitAtCenterLine 불일치")


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
    check_pid_integrity(rep, meta, timeline)
    check_tick_interval(rep, meta, ticks)
    check_focus_ms(rep, meta, ticks)
    check_visible_range(rep, meta, ticks)
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