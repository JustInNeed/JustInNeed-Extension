#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_features.py  (v2)
=========================
content.js가 뱉은 raw JSON 세션 파일(들) -> 유닛별 feature 테이블(CSV).

핵심 원칙(설계 4번):
  - 수집(content.js)은 raw만. feature 계산은 전부 여기서.
  - 그래서 feature 정의/임계값을 바꾸면 *재수집 없이* 이 스크립트만 다시 돌리면 됨.

v1 -> v2 변경점:
  [P1] has_highlight / has_copy 는 모델 feature로 유지한다. (2026-09-12 결정)
       한때 라벨 누수를 우려해 제외했었다. 근거는 "PDF 5단계 평가가 사용자
       하이라이트를 정답으로 쓰는데 같은 신호를 입력에도 넣으면 성능이 뻥튀기된다"
       였다.
       그 전제가 바뀌었다: 평가용 정답은 하이라이트/복사가 아니라 **별도의
       '관심 문단 선택' UI**로 따로 받기로 했다. 즉 라벨과 이 두 신호는 서로 다른
       행위이므로 누수가 아니고, 둘 다 중요한 행동 feature다.
       - 라벨링 UI가 붙으면 timeline에 별도 이벤트 타입(예: type='label')으로
         들어오고, 그때 라벨 컬럼을 하나 추가한다. 지금은 없다.
       - 그래도 실험 삼아 빼보고 싶으면 --no-selection-features.

  [P2] 델타(diff) 기반 feature의 구간 오염 수정
       v1은 df 전체에 dx = cx.diff() 를 계산한 뒤 유닛별로 subset했다.
       커서가 유닛을 떠났다 돌아오면 그 diff가 "떠나 있던 구간 전체의 이동량"을
       담아서, 유닛 진입 첫 행마다 가짜 큰 dx/속도가 들어갔다.
       -> 유닛별 '연속 구간(run)' 단위로 diff를 다시 계산하고,
          각 run의 첫 행(직전 틱이 다른 유닛인 행)은 델타 계산에서 제외한다.
       같은 뿌리의 버그라 아래 항목이 전부 영향을 받았고, 함께 고쳤다:
          xdist, horizontal_ratio, horizontal_ratio_trend,
          cursor_speed_z / _std / _trend, cursorfreq, pause_count
       추가로 content.js v2는 탭 이탈(document.hidden) 중 틱을 기록하지 않으므로
       타임라인에 시간 구멍이 생긴다. 그 구멍을 사이에 둔 두 틱의 델타도 무효라
       run 분리 기준에 '시간 간격'을 함께 넣었다.

v1 설계 결정(그대로 유지):
  - ML 단위 = "유닛 1개당 1행". 재방문 신호는 visit_count feature로 흡수.
  - z-score = "이 입력 파일들 전체"를 그 사용자의 baseline으로 봄.
    세션이 3개 미만이면 z_is_weak=True 플래그.
  - trend/std는 샘플 N개 미만이면 0 + *_low_sample 플래그(설계 5번).
  - idle은 모델한테 안 맡기고 룰로 컷(설계 2번). rule_label 컬럼으로 표시.

사용법:
  python extract_features.py session1.json [session2.json ...] -o features.csv
  python extract_features.py *.json -o features.csv --no-selection-features
"""

import argparse
import json
import sys
import numpy as np
import pandas as pd

# =============================================================================
# CONFIG  — 전부 여기서 튜닝. 코드 안 건드림.
# =============================================================================
CFG = {
    # --- 스크롤 "정지" 판정 (viewport_fixed_duration용) ---
    "SCROLL_STILL_PXPS": 5,       # |scrollSpeed| 이 이하면 "스크롤 안 함"으로 봄 (px/s)

    # --- pause(커서 정지) 판정 (pause_count용) ---
    "PAUSE_MIN_TICKS": 2,         # 커서가 이만큼 연속 정지하면 pause 1회 (2틱≈300ms)

    # --- trend/std 최소 샘플 가드 (설계 5번) ---
    "MIN_SAMPLES_TREND": 4,       # 이보다 샘플 적으면 trend=0, std=0 + 플래그

    # --- visit(재방문) 카운트 ---
    "VISIT_GAP_TOL_TICKS": 3,     # 중앙선이 잠깐(이 틱 수 이하) 벗어났다 돌아오면 같은 방문

    # --- [P2] 연속 구간(run) 판정 ---
    # 직전 행과의 시간 간격이 tick_sec * 이 배수를 넘으면 델타 무효(다른 run).
    # 탭 이탈로 틱이 비어 있는 구간, 유닛을 떠났다 돌아온 구간을 모두 잡는다.
    "RUN_GAP_TOL": 1.8,

    # --- 개인화 정규화: WPS(독해 속도) ---
    # dwell_normalized = actual_dwell / (charLen / CHARS_PER_SEC)
    # ⚠ v1 placeholder. 진짜로는 사용자별 WPS를 추정해야 함. 일단 상수로 둠.
    "CHARS_PER_SEC": 8.0,         # 한국어 대략치(튜닝 대상). 글자/초.

    # --- z-score baseline 경고선 ---
    "MIN_SESSIONS_FOR_Z": 3,      # 세션 < 이 수 이면 z_is_weak=True

    # --- idle 룰 컷 (설계 2번): 명백한 AFK만. 미묘한 멍때림은 안 건드림 ---
    "IDLE_MIN_DWELL_SEC": 120,    # 한 유닛에 이 이상 머물렀는데
    "IDLE_MAX_CURSOR_MOVE_FRAC": 0.02,  # 커서 움직인 틱 비율이 이 이하 +
    "IDLE_MAX_SCRL_EVENTS": 1,    # 스크롤 이벤트가 사실상 0 이면 -> idle(AFK)

    # --- "스쳐간" 유닛: 진짜 방문으로 안 침 ---
    "MIN_DWELL_SEC_KEEP": 0.45,   # dwell이 이 미만이면 행에서 제외(그냥 지나감)
}

EPS = 1e-9

# =============================================================================
# 모델 feature 목록
# =============================================================================
# 선택(하이라이트)·복사 신호. 평가용 정답은 별도 '관심 문단 선택' UI로 받으므로
# 이 둘은 라벨이 아니라 행동 feature다. 기본 포함.
SELECTION_FEATURES = ["has_highlight", "has_copy"]

# 확정 명세(수집 feature 명세 표) 17개와 정확히 일치시킨다.
# scroll_depth_pct 는 고정값이라 표에서도 모델 입력 제외 → 여기서도 메타.
MODEL_FEATURES = SELECTION_FEATURES + [
    "viewport_fixed_duration", "pause_count",
    "horizontal_ratio", "horizontal_ratio_trend", "xdist",
    "cursor_speed_z", "cursor_speed_std", "cursor_speed_trend",
    "cursorfreq", "cursor_conc",
    "scroll_speed_z", "scroll_speed_std", "scrlfreq", "scrlfreq_trend",
    "entry_scrlspeed",
]

# CSV에는 남지만 모델 입력이 아닌 컬럼(메타).
#   dwell_normalized / visit_count 는 명세 17개에 없다.
#   (0-3: "재방문 횟수 = 별도 신호"). 참고용으로 계산만 해서 남긴다.
META_COLUMNS = [
    "session_id", "url", "paragraph_id", "unit_order", "char_len", "text",
    "highlight_text", "copy_text", "scroll_depth_pct", "dwell_sec",
    "dwell_viewport_sec", "dwell_normalized", "visit_count",
    "n_center_ticks", "n_cursor_ticks", "rule_label", "z_is_weak",
    "trend_low_sample",
    "session_has_disruptive_rescan", "session_hidden_gaps",
]


# =============================================================================
# 작은 헬퍼들
# =============================================================================
def _slope_sign(values):
    """시계열 기울기 부호. 샘플 부족하면 (0, low_sample=True)."""
    n = len(values)
    if n < CFG["MIN_SAMPLES_TREND"]:
        return 0, True
    x = np.arange(n, dtype=float)
    y = np.asarray(values, dtype=float)
    slope = np.polyfit(x, y, 1)[0]
    if not np.isfinite(slope) or abs(slope) < EPS:
        return 0, False
    return int(np.sign(slope)), False


def _std_guarded(values):
    """샘플 부족하면 (0.0, low_sample=True)."""
    n = len(values)
    if n < CFG["MIN_SAMPLES_TREND"]:
        return 0.0, True
    return (float(np.std(values, ddof=1)) if n > 1 else 0.0), False


def _count_runs(mask, gap_tol=0):
    """bool 리스트에서 True 연속 구간(run) 개수. gap_tol 만큼의 False는 메움."""
    runs, in_run, gap = 0, False, 0
    for m in mask:
        if m:
            if not in_run:
                runs += 1
                in_run = True
            gap = 0
        else:
            if in_run:
                gap += 1
                if gap > gap_tol:
                    in_run = False
    return runs


def _count_pauses(moved_flags):
    """커서가 '움직이다가 멈춘' 구간 수 (직전 활동 있을 때만 = 죽은 커서 제외)."""
    pauses, still, seen_move = 0, 0, False
    for moved in moved_flags:
        if moved:
            still = 0
            seen_move = True
        else:
            if seen_move:           # 직전에 움직임이 있었던 경우만
                still += 1
                if still == CFG["PAUSE_MIN_TICKS"]:
                    pauses += 1     # 정지 구간 진입 시 1회 카운트
    return pauses


# --- [P2] 연속 구간(run) 처리 -------------------------------------------------
def _run_ids(sub, tick_sec):
    """
    유닛별 subset 안에서 '연속으로 관측된 구간'에 id를 매긴다.
    끊기는 조건 두 가지:
      (a) 원본 틱 인덱스가 연속이 아님  -> 그 사이에 다른 유닛에 있었음
      (b) 시간 간격이 tick_sec * RUN_GAP_TOL 초과 -> 탭 이탈 등으로 틱이 비었음
    """
    if sub.empty:
        return pd.Series([], dtype="int64", index=sub.index)
    idx_break = sub["i"].diff() != 1
    t_break = sub["t"].diff() > tick_sec * 1000.0 * CFG["RUN_GAP_TOL"]
    brk = idx_break | t_break
    brk.iloc[0] = True
    return brk.cumsum()


def _prep_runs(sub, tick_sec):
    """
    subset에 run id / run 내부 diff / 델타 유효 마스크를 붙여서 돌려준다.
    _valid=False 인 행은 '직전 틱이 이 유닛이 아니었던 진입 행'이라
    cursorDist, cursorMoved, dx, dy 같은 델타 파생값을 쓰면 안 된다.
    """
    if sub.empty:
        return sub
    s = sub.sort_values("t").copy()
    s["_run"] = _run_ids(s, tick_sec)
    s["_valid"] = s.groupby("_run").cumcount() > 0     # run의 첫 행 제외
    s["_dx"] = s.groupby("_run")["cx"].diff().abs()
    s["_dy"] = s.groupby("_run")["cy"].diff().abs()
    return s


# =============================================================================
# 1) 로드 + 정규화된 long-form tick 프레임 만들기
# =============================================================================
def load_sessions(paths):
    sessions = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        meta = data.get("meta", {})
        tick_sec = meta.get("tickMs", 150) / 1000.0
        paras = meta.get("paragraphs", [])
        charlen = {pp["pid"]: pp.get("charLen", 0) for pp in paras}
        textmap = {pp["pid"]: pp.get("text", "") for pp in paras}
        ordermap = {pp["pid"]: pp.get("order", -1) for pp in paras}
        timeline = data.get("timeline", [])

        # 세션 품질 플래그 (content.js v2가 남기는 이벤트)
        disruptive = any(e.get("type") == "rescan"
                         and e.get("mode") == "disruptive-skipped" for e in timeline)
        hidden_gaps = sum(1 for e in timeline
                          if e.get("type") == "visibility" and e.get("hidden"))

        sessions.append({
            "path": p, "meta": meta, "tick_sec": tick_sec,
            "charlen": charlen, "textmap": textmap, "ordermap": ordermap,
            "timeline": timeline,
            "session_id": f"{meta.get('url','?')}@{meta.get('startedAt','?')}",
            "disruptive": disruptive, "hidden_gaps": hidden_gaps,
        })
    return sessions


def ticks_df(session):
    rows = [e for e in session["timeline"] if e.get("type") == "tick"]
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df = df.sort_values("t").reset_index(drop=True)

    # [P2] 원본 틱 순서. 유닛별 subset에서 연속성을 판정하는 기준이 된다.
    df["i"] = np.arange(len(df), dtype="int64")

    # [P2] 전역 dx/dy는 만들지 않는다. (v1의 오염 원인)
    #      dx/dy는 _prep_runs()가 유닛별 run 안에서만 계산한다.

    # cursorDist는 content.js가 '직전 틱 대비'로 준 값이라, 시간 구멍(탭 이탈)을
    # 사이에 둔 행은 무효다. 전역 연속성 마스크를 미리 붙여둔다(baseline용).
    gap = df["t"].diff()
    df["_global_valid"] = gap.le(session["tick_sec"] * 1000.0 * CFG["RUN_GAP_TOL"])
    df.loc[df.index[0], "_global_valid"] = False

    df["cursor_speed_pxps"] = df["cursorDist"] / session["tick_sec"]
    df["abs_scroll_speed"] = df["scrollSpeed"].abs()
    if "docH" in df.columns:
        denom = (df["docH"] - df["vh"]).replace(0, np.nan)
        df["scroll_depth_pct"] = (df["scrollY"] / denom).clip(0, 1)
    else:
        df["scroll_depth_pct"] = np.nan
    return df


# =============================================================================
# 2) 사용자 baseline (z-score 용) — 입력 파일 전체 풀링
# =============================================================================
def build_baseline(all_ticks):
    """커서/스크롤 속도의 사용자 기준 평균·표준편차."""
    # [P2] 시간 구멍을 사이에 둔 행의 cursorDist는 무효 -> baseline에서 제외
    ok = all_ticks[all_ticks["_global_valid"] & (all_ticks["cursorMoved"] == True)]  # noqa: E712
    cur = ok["cursor_speed_pxps"]
    scr = all_ticks[all_ticks["abs_scroll_speed"] > CFG["SCROLL_STILL_PXPS"]]["abs_scroll_speed"]
    return {
        "cursor_mean": float(cur.mean()) if len(cur) else 0.0,
        "cursor_std": float(cur.std(ddof=1)) if len(cur) > 1 else 1.0,
        "scroll_mean": float(scr.mean()) if len(scr) else 0.0,
        "scroll_std": float(scr.std(ddof=1)) if len(scr) > 1 else 1.0,
    }


def _z(value, mean, std):
    return float((value - mean) / (std + EPS))


# =============================================================================
# 3) 유닛별 feature 한 행씩
# =============================================================================
def aggregate(session, df, baseline, n_sessions):
    tick_sec = session["tick_sec"]
    timeline = session["timeline"]

    # 이벤트(하이라이트/복사) -> 유닛별 텍스트 모으기.
    # content.js v2.2 부터 pids(선택이 걸친 유닛 전부)를 준다.
    # 명세: "여러 문단 걸치면 모두 1". 구버전 로그는 pid 하나로 폴백.
    def _pids(e):
        p = e.get("pids")
        if isinstance(p, list) and p:
            return [x for x in p if x]
        return [e["pid"]] if e.get("pid") else []

    hl, cp = {}, {}
    for e in timeline:
        if e.get("type") == "highlight":
            for p in _pids(e):
                hl.setdefault(p, []).append(e.get("text", ""))
        elif e.get("type") == "copy":
            for p in _pids(e):
                cp.setdefault(p, []).append(e.get("text", ""))

    # [C1] 뷰포트 노출 누적 시간 — visTop/visBot 사이 유닛은 그 틱에 화면에 있었다.
    #      명세 0-3의 "체류시간: 블록이 뷰포트에 들어와 있던 누적 시간".
    vis_ticks = {}
    for e in timeline:
        if e.get("type") != "tick":
            continue
        a, b = e.get("visTop"), e.get("visBot")
        if a is None or b is None:
            continue
        lo, hi = (a, b) if a <= b else (b, a)
        for o in range(lo, hi + 1):
            vis_ticks[o] = vis_ticks.get(o, 0) + 1

    # 중앙선(B) 시퀀스 -> visit_count 용.
    # [P2] 탭 이탈로 틱이 비어 있던 구간에는 강제 브레이크를 넣어
    #      "나갔다 돌아온 것"이 한 번의 방문으로 뭉치지 않게 한다.
    ticks_sorted = sorted([e for e in timeline if e.get("type") == "tick"],
                          key=lambda e: e["t"])
    center_seq = []
    prev_t = None
    for e in ticks_sorted:
        if prev_t is not None and (e["t"] - prev_t) > tick_sec * 1000.0 * CFG["RUN_GAP_TOL"]:
            center_seq.extend([None] * (CFG["VISIT_GAP_TOL_TICKS"] + 1))
        center_seq.append(e.get("centerPid"))
        prev_t = e["t"]

    rows = []
    pids = [p for p in pd.unique(df["centerPid"].dropna())]
    for pid in pids:
        B = df[df["centerPid"] == pid].sort_values("t")
        n_b = len(B)
        dwell_sec = n_b * tick_sec
        if dwell_sec < CFG["MIN_DWELL_SEC_KEEP"]:
            continue                              # 스쳐간 유닛은 행 안 만듦

        # [P2] A채널은 run 단위로 델타를 다시 계산한 프레임을 쓴다.
        A = _prep_runs(df[df["cursorPid"] == pid], tick_sec)
        n_a = len(A)
        Av = A[A["_valid"]] if n_a else A          # 델타가 유효한 행만

        charlen = session["charlen"].get(pid, 0)

        # ---- 체류/스크롤 (B채널) ----
        vfd = int((B["abs_scroll_speed"] <= CFG["SCROLL_STILL_PXPS"]).sum()) * tick_sec
        expected = (charlen / CFG["CHARS_PER_SEC"]) if charlen else np.nan
        dwell_norm = dwell_sec / expected if expected and expected > 0 else np.nan

        scroll_vals = B["abs_scroll_speed"].tolist()
        scroll_mean = float(np.mean(scroll_vals)) if scroll_vals else 0.0
        scroll_std, sstd_low = _std_guarded(scroll_vals)
        scroll_z = _z(scroll_mean, baseline["scroll_mean"], baseline["scroll_std"])
        scrlfreq = (B["scrollEvents"].sum() / dwell_sec) if dwell_sec else 0.0
        scrl_trend, scrl_low = _slope_sign(B["scrollEvents"].tolist())

        # entry_scrlspeed: 이 유닛에 처음 중앙선이 진입한 시점의 스크롤 속도 (원본)
        entry_speed = float(B["abs_scroll_speed"].iloc[0]) if n_b else 0.0

        # ---- 커서 (A채널) — [P2] 전부 run 내부 값만 사용 ----
        cur_vals = Av["cursor_speed_pxps"].tolist()
        cur_mean = float(np.mean(cur_vals)) if cur_vals else 0.0
        cur_std, cstd_low = _std_guarded(cur_vals)
        cur_z = _z(cur_mean, baseline["cursor_mean"], baseline["cursor_std"])
        cur_trend, ctr_low = _slope_sign(cur_vals)

        n_valid = len(Av)
        moved_sum = int(Av["cursorMoved"].sum()) if n_valid else 0
        moved_frac = (moved_sum / n_valid) if n_valid else 0.0
        # cursorfreq = 커서이벤트수 ÷ 활성시간 (명세).
        # content.js v2.2 부터 틱당 실제 mousemove 이벤트 수를 준다.
        # 구버전 로그에는 없으므로 "움직임이 감지된 틱 수"로 폴백.
        if n_a and "mouseEvents" in A.columns and A["mouseEvents"].notna().any():
            cursorfreq = float(A["mouseEvents"].sum()) / (n_a * tick_sec)
        else:
            cursorfreq = (moved_sum / (n_valid * tick_sec)) if n_valid else 0.0
        cursor_conc = float(A["cy"].std(ddof=1)) if n_a > 1 else 0.0

        # pause도 run 단위로 세고 합산 (구간을 가로질러 이어붙이면 가짜 pause 발생)
        pause_count = 0
        if n_a:
            for _, g in A.groupby("_run"):
                pause_count += _count_pauses(g["cursorMoved"].tolist())
        # 명세는 pause_count(Sum) 원본. 길이 정규화는 BE 담당이라 여기선 안 한다.
        # (유닛이 ~200자로 균일해져서 길이 보정 필요성 자체가 줄었다)

        # xdist / horizontal_ratio — run 내부 diff만 (진입 행은 NaN이라 자동 제외)
        xpix = float(Av["_dx"].sum()) if n_valid else 0.0
        ypix = float(Av["_dy"].sum()) if n_valid else 0.0
        vw = float(A["vw"].median()) if n_a else float(df["vw"].median())
        xdist = xpix / (vw + EPS)
        hr = xpix / (xpix + ypix + EPS)
        hr_series = (Av["_dx"] / (Av["_dx"] + Av["_dy"] + EPS)).dropna().tolist() \
            if n_valid else []
        hr_trend, hr_low = _slope_sign(hr_series)

        # ---- 선택/복사 이벤트 (모델 feature) ----
        has_hl = 1 if pid in hl else 0
        has_cp = 1 if pid in cp else 0

        # ---- visit_count (재방문) ----
        visit_count = _count_runs([c == pid for c in center_seq],
                                  gap_tol=CFG["VISIT_GAP_TOL_TICKS"])

        # ---- idle 룰 컷 (설계 2번): 명백한 AFK만 ----
        rule_label = None
        if (dwell_sec >= CFG["IDLE_MIN_DWELL_SEC"]
                and moved_frac <= CFG["IDLE_MAX_CURSOR_MOVE_FRAC"]
                and B["scrollEvents"].sum() <= CFG["IDLE_MAX_SCRL_EVENTS"]):
            rule_label = "idle"

        rows.append({
            # --- 메타데이터(모델 입력 아님) ---
            "session_id": session["session_id"],
            "url": session["meta"].get("url"),
            "paragraph_id": pid,
            "unit_order": session["ordermap"].get(pid, -1),
            "char_len": charlen,
            "text": session["textmap"].get(pid, "")[:120],
            "highlight_text": " || ".join(hl.get(pid, []))[:500],
            "copy_text": " || ".join(cp.get(pid, []))[:500],
            "scroll_depth_pct": float(B["scroll_depth_pct"].median())
                                if B["scroll_depth_pct"].notna().any() else np.nan,
            "dwell_sec": round(dwell_sec, 2),
            "dwell_viewport_sec": round(
                vis_ticks.get(session["ordermap"].get(pid, -1), 0) * tick_sec, 2),
            "dwell_normalized": round(dwell_norm, 3) if dwell_norm == dwell_norm else np.nan,
            "visit_count": visit_count,
            "n_center_ticks": n_b,
            "n_cursor_ticks": n_a,
            "rule_label": rule_label,
            "z_is_weak": n_sessions < CFG["MIN_SESSIONS_FOR_Z"],
            "trend_low_sample": any([scrl_low, ctr_low, hr_low]),
            "session_has_disruptive_rescan": session["disruptive"],
            "session_hidden_gaps": session["hidden_gaps"],

            # --- 모델 feature ---
            "has_highlight": has_hl,
            "has_copy": has_cp,
            "viewport_fixed_duration": round(vfd, 2),
            "pause_count": pause_count,
            "horizontal_ratio": round(hr, 3),
            "horizontal_ratio_trend": hr_trend,
            "xdist": round(xdist, 3),
            "cursor_speed_z": round(cur_z, 3),
            "cursor_speed_std": round(cur_std, 3),
            "cursor_speed_trend": cur_trend,
            "cursorfreq": round(cursorfreq, 3),
            "cursor_conc": round(cursor_conc, 2),
            "scroll_speed_z": round(scroll_z, 3),
            "scroll_speed_std": round(scroll_std, 3),
            "scrlfreq": round(scrlfreq, 3),
            "scrlfreq_trend": scrl_trend,
            "entry_scrlspeed": round(entry_speed, 2),
        })
    return rows


# =============================================================================
# main
# =============================================================================
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+", help="content.js가 내보낸 raw JSON 파일(들)")
    ap.add_argument("-o", "--output", default="features.csv")
    ap.add_argument("--no-selection-features", action="store_true",
                    help="has_highlight / has_copy 를 모델 feature에서 제외. "
                         "기본은 포함(평가 정답은 별도 '관심 문단 선택' UI로 받음).")
    args = ap.parse_args()

    feature_list = [f for f in MODEL_FEATURES
                    if not (args.no_selection_features and f in SELECTION_FEATURES)]

    sessions = load_sessions(args.inputs)
    n_sessions = len(sessions)

    dfs = {s["path"]: ticks_df(s) for s in sessions}
    nonempty = [d for d in dfs.values() if not d.empty]
    if not nonempty:
        print("틱 데이터가 없음. 기록을 시작(● 기록)한 뒤 스크롤하며 읽고 내보냈는지 확인.",
              file=sys.stderr)
        sys.exit(1)
    all_ticks = pd.concat(nonempty, ignore_index=True)
    baseline = build_baseline(all_ticks)

    all_rows = []
    for s in sessions:
        df = dfs[s["path"]]
        if df.empty:
            continue
        all_rows += aggregate(s, df, baseline, n_sessions)

    out = pd.DataFrame(all_rows)
    if out.empty:
        print("유닛 행이 0개. (사이트 매핑 실패거나 dwell 임계값 미달)", file=sys.stderr)
        sys.exit(1)

    out.to_csv(args.output, index=False)

    # ---- 요약 ----
    print(f"세션 {n_sessions}개 → 유닛 행 {len(out)}개  (→ {args.output})")
    idle_n = int((out["rule_label"] == "idle").sum())
    print(f"  · 룰 컷 idle: {idle_n}행  · z_is_weak: {bool(out['z_is_weak'].iloc[0])} "
          f"(세션 {n_sessions} < {CFG['MIN_SESSIONS_FOR_Z']})")
    print(f"  · 모델 feature {len(feature_list)}개: {', '.join(feature_list)}")

    n_hl = int(out["has_highlight"].sum())
    n_cp = int(out["has_copy"].sum())
    if args.no_selection_features:
        print(f"  · has_highlight·has_copy 는 모델 feature에서 제외됨 "
              f"(컬럼은 CSV에 남음: {n_hl}행 / {n_cp}행).")
    else:
        print(f"  · 선택 feature 포함 — has_highlight {n_hl}행, has_copy {n_cp}행.")
        print("    (평가 정답은 별도 '관심 문단 선택' UI로 받으므로 라벨 누수 아님. "
              "그 UI가 붙으면 라벨 컬럼을 따로 추가할 것.)")

    bad = out[out["session_has_disruptive_rescan"]]
    if len(bad):
        n_bad_sess = bad["session_id"].nunique()
        print(f"  ⚠ 본문이 교체된 세션 {n_bad_sess}개 ({len(bad)}행). "
              f"pid 정합성이 깨졌을 수 있으니 학습 전에 확인/제외 권장.")
    gaps = int(out.groupby('session_id')['session_hidden_gaps'].first().sum())
    if gaps:
        print(f"  · 탭 이탈 구간 {gaps}회 (해당 시간은 dwell에서 제외됨).")

    with pd.option_context("display.max_columns", None, "display.width", 170):
        cols = ["paragraph_id", "unit_order", "dwell_sec", "dwell_viewport_sec",
                "visit_count", "viewport_fixed_duration", "pause_count",
                "cursorfreq", "horizontal_ratio", "has_highlight", "rule_label"]
        print(out[cols].head(12).to_string(index=False))


if __name__ == "__main__":
    main()