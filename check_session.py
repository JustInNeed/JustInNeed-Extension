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

스키마 v3 전용 (감사 §8). schemaVersion 이 3 미만이면 "지원 안 함"으로 그 페이지 검사를 멈춘다.

세션 bundle (background 가 만든 것):
  { kind: 'rbc-session', session: {...}, pages: [ 페이지 payload, ... ] }
  pages 의 각 원소에 기존 검사를 그대로 돌리고, 세션 단위 검사를 추가로 돌린다.
    [S1] 조각 유실 (chunkReport.missing)       FAIL
    [S2] page 기록 없는 조각 (orphan)           FAIL
    [S3] 조각 중복 (duplicates)                 WARN — 제거는 됐지만 재전송이 있었다는 뜻
    [S4] 열린 채 끝난 구간 (end=open)           WARN — 녹화 중 export 또는 꼬리 유실
    [S5] 안전망에 걸린 페이지 (droppedPages)    WARN
  페이지마다 추가:
    [10] 이벤트의 segId 가 meta.segments 에 있는가   FAIL
    [11] 포착 못 한 스크롤 (감사 §6-D)                 FAIL / WARN
         화면에 보이는 유닛이 바뀌었는데 scrollY 도 그대로, scrollEvents 도 0 인 틱 쌍.
         v2 는 스크롤 리스너가 window 에만 있어서 내부 컨테이너 스크롤이 이렇게 나타났다.
         v3 세트 C 부터 scrollY · scrollEvents 는 본문 스크롤 주체 기준 (감사 §8-6).
    [12] 본문 추출 의심 (감사 §6-F)                    FAIL
         긴 페이지를 스크롤했는데 유닛 글자가 거의 없으면 루트를 잘못 고른 것.
         [11] 은 유닛이 없으면 '판정 대상 없음'으로 통과하므로 이게 따로 필요하다.
    [13] 조각 연결 (감사 §8-4)                        FAIL
         유닛마다 pieces 가 text 를 빈틈 · 겹침 없이 나누는가. 첫 off = 0,
         다음 off = 앞 off + chars, 마지막 끝 = charLen, 0 < chars, 0 <= linkChars <= chars,
         path 칸 4개 · 최대 6단계, pathCut 이면 정확히 6단계.
         + 모든 틱에 vis 키, vis 칸 6개, pid 가 paragraphs 에 있고 k < pieces 개수, top ≤ bottom, left ≤ right.
    [14] vis 교차검사 (감사 §8 검증 장치)
         caret 탐침(centerPid · visTop/visBot)과 Range 사각형(vis)은 따로 잰 값이다.
         centerPid ∉ vis 틱이 하나라도 있으면 FAIL — 중앙선 ±44px 의 글자는 반드시 화면 안이다.
         visTop..visBot ⊄ vis 는 WARN — 가장자리 탐침이 화면 밖 8px 까지 받아주는 설계 차이.
    [15] 스크롤 교차검사 (감사 §8 검증 장치)            WARN
         같은 구간의 연속 두 틱에서 둘 다 보인 조각 (pid,k) 의 top 이동량 중앙값 vs scrollY 변화량.
         2px 넘게 어긋난 쌍이 하나라도 있으면 WARN — 스크롤 주체 판정이나 vis 가 틀렸을 수 있다.
         비교 대상 = 무언가 움직인 쌍. [11] 과 같이 간격 끊김 · docH/vh/vw/dpr 변화 · rescan 사이 쌍은 뺀다.
    [16] v3 필드 (감사 §8 "v3 tick 최종 필드" · §8-5)  FAIL
         틱 필수 필드 누락 · 삭제 필드(scrollSpeed · cursorDist · cursorMoved) 잔존,
         highlight/copy 의 ranges 누락 · 형식(0 ≤ lo < hi ≤ charLen) · pids/pid 잔존,
         틱이 있는데 scroller 이벤트 없음. 세트 B 이전 파일은 FAIL — 정상.
    [17] 라벨 v2 (라벨_명세_v2.md §8)                 FAIL / WARN
         취소 아닌 마지막 label 이 정답. 라벨 없는 페이지는 '검사 대상 없음'으로 통과.
         FAIL: v2 아님 · 필수 필드 · ratings ∪ excluded = 전체 유닛(겹침 없음) · 값 5종 ·
               marks ⊆ 평정 대상(중복 없음) · 설문 3문항 값 · ratingLog 최종값 = ratings ·
               라벨 모드(label 의 startT..t) 안에 tick/highlight/copy 이벤트.
               (labelask 카드 구간은 기록이 정상 — 카드를 무시하고 읽는 사람 대비, 2026-10-07)
         WARN: 기억 안 남 > 50% · 평정 간격 중앙값 < 300ms (대충 찍기) ·
               한 번도 화면에 안 나온 유닛이 read/focus (평가 중 새로 읽음 의심, 명세 §10).
  세션 단위 추가:
    [S6] stopReason == 'labeled' 이면 취소 아닌 label 이 어느 페이지엔가 있다  FAIL
  --units-baseline 은 기준선 파일 첫 줄(# URL)과 같은 글인 페이지에만 적용한다.

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
from urllib.parse import urlsplit

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
        for k in ("centerPid", "cursorPid"):
            v = e.get(k)
            if v:
                used.add(v)
        r = e.get("ranges")                      # v3 highlight / copy
        if isinstance(r, list):
            used.update(x[0] for x in r if isinstance(x, list) and x and x[0])
        if e.get("type") == "label":             # 라벨 v2: 평정 · 제외 · 중요 표시
            used.update((e.get("ratings") or {}).keys())
            used.update(e.get("excluded") or [])
            used.update(e.get("marks") or [])
    return used


# --- 개별 검사 -------------------------------------------------------------
def check_schema(rep, meta):
    """[0] 스키마 v3 파일인가. 아니면 False — 나머지 검사를 돌리지 않는다.

    가장 흔한 사고는 `ls -t ~/Downloads/rbc_*.json | head -1` 이 예전에 받아둔 파일을
    집는 것 — 새 파일을 mv 로 계속 빼내다 보면 Downloads 에는 옛 파일만 남는다.
    """
    v = meta.get("schemaVersion")
    if not isinstance(v, int) or v < 3:
        rep.add(FAIL, "스키마 버전",
                f"v{v} — 지원 안 함 (v3 전용). 나머지 검사 생략. 새로 기록해서 내보낼 것")
        return False
    rep.add(OK, "스키마 버전",
            f"v{v} · {meta.get('collector', '?')} · 기록 시작 {meta.get('startedAt', '?')}")
    return True


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

    합집합 보정(visTop..visBot ∪ centerPid)은 철회된 결정이다. 노출은 스키마 v3 의
    유닛별 화면 구간(tick.vis, 감사 §8-1)으로 대체된다. 여기서는 원본의 차이를
    보고만 한다.

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
                f"부족분 합 {deficit:.1f}s — 가장자리 탐색(H/8)의 한계. v3 tick.vis 로 대체 예정")


def check_counters(rep, ticks):
    """[5] mouseEvents / scrollEvents가 살아 있는가 (drain 이관 실패 탐지)."""
    if not ticks:
        rep.add(FAIL, "이벤트 카운터", "틱이 없음")
        return
    mouse = sum(e.get("mouseEvents", 0) or 0 for e in ticks)
    scroll = sum(e.get("scrollEvents", 0) or 0 for e in ticks)
    moved = sum(1 for e in ticks if (e.get("mdx", 0) or 0) + (e.get("mdy", 0) or 0) > 0)
    if "mouseEvents" not in ticks[0]:
        rep.add(WARN, "이벤트 카운터", "mouseEvents 필드 없음 (v2.2 이전 로그)")
    elif mouse == 0 and moved > 0:
        rep.add(FAIL, "이벤트 카운터",
                f"mdx+mdy>0 틱이 {moved}개인데 mouseEvents 합이 0 "
                f"— input.drain() 이관 실패")
    else:
        rep.add(OK, "이벤트 카운터", f"mouse {mouse} / scroll {scroll}")


def tick_pids(e):
    """틱 하나가 참조하는 pid 들."""
    out = set()
    for k in ("centerPid", "cursorPid"):          # visTop/visBot 은 order(정수)라 pid 가 아님
        if e.get(k):
            out.add(e[k])
    for p in e.get("vis") or []:
        if p and p[0]:
            out.add(p[0])
    return out


def check_rescan(rep, timeline, meta=None):
    """[6] 기록 중 본문 변경. splice(0-B) 는 처리된 것 — 규모만 본다. disruptive-skipped(옛 확장)는 학습 제외."""
    modes = [e.get("mode") for e in timeline if e.get("type") == "rescan"]
    if "disruptive-skipped" in modes:
        first = next(e for e in timeline
                     if e.get("type") == "rescan" and e.get("mode") == "disruptive-skipped")
        d = first.get("diff")
        if d:
            where = f"유닛 #{d['unit']}" if d.get("unit") is not None else "유닛 밖"
            why = (f" 첫 번째(t={first.get('t', 0) / 1000:.1f}s): {where} · 위치 {d.get('at')} · "
                   f"{d.get('oldLen')}→{d.get('newLen')}자 · "
                   f"…{d.get('ctx', '')} ⟨{d.get('old', '')}⟩ → ⟨{d.get('new', '')}⟩")
        else:
            why = " (diff 없음)"
        rep.add(FAIL, "본문 교체",
                f"disruptive-skipped {modes.count('disruptive-skipped')}회 — 옛 확장 기록, 학습에서 제외.{why}")
        return
    sps = [e for e in timeline if e.get("type") == "rescan" and e.get("mode") == "splice"]
    if not sps:
        if modes:
            rep.add(OK, "본문 교체", f"append 재스캔 {modes.count('append')}회 (정상)")
        else:
            rep.add(OK, "본문 교체", "없음")
        return
    probs, warns = [], []
    roots = [e for e in sps if e.get("rootChanged")]
    if roots:
        r0 = roots[0]
        probs.append(f"기록 중 본문 루트가 바뀜 {len(roots)}회 (t={r0.get('t', 0) / 1000:.1f}s "
                     f"{r0.get('rootFrom')} → {r0.get('rootTo')}) — 그 전 구간은 다른 영역을 기록한 것")
    bads = [e for e in sps if (e.get("check") or [0, 0])[0] > 0]
    if bads:
        probs.append(f"splice 자체 검증 실패 {len(bads)}회 (유닛 글 ≠ 원문 · 겹침 · pid 중복 {bads[0]['check'][0]}개)")
    unc = max(((e.get("check") or [0, 0])[1] for e in sps), default=0)
    if unc > 30:
        warns.append(f"어느 유닛에도 안 든 글자 최대 {unc}자")
    # 큰 변경(유닛 절반 넘게 사라짐)은 정보로만: 노션 큰 토글을 닫으면 정상적으로 생긴다(2026-10-08 실측 4회).
    #   다른 글로 바뀌는 경우는 주소가 바뀌어 구간이 닫히고, 같은 영역 밖으로 가면 rootChanged 가 FAIL 로 잡는다.
    big = [e for e in sps if (e.get("retired") or 0) >= 5
           and (e.get("retired") or 0) > 0.5 * ((e.get("kept") or 0) + (e.get("retired") or 0))]
    retired = {p["pid"] for p in (meta or {}).get("paragraphs", []) if p.get("retired")}
    last_t = max(e.get("t", 0) for e in sps)
    stale = [e for e in timeline if e.get("type") == "tick" and e.get("t", 0) > last_t
             and tick_pids(e) & retired]
    if stale:
        probs.append(f"마지막 splice 뒤 틱 {len(stale)}개가 사라진 유닛을 가리킴")
    tot = (sum(e.get("kept") or 0 for e in sps[-1:]), sum(e.get("added") or 0 for e in sps),
           sum(e.get("retired") or 0 for e in sps))
    d = sps[0].get("diff") or {}
    chk = "자체 검증 " + ("전부 [0,0]" if all((e.get("check") or [0, 0]) == [0, 0] for e in sps)
                         else "/".join(str(e.get("check")) for e in sps[:5]))
    detail = (f"splice {len(sps)}회 (큰 변경 {len(big)}) · 새 유닛 {tot[1]} · 사라진 유닛 {tot[2]}(retired) · 마지막 유지 {tot[0]} · {chk} · "
              f"루트 {sps[-1].get('root')} · 첫 변경 t={sps[0].get('t', 0) / 1000:.1f}s 유닛 #{d.get('unit')} ⟨{d.get('new', '')}⟩")
    if probs:
        rep.add(FAIL, "본문 교체", " · ".join(probs) + " — " + detail)
    elif warns:
        rep.add(WARN, "본문 교체", " · ".join(warns) + " — " + detail)
    else:
        rep.add(OK, "본문 교체", detail)


def check_rescan_cost(rep, timeline):
    """재스캔 비용 (0-B 성능). 기록 중 재스캔 간격을 1.5초로 줄였으므로 실제 비용을 본다. 정보성(WARN까지만).
    글이 바뀐 재스캔은 rescan 이벤트의 ms, 글이 그대로인 재스캔(mode same)은 다음 이벤트에 얹힌 same=[횟수, 합 ms, 최대 ms]."""
    ev = [e for e in timeline if e.get("type") == "rescan" and isinstance(e.get("ms"), (int, float))]
    same = [e["same"] for e in timeline if isinstance(e.get("same"), list) and len(e["same"]) == 3]
    if not ev and not same:
        rep.add(OK, "재스캔 비용", "기록 중 재스캔 없음 (또는 측정 이전 확장)")
        return
    ms = sorted(e["ms"] for e in ev)
    s_n = sum(x[0] for x in same)
    s_tot = sum(x[1] for x in same)
    s_max = max((x[2] for x in same), default=0)
    worst = max(ms[-1] if ms else 0, s_max)
    dur = (max(e.get("t", 0) for e in timeline) - min(e.get("t", 0) for e in timeline)) / 1000 or 1
    load = (sum(ms) + s_tot) / 1000 / dur
    detail = (f"글 변경 {len(ms)}회 (중앙 {ms[len(ms) // 2] if ms else 0}ms · 최대 {ms[-1] if ms else 0}ms) · "
              f"글 그대로 {s_n}회 (최대 {s_max}ms) · 기록 시간 대비 {load:.2%}")
    rep.add(WARN if worst > 100 or load > 0.02 else OK, "재스캔 비용",
            detail + (" — 한 번에 100ms 넘거나 전체의 2% 넘음, 틱이 흔들릴 수 있음" if worst > 100 or load > 0.02 else ""))


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
           for p in meta.get("paragraphs", []) if not p.get("retired")]
    if base == now:
        rep.add(OK, "유닛 기준선", f"{len(now)}개 유닛 완전 일치")
        return
    diff = [i for i, (a, b) in enumerate(zip(base, now)) if a != b]
    rep.add(FAIL, "유닛 기준선",
            f"기준선 {len(base)}개 vs 현재 {len(now)}개, "
            f"첫 불일치 index {diff[0] if diff else len(min(base, now, key=len))} "
            f"— 청킹 로직 이관 중 손실")


def check_segments(rep, meta, timeline):
    """[10] 모든 이벤트가 이 페이지의 구간(meta.segments) 중 하나에 속하는가.

    background 가 같은 글의 구간들을 한 페이지로 합칠 때 다른 글의 조각이
    섞이면 여기서 걸린다. 차분 리셋 규칙도 segId 에 기대므로 빠지면 안 된다.
    """
    segs = meta.get("segments")
    if segs is None:
        return                                          # 단일 payload (v2.2) — 해당 없음
    known = {g.get("segId") for g in segs}
    missing_seg = sum(1 for e in timeline if not e.get("segId"))
    foreign = {e.get("segId") for e in timeline if e.get("segId") and e.get("segId") not in known}
    no_tab = sum(1 for e in timeline if e.get("tabId") is None)
    if missing_seg or foreign:
        rep.add(FAIL, "구간 정합성",
                f"segId 없음 {missing_seg}개 · 선언 안 된 segId {len(foreign)}종 "
                f"— 다른 글의 조각이 섞였거나 조립 오류")
    elif no_tab:
        rep.add(WARN, "구간 정합성", f"tabId 없는 이벤트 {no_tab}개")
    else:
        tabs = {g.get("tabId") for g in segs}
        rep.add(OK, "구간 정합성", f"구간 {len(segs)}개 · 탭 {len(tabs)}개")


# [11] 포착 못 한 스크롤 ------------------------------------------------------
SCROLL_GAP_TOL = 1.8        # 두 틱 간격이 tickMs 의 이 배수를 넘으면 연속 아님 (extract_features 와 같은 값)
UNSEEN_FAIL_MIN = 3         # 이 이상이면서
UNSEEN_FAIL_RATIO = 0.2     # 화면이 바뀐 쌍 중 이 비율 이상이면 FAIL
IFRAME_STATIC_MIN_TICKS = 40  # iframe 본문에서 이만큼(≈6초) 틱이 있는데 스크롤 흔적이 전혀 없으면 WARN


def check_scroll_capture(rep, meta, timeline, ticks):
    """[11] 화면 내용이 움직였는데 스크롤이 기록되지 않은 틱 쌍을 센다.

    판정 대상은 같은 구간(segId)의 연속된 두 틱이다. 그 사이에
      - 보이는 유닛 범위(visTop/visBot)가 바뀌었고
      - scrollY 변화도, scrollEvents 도 없으면
    '포착 못 한 스크롤'로 센다.

    레이아웃이 밀려서 내용이 움직이는 경우(이미지 늦게 로드, 재스캔)는 스크롤이 아니다.
    그래서 docH · vh · vw 가 바뀐 쌍과, 그 사이에 rescan 이벤트가 있는 쌍은 뺀다.

    iframe 본문은 이 방식으로 못 잡는다 — 바깥 창이 스크롤되면 iframe 안에서는
    visTop/visBot 도 scrollY 도 그대로라 '움직임'조차 안 보인다. 그래서 iframe 은
    '스크롤 흔적이 전혀 없음'을 따로 WARN 으로 알린다.
    """
    tick_ms = meta.get("tickMs", 150)
    rescans = sorted(e.get("t", 0) for e in timeline if e.get("type") == "rescan")

    def rescan_between(a, b):
        return any(a < t <= b for t in rescans)

    moved = unseen = 0
    examples = []
    ordered = sorted(ticks, key=lambda e: e.get("t", 0))
    for prev, cur in zip(ordered, ordered[1:]):
        if prev.get("segId") != cur.get("segId"):
            continue
        if cur.get("t", 0) - prev.get("t", 0) > tick_ms * SCROLL_GAP_TOL:
            continue
        if any(prev.get(k) != cur.get(k) for k in ("docH", "vh", "vw")):
            continue
        if rescan_between(prev.get("t", 0), cur.get("t", 0)):
            continue
        a0, b0, a1, b1 = prev.get("visTop"), prev.get("visBot"), cur.get("visTop"), cur.get("visBot")
        if None in (a0, b0, a1, b1) or (a0, b0) == (a1, b1):
            continue
        moved += 1
        if cur.get("scrollY") == prev.get("scrollY") and not cur.get("scrollEvents"):
            unseen += 1
            if len(examples) < 3:
                examples.append(f"t={cur.get('t', 0) / 1000:.1f}s [{a0},{b0}]→[{a1},{b1}]")

    if meta.get("isTopFrame") is False and len(ticks) >= IFRAME_STATIC_MIN_TICKS:
        ys = {e.get("scrollY") for e in ticks}
        evs = sum(e.get("scrollEvents", 0) or 0 for e in ticks)
        if len(ys) <= 1 and evs == 0:
            rep.add(WARN, "스크롤 포착(iframe)",
                    f"본문이 iframe 인데 틱 {len(ticks)}개 동안 scrollY 불변 · scrollEvents 0 — "
                    f"바깥 창이 스크롤되는 구조면 스크롤이 전혀 기록되지 않는다. 실제로 스크롤했다면 문제")

    if moved == 0:
        rep.add(OK, "스크롤 포착", "화면 범위가 바뀐 틱 쌍 없음 (판정 대상 없음)")
    elif unseen == 0:
        rep.add(OK, "스크롤 포착", f"화면이 바뀐 {moved}쌍 전부 스크롤 기록 있음")
    elif unseen >= UNSEEN_FAIL_MIN and unseen / moved >= UNSEEN_FAIL_RATIO:
        rep.add(FAIL, "스크롤 포착",
                f"화면이 바뀐 {moved}쌍 중 {unseen}쌍({unseen / moved:.0%})에 스크롤 기록 없음 "
                f"({'; '.join(examples)}) — 내부 스크롤 컨테이너 의심")
    else:
        rep.add(WARN, "스크롤 포착",
                f"화면이 바뀐 {moved}쌍 중 {unseen}쌍에 스크롤 기록 없음 ({'; '.join(examples)}) "
                f"— 소수면 레이아웃 흔들림일 수 있음")



# [12] 본문 추출 의심 --------------------------------------------------------
EXTRACT_MIN_CHARS = 400      # 유닛 글자 합이 이보다 적으면 '본문이 거의 없음' (청크 200 기준 2유닛)
EXTRACT_MIN_SCREENS = 3      # 문서 높이가 뷰포트의 이 배수 이상이면 '긴 페이지'
EXTRACT_MIN_SCROLL_EV = 20   # scrollY 가 안 움직여도 스크롤 이벤트가 이만큼이면 '스크롤했음'


def check_extraction(rep, meta, ticks):
    """[12] 루트를 잘못 골라 본문이 빠졌는가.

    findContentRoot() 는 article → main → [role=main] 의 *첫 요소*를 textContent
    길이(공백 포함)로 거른다. 그래서 제목 · 날짜 영역만 감싼 main 이 통과해 유닛이
    한두 개가 되는 사이트가 있다(헤럴드경제, 감사 §6-F). 이 경우 다른 검사는 전부
    '대상 없음'으로 통과하거나 WARN 에 그친다.

    FAIL: 유닛 글자 합 < EXTRACT_MIN_CHARS 인데, 문서가 길고(≥ EXTRACT_MIN_SCREENS 화면)
          실제로 스크롤했다(scrollY 가 한 화면 이상 움직였거나 scrollEvents 가 많음).
    짧은 글 + 긴 댓글처럼 정상인데 걸리는 경우가 있으므로 FAIL 은 '확인 필요' 뜻이다.

    중앙선 적중률은 판정에 쓰지 않고 수치로만 보여준다. 적중률은 추출 품질만이 아니라
    '어디에 오래 머물렀나'(댓글 · 관련기사를 오래 봤나)에 좌우되므로, 문턱을 두면
    읽기 행동을 추출 실패로 오판한다. 정상 기사 실측 20~72% (2026-09-30).
    """
    if not ticks:
        return                                          # [5] 가 이미 FAIL
    chars = sum(p.get("charLen", 0) or 0 for p in meta.get("paragraphs", []))
    units = len(meta.get("paragraphs", []))
    vh = statistics.median(e.get("vh", 0) or 0 for e in ticks) or 0
    doc_h = max(e.get("docH", 0) or 0 for e in ticks)
    ys = [e.get("scrollY", 0) or 0 for e in ticks]
    span = max(ys) - min(ys)
    scroll_ev = sum(e.get("scrollEvents", 0) or 0 for e in ticks)
    hit = sum(1 for e in ticks if e.get("centerPid"))

    screens = doc_h / vh if vh else 0
    scrolled = (vh and span >= vh) or scroll_ev >= EXTRACT_MIN_SCROLL_EV
    facts = (f"유닛 {units}개 · {chars}자 · 문서 {screens:.1f}화면 · "
             f"스크롤 {span:.0f}px/{scroll_ev}회 · 중앙선 적중 {hit}/{len(ticks)}")

    if chars < EXTRACT_MIN_CHARS and screens >= EXTRACT_MIN_SCREENS and scrolled:
        rep.add(FAIL, "본문 추출", f"{facts} — 긴 페이지를 스크롤했는데 본문이 거의 없음. "
                                 f"루트 선택 실패 의심 (패널 '본문 N자' · RBC.stream.root())")
    else:
        rep.add(OK, "본문 추출", facts)

# [13] 조각 연결 ---------------------------------------------------------------
PATH_MAX = 6


def piece_problem(p):
    """유닛 하나의 pieces 문제를 한 줄로. 문제없으면 None."""
    pcs = p.get("pieces")
    n = p.get("charLen")
    if not isinstance(pcs, list) or not pcs:
        return "pieces 없음"
    end = 0
    for k, c in enumerate(pcs):
        off, ch, lk = c.get("off"), c.get("chars"), c.get("linkChars")
        path, cut = c.get("path"), c.get("pathCut")
        if off != end:
            return f"k{k} off {off} ≠ {end} ({'겹침' if isinstance(off, int) and off < end else '빈틈'})"
        if not isinstance(ch, int) or ch <= 0:
            return f"k{k} chars {ch}"
        if not isinstance(lk, int) or not 0 <= lk <= ch:
            return f"k{k} linkChars {lk} / chars {ch}"
        if (not isinstance(path, list) or len(path) > PATH_MAX
                or any(not isinstance(x, list) or len(x) != 4 for x in path)):
            return f"k{k} path 형식"
        if not isinstance(cut, bool) or (cut and len(path) != PATH_MAX):
            return f"k{k} pathCut {cut} · path {len(path)}단계"
        end = off + ch
    if end != n:
        return f"조각 끝 {end} ≠ charLen {n}"
    return None


def vis_problems(meta, ticks):
    """틱 vis 가 조각과 맞는가. (문제 수, 예시 3개)."""
    npieces = {p["pid"]: len(p.get("pieces") or []) for p in meta.get("paragraphs", [])}
    bad, ex = 0, []

    def note(t, why):
        nonlocal bad
        bad += 1
        if len(ex) < 3:
            ex.append(f"t={t / 1000:.1f}s {why}")

    for e in ticks:
        t = e.get("t", 0)
        if "vis" not in e:
            note(t, "vis 키 없음")
            continue
        vis = e.get("vis")
        if not isinstance(vis, list):
            note(t, f"vis={vis!r}")
            continue
        for v in vis:
            if not isinstance(v, list) or len(v) != 6:
                note(t, f"칸 {v!r}")
                break
            pid, k, top, bot, left, right = v
            if pid not in npieces:
                note(t, f"모르는 pid {pid}")
                break
            if not isinstance(k, int) or not 0 <= k < npieces[pid]:
                note(t, f"{pid} k={k} / 조각 {npieces[pid]}")
                break
            if top > bot or left > right:
                note(t, f"{pid}·{k} 사각형 {top},{bot},{left},{right}")
                break
    return bad, ex


def check_pieces(rep, meta, ticks):
    """[13] 조각이 유닛 text 를 빈틈 · 겹침 없이 나누는가 + 틱 vis 가 조각을 제대로 가리키는가.

    오름차순 + 합계만 보면 빈틈과 겹침이 서로 상쇄돼 통과하므로 연결을 본다.
    원문 → 정리된 text 오프셋 변환이 어긋나도 여기서 끝 ≠ charLen 으로 잡힌다.
    """
    paras = meta.get("paragraphs", [])
    bad = [(p.get("order"), why) for p in paras if (why := piece_problem(p))]
    vbad, vex = vis_problems(meta, ticks)
    if bad or vbad:
        parts = []
        if bad:
            parts.append(f"유닛 {len(bad)}/{len(paras)} (" + "; ".join(f"#{o} {w}" for o, w in bad[:3]) + ")")
        if vbad:
            parts.append(f"vis 틱 {vbad}/{len(ticks)} (" + "; ".join(vex) + ")")
        rep.add(FAIL, "조각 연결", " · ".join(parts))
    else:
        rep.add(OK, "조각 연결", f"유닛 {len(paras)}개 전부 연결 · vis 틱 {len(ticks)}개 전부 정합")


def check_vis_cross(rep, meta, ticks):
    """[14] caret 탐침과 Range 사각형의 대조 (감사 §8). 등급은 2026-10-03 블로그 PC 실측으로 결정.

    centerPid 는 화면 한가운데라 거의 항상 vis 에 있어야 한다. visTop..visBot 은 order 범위라
    사이드바가 order 사이에 끼는 사이트(§6-H)에서는 화면에 없는 유닛이 범위에 들어갈 수 있다.
    """
    order = {p["pid"]: p.get("order", -1) for p in meta.get("paragraphs", [])}
    c_n = c_ok = r_n = r_ok = 0
    c_ex, r_ex = [], []
    for e in ticks:
        vis = e.get("vis")
        if not isinstance(vis, list):
            continue
        seen = {v[0] for v in vis if isinstance(v, list) and v}
        seen_o = {order.get(p) for p in seen}
        cp = e.get("centerPid")
        if cp:
            c_n += 1
            if cp in seen:
                c_ok += 1
            elif len(c_ex) < 2:
                c_ex.append(f"t={e.get('t', 0) / 1000:.1f}s #{order.get(cp)}")
        a, b = e.get("visTop"), e.get("visBot")
        if a is not None and b is not None:
            lo, hi = (a, b) if a <= b else (b, a)
            r_n += 1
            miss = [o for o in range(lo, hi + 1) if o not in seen_o]
            if not miss:
                r_ok += 1
            elif len(r_ex) < 2:
                r_ex.append(f"t={e.get('t', 0) / 1000:.1f}s [{lo},{hi}] 빠짐 {miss[:3]}")
    if not c_n and not r_n:
        rep.add(WARN, "vis 교차검사", "대조할 틱 없음")
        return
    pct = lambda ok, n: f"{ok}/{n} ({ok / n:.0%})" if n else "—"
    detail = f"centerPid∈vis {pct(c_ok, c_n)} · visTop..visBot⊂vis {pct(r_ok, r_n)}"
    ex = c_ex + r_ex
    if c_ok < c_n:
        rep.add(FAIL, "vis 교차검사", detail + f" (예: {'; '.join(c_ex)}) — centerPid 귀속 또는 vis 사각형 오류")
    elif r_ok < r_n:
        rep.add(WARN, "vis 교차검사", detail + (f" (예: {'; '.join(r_ex)})" if r_ex else ""))
    else:
        rep.add(OK, "vis 교차검사", detail)


# [15] 스크롤 교차검사 --------------------------------------------------------
SCROLL_CROSS_TOL = 2         # px. vis 좌표는 정수 반올림, scrollY 는 소수가 나온다


def check_scroll_cross(rep, meta, timeline, ticks):
    """[15] vis 조각 이동량 ≈ scrollY 변화량 (감사 §8 검증 장치).

    아래로 스크롤하면 scrollY 는 늘고 조각 top 은 같은 만큼 줄어든다.
    중앙값을 쓰는 이유: sticky 영역 · 늦게 커진 이미지 아래 조각처럼 따로 움직이는 소수를 무시.
    """
    tick_ms = meta.get("tickMs", 150)
    rescans = sorted(e.get("t", 0) for e in timeline if e.get("type") == "rescan")
    n = bad = 0
    ex = []
    ordered = sorted(ticks, key=lambda e: e.get("t", 0))
    for prev, cur in zip(ordered, ordered[1:]):
        if prev.get("segId") != cur.get("segId"):
            continue
        t0, t1 = prev.get("t", 0), cur.get("t", 0)
        if t1 - t0 > tick_ms * SCROLL_GAP_TOL:
            continue
        if any(prev.get(k) != cur.get(k) for k in ("docH", "vh", "vw", "dpr")):
            continue
        if any(t0 < t <= t1 for t in rescans):
            continue
        a = {(v[0], v[1]): v[2] for v in (prev.get("vis") or []) if isinstance(v, list) and len(v) == 6}
        b = {(v[0], v[1]): v[2] for v in (cur.get("vis") or []) if isinstance(v, list) and len(v) == 6}
        common = a.keys() & b.keys()
        if not common:
            continue
        move = statistics.median(a[k] - b[k] for k in common)
        dy = (cur.get("scrollY") or 0) - (prev.get("scrollY") or 0)
        if move == 0 and abs(dy) < 0.5:
            continue                                   # 아무것도 안 움직인 쌍은 비교 대상 아님
        n += 1
        if abs(move - dy) > SCROLL_CROSS_TOL:
            bad += 1
            if len(ex) < 3:
                ex.append(f"t={t1 / 1000:.1f}s 조각 {move:+.0f} vs scrollY {dy:+.1f}")
    if n == 0:
        rep.add(OK, "스크롤 교차검사", "움직인 틱 쌍 없음 (판정 대상 없음)")
    elif bad == 0:
        rep.add(OK, "스크롤 교차검사", f"움직인 {n}쌍 전부 ±{SCROLL_CROSS_TOL}px 안에서 일치")
    else:
        rep.add(WARN, "스크롤 교차검사",
                f"움직인 {n}쌍 중 {bad}쌍({bad / n:.0%}) 어긋남 ({'; '.join(ex)}) "
                f"— 스크롤 주체 판정 또는 vis 오류, 소수면 레이아웃 흔들림")


# [16] v3 필드 ----------------------------------------------------------------
# 감사 §8 "v3 tick 최종 필드" 중 세트 C 까지 들어간 것. media(세트 E) · fo(세트 D, iframe primary) 는 그때 추가.
TICK_REQUIRED = ("type", "t", "segId",
                 "scrollY", "scrollEvents", "scrollOther",
                 "mouseEvents", "mdx", "mdy", "cursorPid", "cx", "cy",
                 "centerPid", "visTop", "visBot",
                 "vis",
                 "edits",
                 "vw", "vh", "docH", "dpr")
TICK_REMOVED = ("scrollSpeed", "cursorDist", "cursorMoved")
SEL_REMOVED = ("pids", "pid")


def check_v3_fields(rep, meta, timeline, ticks):
    """[16] 필수 필드 누락 · 삭제 필드 잔존 · ranges 형식 · scroller 이벤트."""
    probs = []
    miss = {}
    left = {}
    for e in ticks:
        for k in TICK_REQUIRED:
            if k not in e:
                miss[k] = miss.get(k, 0) + 1
        for k in TICK_REMOVED:
            if k in e:
                left[k] = left.get(k, 0) + 1
    if miss:
        probs.append("틱 누락 " + ", ".join(f"{k}×{v}" for k, v in miss.items()))
    if left:
        probs.append("틱 삭제 필드 잔존 " + ", ".join(f"{k}×{v}" for k, v in left.items()))

    clen = {p["pid"]: p.get("charLen", 0) for p in meta.get("paragraphs", [])}
    sels = [e for e in timeline if e.get("type") in ("highlight", "copy")]
    for e in sels:
        tag = f"{e.get('type')} t={e.get('t', 0) / 1000:.1f}s"
        if any(k in e for k in SEL_REMOVED):
            probs.append(f"{tag} pids/pid 잔존")
            break
        r = e.get("ranges")
        if not isinstance(r, list) or not r:
            probs.append(f"{tag} ranges 없음")
            break
        badr = [x for x in r if not (isinstance(x, list) and len(x) == 3 and x[0] in clen
                                     and isinstance(x[1], int) and isinstance(x[2], int)
                                     and 0 <= x[1] < x[2] <= clen[x[0]])]
        if badr:
            probs.append(f"{tag} ranges 형식 {badr[0]!r}")
            break

    if ticks and not any(e.get("type") == "scroller" for e in timeline):
        probs.append("scroller 이벤트 없음")

    if probs:
        rep.add(FAIL, "v3 필드", " · ".join(probs))
    else:
        rep.add(OK, "v3 필드", f"틱 {len(ticks)}개 · 선택/복사 {len(sels)}건 형식 일치")


# [17] 라벨 v2 ----------------------------------------------------------------
RATE_VALUES = {"skip", "skim", "read", "focus", "unsure"}
SURVEY_VALUES = {"gain": {"yes", "partly", "no"}, "interest": {1, 2, 3, 4}, "familiarity": {1, 2, 3, 4}}
LABEL_REQUIRED = {"v": int, "t": (int, float), "startT": (int, float), "ms": (int, float),
                  "trigger": str, "ratings": dict, "ratingLog": list, "excluded": list,
                  "marks": list, "survey": dict, "phaseMs": dict}
FAST_RATE_MS = 300


def final_label(timeline):
    labs = [e for e in timeline if e.get("type") == "label" and not e.get("cancelled")]
    return labs[-1] if labs else None


def check_label(rep, meta, timeline, ticks):
    """[17] 라벨 v2 형식 · 정합 · 라벨 모드 중 기록 없음 · 대충 찍기 의심."""
    name = "라벨 v2"
    # 라벨 모드 구간: label(취소 포함) 의 (startT, t). labelask 카드 구간은 기록이 정상이라 뺀다
    windows = [(e["startT"], e["t"]) for e in timeline
               if e.get("type") == "label"
               and isinstance(e.get("startT"), (int, float)) and isinstance(e.get("t"), (int, float))]
    leak = [e for e in timeline if e.get("type") in ("tick", "highlight", "copy")
            and any(a < e.get("t", -1) < b for a, b in windows)]

    lab = final_label(timeline)
    if lab is None:
        if leak:
            rep.add(FAIL, name, f"라벨 모드 중 기록 {len(leak)}건 (취소된 라벨 구간)")
        else:
            n_ask = sum(1 for e in timeline if e.get("type") == "labelask")
            rep.add(OK, name, f"검사 대상 없음 (완료된 라벨 없음 · 질문 응답 {n_ask}건)")
        return

    probs = []
    if lab.get("v") != 2:
        rep.add(FAIL, name, f"v{lab.get('v', 1)} 형식 — v2 전용. 새로 기록할 것")
        return
    for k, ty in LABEL_REQUIRED.items():
        if not isinstance(lab.get(k), ty):
            probs.append(f"필드 {k} 없음/형식")
    if probs:
        rep.add(FAIL, name, " · ".join(probs))
        return

    allp = [p["pid"] for p in meta.get("paragraphs", []) if not p.get("retired")]   # splice 로 사라진 유닛 제외
    rat, exc, marks = lab["ratings"], lab["excluded"], lab["marks"]
    both = set(rat) & set(exc)
    if both:
        probs.append(f"평정 · 제외 겹침 {len(both)}개")
    missing = set(allp) - set(rat) - set(exc)
    if missing:
        probs.append(f"평정 빠진 유닛 {len(missing)}개")
    extra = (set(rat) | set(exc)) - set(allp)
    if extra:
        probs.append(f"없는 유닛 {len(extra)}개")
    badv = [v for v in rat.values() if v not in RATE_VALUES]
    if badv:
        probs.append(f"평정 값 {badv[0]!r}")
    if len(marks) != len(set(marks)):
        probs.append("marks 중복")
    if set(marks) - set(rat):
        probs.append(f"marks 가 평정 대상 밖 {len(set(marks) - set(rat))}개")
    for k, ok in SURVEY_VALUES.items():
        if lab["survey"].get(k) not in ok:
            probs.append(f"설문 {k}={lab['survey'].get(k)!r}")
    last = {}
    for row in lab["ratingLog"]:
        if isinstance(row, list) and len(row) == 3:
            last[row[0]] = row[1]
        else:
            probs.append(f"ratingLog 형식 {row!r}")
            break
    if last != rat:
        probs.append("ratingLog 최종값 ≠ ratings")
    if leak:
        probs.append(f"라벨 모드 중 기록 {len(leak)}건 (첫 t={leak[0].get('t', 0) / 1000:.1f}s)")
    if probs:
        rep.add(FAIL, name, " · ".join(probs))
        return

    warns = []
    if rat:
        n_uns = sum(1 for v in rat.values() if v == "unsure")
        if n_uns / len(rat) > 0.5:
            warns.append(f"기억 안 남 {n_uns}/{len(rat)}")
    ts = [row[2] for row in lab["ratingLog"]]
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    if len(gaps) >= 3 and statistics.median(gaps) < FAST_RATE_MS:
        warns.append(f"평정 간격 중앙값 {statistics.median(gaps):.0f}ms")
    seen = {p[0] for e in ticks for p in (e.get("vis") or []) if p and len(p) >= 6 and p[5] - p[4] > 0}
    unseen_hi = [pid for pid, v in rat.items() if v in ("read", "focus") and pid not in seen]
    if unseen_hi:
        warns.append(f"화면에 안 나온 유닛이 read/focus {len(unseen_hi)}개")

    cnt = {}
    for v in rat.values():
        cnt[v] = cnt.get(v, 0) + 1
    sv = lab["survey"]
    detail = (f"{lab['trigger']} · {lab['ms'] / 1000:.0f}s · 평정 {len(rat)}(제외 {len(exc)}) "
              + " ".join(f"{k}{cnt.get(k, 0)}" for k in ("skip", "skim", "read", "focus", "unsure"))
              + f" · 중요 {len(marks)} · 설문 {sv.get('gain')}/{sv.get('interest')}/{sv.get('familiarity')}")
    if warns:
        rep.add(WARN, name, " · ".join(warns) + " — " + detail)
    else:
        rep.add(OK, name, detail)


def input_summary(timeline, ticks):
    """세트 C 입력 · 스크롤 요약 (판정 아님)."""
    paths = []
    for e in timeline:
        if e.get("type") == "scroller":
            p = e.get("path")
            if isinstance(p, list) and p:
                d = str(p[0]).lower() + (f"#{p[1]}" if p[1] else "") + (f".{str(p[2]).split(' ')[0]}" if p[2] else "")
            else:
                d = str(p)
            if not paths or paths[-1] != d:
                paths.append(d)
    other = sum(e.get("scrollOther", 0) or 0 for e in ticks)
    ev = sum(e.get("scrollEvents", 0) or 0 for e in ticks)
    ed = sum(1 for e in ticks if (e.get("edits", 0) or 0) > 0)
    ratio = f"{ed}/{len(ticks)} ({ed / len(ticks):.0%})" if ticks else "—"
    return (f"스크롤 주체 {' → '.join(paths) if paths else '없음'} · scrollEvents {ev} · "
            f"scrollOther {other} · edits>0 틱 {ratio}")


def vis_summary(ticks):
    """용량 실측용 (판정 아님)."""
    if not ticks:
        return "vis — 틱 없음"
    n = [len(e.get("vis") or []) for e in ticks]
    size = [len(json.dumps(e, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) for e in ticks]
    return (f"vis 평균 {statistics.mean(n):.1f}조각/틱 (최대 {max(n)}) · "
            f"틱 평균 {statistics.mean(size):.0f}B (최대 {max(size)}B)")


def pieces_summary(meta):
    """사람이 보는 요약 (판정 아님)."""
    paras = meta.get("paragraphs", [])
    pcs = [c for p in paras for c in (p.get("pieces") or [])]
    multi = sum(1 for p in paras if len(p.get("pieces") or []) > 1)
    linked = sum(1 for c in pcs if c.get("linkChars"))
    cut = sum(1 for c in pcs if c.get("pathCut"))
    root = meta.get("root") or {}
    el = root.get("el") or ["?", "", "", ""]
    rdesc = el[0].lower() + (f"#{el[1]}" if el[1] else "") + (f".{el[2].split(' ')[0]}" if el[2] else "")
    return (f"조각 {len(pcs)} · 여러 조각 유닛 {multi} · 링크 글자 있는 조각 {linked} · "
            f"pathCut {cut} · 루트 {rdesc} ({root.get('how', '?')})")


def check_bundle_session(rep, session):
    """[S1]~[S5] 세션 단위 — background 의 조각 보고서."""
    report = session.get("chunkReport") or []
    miss = [r for r in report if r.get("missing")]
    orphan = [r for r in report if r.get("orphan")]
    dup = sum(r.get("duplicates", 0) for r in report)
    opened = [r for r in report if r.get("end") == "open"]
    dropped = session.get("droppedPages") or []

    if miss:
        head = ", ".join(f"{r['segId'][:8]}{r['missing'][:5]}" for r in miss[:3])
        rep.add(FAIL, "조각 유실", f"{len(miss)}개 구간에서 번호 누락 ({head})")
    else:
        rep.add(OK, "조각 유실", f"구간 {len(report)}개 전부 연속")
    if orphan:
        rep.add(FAIL, "고아 조각", f"page 기록 없는 구간 {len(orphan)}개 — 첫 page 메시지 유실")
    if dup:
        rep.add(WARN, "조각 중복", f"{dup}개 (export 에서 제거됨)")
    if opened:
        rep.add(WARN, "열린 구간",
                f"{len(opened)}개 — 녹화 중 export 했거나 마지막 조각 유실")
    else:
        ends = {}
        for r in report:
            ends[r.get("end")] = ends.get(r.get("end"), 0) + 1
        rep.add(OK, "구간 종료", " · ".join(f"{k} {v}" for k, v in sorted(ends.items())))
    if dropped:
        rep.add(WARN, "제외된 페이지",
                ", ".join(f"{d.get('reason')}:{str(d.get('pageId'))[:40]}" for d in dropped[:3]))


def same_article(url_a, url_b):
    """기준선 URL 과 페이지 URL 이 같은 글인가 (호스트 + 경로)."""
    try:
        a, b = urlsplit(url_a), urlsplit(url_b)
        return (a.netloc, a.path.rstrip("/")) == (b.netloc, b.path.rstrip("/"))
    except Exception:
        return False


def baseline_url(path):
    with open(path, encoding="utf-8") as f:
        first = f.readline().strip()
    return first[1:].strip() if first.startswith("#") else None


# --- main -----------------------------------------------------------------
def run_payload(label, data, baseline=None):
    """페이지 payload 하나 (단일 파일 또는 bundle 의 한 페이지)."""
    meta = data.get("meta", {})
    timeline = data.get("timeline", [])
    ticks = ticks_of(timeline)

    rep = Report(label)
    if not check_schema(rep, meta):
        rep.show()
        return rep
    check_pid_integrity(rep, meta, timeline)
    check_tick_interval(rep, meta, ticks)
    check_focus_ms(rep, meta, ticks)
    # visTop/visBot 은 틱 당시의 order 다. splice 뒤 order 가 바뀌므로 order 로 비교하는 [4] · [8] · [14] 는
    #   마지막 splice 뒤 틱만 본다 (feature 는 pid 기반 vis 를 써서 영향 없음, 감사 §8-13).
    sp_t = [e.get("t", 0) for e in timeline if e.get("type") == "rescan" and e.get("mode") == "splice"]
    oticks = [e for e in ticks if e.get("t", 0) > max(sp_t)] if sp_t else ticks
    if sp_t:
        rep.add(OK, "order 기반 검사 범위", f"splice 뒤 틱 {len(oticks)}/{len(ticks)}개만 ([4] · [8] · [14])")
    check_visible_range(rep, meta, oticks)
    check_viewport_covers_dwell(rep, meta, oticks)
    check_counters(rep, ticks)
    check_rescan(rep, timeline, meta)
    check_rescan_cost(rep, timeline)
    check_order_continuity(rep, meta)
    check_segments(rep, meta, timeline)
    check_scroll_capture(rep, meta, timeline, ticks)
    check_extraction(rep, meta, ticks)
    check_pieces(rep, meta, ticks)
    check_vis_cross(rep, meta, oticks)
    check_scroll_cross(rep, meta, timeline, ticks)
    check_v3_fields(rep, meta, timeline, ticks)
    check_label(rep, meta, timeline, ticks)
    if baseline:
        check_units_baseline(rep, meta, baseline)

    rep.show()
    print(f"  -- 유닛 {len(meta.get('paragraphs', []))}개 · 틱 {len(ticks)}개 · "
          f"이벤트 {len(timeline)}개 · schema v{meta.get('schemaVersion', '?')}")
    print(f"  -- {pieces_summary(meta)}")
    print(f"  -- {vis_summary(ticks)}")
    print(f"  -- {input_summary(timeline, ticks)}")
    return rep


def run(path, baseline=None):
    """파일 하나 → Report 목록. bundle 이면 세션 1개 + 페이지 N개."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    if data.get("kind") != "rbc-session":
        return [run_payload(path, data, baseline)]

    session = data.get("session", {})
    reps = []

    srep = Report(f"{path} [세션 {str(session.get('sessionId'))[:8]}]")
    check_bundle_session(srep, session)
    srep.show()
    print(f"  -- 페이지 {len(data.get('pages', []))}개 · 방문 {len(session.get('visits', []))}건 · "
          f"focusMs {session.get('focusMs')}")
    reps.append(srep)

    base_url = baseline_url(baseline) if baseline else None
    used = False
    for i, page in enumerate(data.get("pages", [])):
        meta = page.get("meta", {})
        url = meta.get("url") or meta.get("pageId") or ""
        use = baseline and (base_url is None or same_article(base_url, url))
        used = used or bool(use)
        reps.append(run_payload(f"{path} [p{i}] {url[:70]}", page, baseline if use else None))

    if baseline and not used:
        srep.add(WARN, "유닛 기준선", f"기준선 글({base_url})이 이 세션에 없음 — 검사 안 함")
        srep.show()

    # [S6] 라벨로 끝난 세션이면 완료된 라벨이 있어야 한다
    if session.get("stopReason") == "labeled":
        has = any(final_label(pg.get("timeline", [])) for pg in data.get("pages", []))
        lv = OK if has else FAIL
        srep2 = Report(f"{path} [세션 라벨]")
        srep2.add(lv, "라벨로 정지", "완료된 label 있음" if has else "stopReason=labeled 인데 완료된 label 없음")
        srep2.show()
        reps.append(srep2)
    return reps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--units-baseline", help="기준선 유닛 목록 파일")
    ap.add_argument("--dump-units", action="store_true",
                    help="유닛 목록을 stdout으로 출력 (기준선 파일 생성용)")
    ap.add_argument("--page", type=int, default=0,
                    help="bundle 에서 --dump-units 할 페이지 번호 (기본 0)")
    args = ap.parse_args()

    if args.dump_units:
        with open(args.inputs[0], encoding="utf-8") as f:
            data = json.load(f)
        if data.get("kind") == "rbc-session":            # bundle: --page 번째 페이지
            data = data.get("pages", [])[args.page]
        meta = data.get("meta", {})
        print(f"# {meta.get('url')}")
        for p in meta.get("paragraphs", []):
            print(f"{p.get('order')}\t{p['pid']}\t{p.get('charLen')}")
        return

    reports = [r for p in args.inputs for r in run(p, args.units_baseline)]
    bad = [r for r in reports if r.failed]
    print()
    if bad:
        print(f"FAIL — 보고서 {len(bad)}/{len(reports)}개에서 불변식 위반")
        sys.exit(1)
    print(f"통과 — 보고서 {len(reports)}개 전부 OK")


if __name__ == "__main__":
    main()