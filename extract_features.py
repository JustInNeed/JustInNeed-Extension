#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_features.py  (v3)
=========================
세션 bundle(rbc-session, schemaVersion 3) → 유닛별 feature 테이블(CSV).
계산 정의의 기준 문서 = 피처_계산_논리.md. 이 파일과 문서가 어긋나면 문서를 먼저 고칠 것.

원칙: 수집은 원자료만, 판정·가공은 여기서. 정의/문턱을 바꾸면 재수집 없이 다시 돌린다.

v2 → v3
  - 입력 = background 가 내보낸 세션 bundle. 페이지 schemaVersion < 3 은 거부 (v2 하위호환 없음).
  - 행 = 페이지의 **모든 유닛** (안 본 유닛 포함 — 순위 평가 · "안읽음" 상태에 필요).
  - A채널(커서 계열) 귀속 = 글자 바로 위(cursorPid) → 커서가 든 조각 상자 (tick.vis 로 계산, 2026-10-05).
  - B채널(스크롤 계열 · 체류) = 중앙선 한 줄 → GVAM 가중치 (tick.vis 조각 세로 구간,
    가우시안 μ 0.492 σ 0.201, 분모 = 화면 전체 가중치 상수, 같은 높이 여러 유닛은 나눠 가짐).
  - 차분값(scrollSpeed · cursorDist · cursorMoved)은 로그에 없다 → 리셋 규칙으로 여기서 계산.
    커서 이동량은 tick.mdx / mdy (150ms 표본 사이 이동 보존).
  - 하이라이트 · 복사 = ranges 의 pid.
  - 재방문 = 방문 뒤 화면 위로 빠진 적이 있는 유닛이 다시 읽기 구간(μ±σ)에 1초 머문 횟수 (revisit_count, 모델 입력).
  - idle(120초 이상 입력 없음) · 편집(edits>0) 틱은 모든 feature 계산에서 제외.
  - 라벨 v2(라벨_명세_v2.md §7): label_state = 자기보고 읽기 상태(skip/skim/read/focus/unsure),
    label_n = 0~3(unsure · 없음은 빈 값), label_mark = 중요 표시 1/0, 페이지 단위 설문 · 소요 시간.
    scenario 열 = 읽는 목적. 전부 모델 입력 아님 (정답 · 조건). v1 라벨 파일은 라벨 없음으로 처리.

사용법:
  python3 extract_features.py stepC_base.json [더 많은 bundle ...] -o features.csv
  python3 extract_features.py *.json -o features.csv --noise noise.json
      noise.json = {"<pageId 또는 url>": ["<pid>", ...], ...}  (본문 아닌 유닛)
"""

import argparse
import json
import math
import sys
from urllib.parse import urlparse, parse_qs

import numpy as np
import pandas as pd

# =============================================================================
# CONFIG — 문서 "파라미터" 표와 같은 값. 튜닝은 여기서만.
# =============================================================================
RATE_N = {"skip": 0, "skim": 1, "read": 2, "focus": 3}        # 라벨 v2 → 숫자 (unsure 는 빈 값)
RATE_N_ALL = ("skip", "skim", "read", "focus", "unsure")

CFG = {
    # GVAM (Grusky 외 CHI 2017, 뷰포트 높이 비율)
    "GVAM_MU": 0.492,
    "GVAM_SIGMA": 0.201,

    # 리셋 규칙: segId 변경 · scroller 이벤트 · 두 틱 간격 > 이 배수 × tickMs
    "RESET_GAP_MULT": 2.0,

    # 스크롤 "정지" (viewport_fixed_duration)
    "SCROLL_STILL_PXPS": 5,

    # 커서 정지 (pause_count): 움직이다가 이 틱 수 연속 정지 → 1회
    "PAUSE_MIN_TICKS": 2,

    # trend / std 최소 표본
    "MIN_SAMPLES_TREND": 4,

    # 재방문: 읽기 구간 = μ ± ZONE_K·σ
    "ZONE_K": 1.0,
    "VISIT_MIN_SEC": 1.0,          # 이만큼 읽기 구간에 머물러야 방문 1회 (2틱은 빠른 스크롤 통과도 잡음)
    "VISIT_GAP_TOL_TICKS": 3,      # 이하로 잠깐 벗어난 건 같은 방문 (떨림)

    # idle: 입력(mouse · scroll · scrollOther · edits) 없는 연속 구간이 이 이상이면 구간 전체 제외
    "IDLE_MIN_SEC": 120,

    # z-score 기준선 경고 (참가자당 세션 수)
    "MIN_SESSIONS_FOR_Z": 3,

    # 메타용 길이 정규화 (임시 상수)
    "CHARS_PER_SEC": 8.0,
}

EPS = 1e-9

SELECTION_FEATURES = ["has_highlight", "has_copy"]
MODEL_FEATURES = SELECTION_FEATURES + [
    "viewport_fixed_duration", "pause_count",
    "horizontal_ratio", "horizontal_ratio_trend", "xdist",
    "cursor_speed_z", "cursor_speed_std", "cursor_speed_trend",
    "cursorfreq", "cursor_conc",
    "scroll_speed_z", "scroll_speed_std", "scrlfreq", "scrlfreq_trend",
    "entry_scrlspeed",
    "revisit_count",
]

# 검색 결과 페이지: (호스트에 포함된 문자열, 검색어 파라미터)
SEARCH_HOSTS = [
    ("google.", "q"), ("search.naver.com", "query"), ("m.search.naver.com", "query"),
    ("search.daum.net", "q"), ("bing.com", "q"), ("duckduckgo.com", "q"),
]


# =============================================================================
# 작은 헬퍼
# =============================================================================
def _phi(z):
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _gmass(a, b):
    """화면 높이 비율 a..b 의 가우시안 질량."""
    mu, sg = CFG["GVAM_MU"], CFG["GVAM_SIGMA"]
    return _phi((b - mu) / sg) - _phi((a - mu) / sg)


def _slope_sign(values, weights=None):
    n = len(values)
    if n < CFG["MIN_SAMPLES_TREND"]:
        return 0, True
    x = np.arange(n, dtype=float)
    y = np.asarray(values, dtype=float)
    w = None if weights is None else np.sqrt(np.asarray(weights, dtype=float))
    if w is not None and (w <= 0).all():
        return 0, True
    slope = np.polyfit(x, y, 1, w=w)[0]
    if not np.isfinite(slope) or abs(slope) < EPS:
        return 0, False
    return int(np.sign(slope)), False


def _wmean_std(values, weights):
    """가중 평균 · 가중 std. 표본(가중치 > 0) 부족하면 std = 0, low = True."""
    v = np.asarray(values, dtype=float)
    w = np.asarray(weights, dtype=float)
    sw = w.sum()
    if len(v) == 0 or sw <= 0:
        return 0.0, 0.0, True
    m = float((w * v).sum() / sw)
    if len(v) < CFG["MIN_SAMPLES_TREND"]:
        return m, 0.0, True
    return m, float(math.sqrt((w * (v - m) ** 2).sum() / sw)), False


def _std_guarded(values):
    n = len(values)
    if n < CFG["MIN_SAMPLES_TREND"]:
        return 0.0, True
    return float(np.std(values, ddof=1)), False


def _count_pauses(moved_flags):
    """커서가 움직이다 멈춘 횟수 (직전에 움직임이 있었던 정지만)."""
    pauses, still, seen_move = 0, 0, False
    for moved in moved_flags:
        if moved:
            still, seen_move = 0, True
        elif seen_move:
            still += 1
            if still == CFG["PAUSE_MIN_TICKS"]:
                pauses += 1
    return pauses


def _z(v, mean, std):
    return float((v - mean) / (std + EPS))


def search_query_of(url):
    try:
        u = urlparse(url)
    except Exception:
        return None
    host = (u.hostname or "").lower()
    for frag, key in SEARCH_HOSTS:
        if frag in host:
            q = parse_qs(u.query).get(key)
            if q and q[0].strip():
                return q[0].strip()
    return None


# =============================================================================
# 1) 로드
# =============================================================================
def load_bundle(path):
    with open(path, encoding="utf-8") as f:
        b = json.load(f)
    if b.get("kind") != "rbc-session":
        sys.exit(f"{path}: 세션 bundle 이 아님 (kind={b.get('kind')!r}). "
                 "참여 정보 페이지 / 패널의 JSON 내보내기 파일을 넣을 것.")
    s = b.get("session", {})
    pages = b.get("pages", [])
    for p in pages:
        v = p.get("meta", {}).get("schemaVersion", 0)
        if v < 3:
            sys.exit(f"{path}: schemaVersion {v} — v3 미만은 지원 안 함.")
    tester = s.get("tester") or {}
    return {
        "path": path,
        "session": s,
        "pages": pages,
        "session_id": s.get("sessionId") or path,
        # 사람 키 = 연구자가 준 참여 번호. 옛 파일(동의 v1)은 설치 ID(testId)로 대신한다
        "tester_id": tester.get("participantNo") or tester.get("testId") or "unknown",
        "install_id": tester.get("testId") or "",
        "tick_ms": s.get("tickMs", 150),
    }


# =============================================================================
# 2) 페이지 하나: 틱 전처리
# =============================================================================
def prep_ticks(page, tick_ms):
    """틱 DataFrame + run(리셋 규칙) + 파생값 + 제외 마스크."""
    tl = page["timeline"]
    ticks = [e for e in tl if e.get("type") == "tick"]
    df = pd.DataFrame(ticks)
    if df.empty:
        return df
    df = df.sort_values("t", kind="stable").reset_index(drop=True)
    tick_sec = tick_ms / 1000.0

    # 리셋 규칙: segId 변경 · 간격 > RESET_GAP_MULT × tickMs · 그 사이 scroller 이벤트
    sc_times = sorted((e["segId"], e["t"]) for e in tl if e.get("type") == "scroller")
    brk = np.zeros(len(df), dtype=bool)
    brk[0] = True
    t = df["t"].to_numpy()
    seg = df["segId"].to_numpy()
    for i in range(1, len(df)):
        if seg[i] != seg[i - 1] or (t[i] - t[i - 1]) > CFG["RESET_GAP_MULT"] * tick_ms:
            brk[i] = True
        else:
            for sg, st in sc_times:
                if sg == seg[i] and t[i - 1] < st <= t[i]:
                    brk[i] = True
                    break
    df["run"] = np.cumsum(brk)
    df["run_first"] = brk

    # 스크롤 속도 (px/s): 같은 run 안 scrollY 차분 / 실제 간격
    dy = df.groupby("run")["scrollY"].diff()
    dt = df.groupby("run")["t"].diff() / 1000.0
    df["scroll_v"] = (dy / dt).where(~df["run_first"])
    df["abs_scroll_v"] = df["scroll_v"].abs()

    # 커서: mdx/mdy = 직전 틱 이후 이동량 (drain 덕에 항상 약 한 틱 분량)
    df["mpath"] = df["mdx"] + df["mdy"]
    df["moved"] = df["mpath"] > 0
    df["cur_speed"] = df["mpath"] / tick_sec      # L1 경로 속도 px/s

    # 제외: 편집 틱, idle 구간
    df["edit"] = df["edits"] > 0
    active = (df["mouseEvents"] + df["scrollEvents"] + df["scrollOther"] + df["edits"]) > 0
    idle = np.zeros(len(df), dtype=bool)
    need = int(math.ceil(CFG["IDLE_MIN_SEC"] / tick_sec))
    i = 0
    act = active.to_numpy()
    while i < len(df):
        if act[i]:
            i += 1
            continue
        j = i
        while j < len(df) and not act[j]:
            j += 1
        if j - i >= need:
            idle[i:j] = True
        i = j
    df["idle"] = idle
    df["use"] = ~df["idle"] & ~df["edit"]

    # A채널 귀속: 커서가 들어 있는 조각 상자(폭 0 제외)의 유닛. 여러 개면 글자 위 판정(cursorPid) 우선,
    # 없으면 가장 작은 상자. tick.cursorPid(글자 바로 위)는 이 규칙의 부분집합이다.
    def _apid(r):
        if r.cx is None or r.cy is None or (isinstance(r.cx, float) and math.isnan(r.cx)):
            return None
        hit = [(v[0], (v[3] - v[2]) * (v[5] - v[4])) for v in r.vis
               if v[5] - v[4] > 0 and v[4] <= r.cx <= v[5] and v[2] <= r.cy <= v[3]]
        if not hit:
            return None
        if isinstance(r.cursorPid, str) and any(p == r.cursorPid for p, _ in hit):
            return r.cursorPid
        return min(hit, key=lambda h: h[1])[0]
    df["apid"] = [_apid(r) for r in df.itertuples(index=False)]

    denom = (df["docH"] - df["vh"]).where(lambda x: x > 0)
    df["depth"] = (df["scrollY"] / denom).clip(0, 1)
    return df


# =============================================================================
# 3) GVAM 가중치 · 읽기 구간 위치 (틱 × 유닛)
# =============================================================================
def gvam_tick(vis, vh):
    """
    vis 한 틱 → (weights{pid: w}, spans{pid: [(top, bottom), ...] 합집합, 화면 안으로 자름}).
    - 폭 0 조각(빈 줄 세로선) 제외.
    - 같은 pid 조각은 세로 구간 합집합.
    - 화면 높이 각 지점의 가우시안 질량을 그 지점을 덮은 유닛 수로 나눠 가진다.
    - 분모 = 화면 전체 질량(상수). 글자가 없는 높이(사진 · 여백)의 질량은 어디에도 안 감.
    """
    if not vis or not vh:
        return {}, {}
    raw = {}
    for pid, _k, top, bot, left, right in vis:
        if right - left <= 0:
            continue
        a, b = max(top, 0), min(bot, vh)
        if b <= a:
            continue
        raw.setdefault(pid, []).append((a, b))
    spans = {}
    for pid, iv in raw.items():
        iv.sort()
        out = [list(iv[0])]
        for a, b in iv[1:]:
            if a <= out[-1][1]:
                out[-1][1] = max(out[-1][1], b)
            else:
                out.append([a, b])
        spans[pid] = [tuple(x) for x in out]

    cuts = sorted({y for iv in spans.values() for ab in iv for y in ab})
    total = _gmass(0.0, 1.0)
    w = {pid: 0.0 for pid in spans}
    for a, b in zip(cuts, cuts[1:]):
        cover = [pid for pid, iv in spans.items() if any(x <= a and b <= y for x, y in iv)]
        if not cover:
            continue
        m = _gmass(a / vh, b / vh) / total / len(cover)
        for pid in cover:
            w[pid] += m
    return w, spans


def zone_bounds(vh):
    k = CFG["ZONE_K"]
    return (CFG["GVAM_MU"] - k * CFG["GVAM_SIGMA"]) * vh, (CFG["GVAM_MU"] + k * CFG["GVAM_SIGMA"]) * vh


def gvam_frame(df):
    """틱마다 GVAM 가중치 · 읽기 구간 겹침 · 이탈 방향을 long-form 으로."""
    rows = []
    for i, r in enumerate(df.itertuples(index=False)):
        w, spans = gvam_tick(r.vis, r.vh)
        zt, zb = zone_bounds(r.vh)
        for pid, iv in spans.items():
            bot = iv[-1][1]
            inz = any(a < zb and b > zt for a, b in iv)
            side = None if inz else ("above" if bot <= zt else "below")
            rows.append((i, pid, w.get(pid, 0.0), inz, side))
    return pd.DataFrame(rows, columns=["i", "pid", "w", "inzone", "side"])


# =============================================================================
# 4) 재방문
# =============================================================================
def revisits(g, n_ticks, tick_sec):
    """
    유닛 하나의 (틱 index → inzone, side) 로 방문 · 재방문 횟수 · 첫 구간 진입 틱.
    방문 = 읽기 구간에 VISIT_MIN_SEC 이상 (VISIT_GAP_TOL_TICKS 이하 이탈은 같은 방문).
    재방문 = 마지막 방문(또는 처음 구간에 들어온 때) 뒤로 **화면 위쪽으로 빠진 적이 있는** 유닛이
             다시 방문 조건을 채움. 들어오는 방향은 묻지 않는다 — 위로 지나쳐 올라갔다가 다시
             내려와 읽어도 재방문. 위로 빠진 적이 없으면(앞 글로 갔다 이어 읽기) 안 셈.
    화면에 없는 틱은 위치 정보 없음으로 보고 상태를 유지한다.
    """
    by_i = {r.i: (r.inzone, r.side) for r in g.itertuples(index=False)}
    need = max(1, int(math.ceil(CFG["VISIT_MIN_SEC"] / tick_sec - 1e-9)))
    visits = revisit = 0
    first_entry = None
    seen_zone = went_above = False
    in_visit = counted = False
    vlen = gap = 0
    last_side = None
    for i in range(n_ticks):
        inz, side = by_i.get(i, (False, None))
        if inz:
            seen_zone = True
            if first_entry is None:
                first_entry = i
            if not in_visit:
                in_visit, counted, vlen = True, False, 0
            vlen += 1
            gap = 0
            if not counted and vlen >= need:
                counted = True
                if went_above:
                    revisit += 1
                went_above = False
                visits += 1
        else:
            if side is not None:
                last_side = side
            if in_visit:
                gap += 1
                if gap > CFG["VISIT_GAP_TOL_TICKS"]:
                    in_visit = False
                    if last_side == "above":
                        went_above = True
            elif seen_zone and side == "above":
                went_above = True
    return visits, revisit, first_entry


# =============================================================================
# 5) 기준선 (참가자별, z-score 용)
# =============================================================================
def build_baselines(page_frames):
    """tester_id → 스크롤 · 커서 속도 평균 · std. 유효(리셋 아님) · 사용 틱 전체."""
    acc = {}
    for tid, df in page_frames:
        if df.empty:
            continue
        ok = df[df["use"] & ~df["run_first"]]
        a = acc.setdefault(tid, {"s": [], "c": []})
        a["s"].extend(ok["abs_scroll_v"].dropna().tolist())
        a["c"].extend(ok["cur_speed"].tolist())
    out = {}
    for tid, a in acc.items():
        s, c = np.asarray(a["s"]), np.asarray(a["c"])
        out[tid] = {
            "scroll_mean": float(s.mean()) if len(s) else 0.0,
            "scroll_std": float(s.std(ddof=1)) if len(s) > 1 else 1.0,
            "cursor_mean": float(c.mean()) if len(c) else 0.0,
            "cursor_std": float(c.std(ddof=1)) if len(c) > 1 else 1.0,
        }
    return out


# =============================================================================
# 6) 페이지 → 유닛 행
# =============================================================================
def page_rows(bundle, page, df, base, n_sess_tester, query_info, noise):
    tick_ms = bundle["tick_ms"]
    tick_sec = tick_ms / 1000.0
    meta = page["meta"]
    tl = page["timeline"]
    paras = meta.get("paragraphs", [])
    page_id = meta.get("pageId")

    # 하이라이트 · 복사 (ranges)
    hl, cp = {}, {}
    for e in tl:
        if e.get("type") in ("highlight", "copy"):
            tgt = hl if e["type"] == "highlight" else cp
            for rg in e.get("ranges") or []:
                if rg and rg[0]:
                    tgt.setdefault(rg[0], []).append(e.get("text", ""))

    # 라벨 (테스트 모드): 취소 아닌 마지막 label 이벤트가 정답. 없으면 이 페이지는 라벨 없음.
    labs = [e for e in tl if e.get("type") == "label" and not e.get("cancelled")]
    lab = labs[-1] if labs else None
    if lab is not None and lab.get("v") != 2:
        print(f"  ⚠ 라벨 v{lab.get('v', 1)} — v2 전용, 이 페이지는 라벨 없음으로 처리", file=sys.stderr)
        lab = None
    rat = (lab.get("ratings") or {}) if lab else {}
    exc = set(lab.get("excluded") or []) if lab else set()
    mk = set(lab.get("marks") or []) if lab else set()
    lab_sv = (lab.get("survey") or {}) if lab else {}
    pms = (lab.get("phaseMs") or {}) if lab else {}
    rate_gap = {}                                  # pid → 최종값을 누르기까지 직전 누름과의 간격
    prev_t = None
    for row in (lab.get("ratingLog") or []) if lab else []:
        if isinstance(row, list) and len(row) == 3:
            rate_gap[row[0]] = (row[2] - prev_t) if prev_t is not None else row[2]
            prev_t = row[2]
    n_ask_no = sum(1 for e in tl if e.get("type") == "labelask" and e.get("answer") in ("no", "cancel"))

    # 품질 플래그
    disruptive = any(e.get("type") == "rescan" and e.get("mode") == "disruptive-skipped" for e in tl)
    n_splice = sum(1 for e in tl if e.get("type") == "rescan" and e.get("mode") == "splice")
    seg_ids = {g["segId"] for g in meta.get("segments", [])}
    missing = sum(len(c.get("missing", [])) for c in bundle["session"].get("chunkReport", [])
                  if c.get("segId") in seg_ids)

    G = gvam_frame(df) if not df.empty else pd.DataFrame(columns=["i", "pid", "w", "inzone", "side"])
    use = df["use"].to_numpy() if not df.empty else np.array([], dtype=bool)
    n = len(df)

    noise_set = None
    if noise is not None:
        noise_set = set(noise.get(page_id, []) or noise.get(meta.get("url"), []) or [])

    rows = []
    for para in paras:
        pid = para["pid"]
        g = G[G["pid"] == pid]
        visits, revisit, first_entry = revisits(g, n, tick_sec) if n else (0, 0, None)

        # ---- B채널: GVAM 가중 (사용 틱만) ----
        gu = g[use[g["i"].to_numpy()]] if len(g) else g
        idx = gu["i"].to_numpy()
        w = gu["w"].to_numpy()
        B = df.iloc[idx] if len(idx) else df.iloc[0:0]
        sw = float(w.sum())
        dwell_gvam = sw * tick_sec
        dwell_view = len(idx) * tick_sec

        if len(idx):
            v = B["abs_scroll_v"].to_numpy()
            valid = ~np.isnan(v)
            still = np.where(valid, v <= CFG["SCROLL_STILL_PXPS"], B["scrollEvents"].to_numpy() == 0)
            vfd = float((w * still).sum()) * tick_sec
            wpos = w > 0
            sm, sstd, _ = _wmean_std(v[valid & wpos], w[valid & wpos])
            scrlfreq = float((w * B["scrollEvents"].to_numpy()).sum()) / (sw * tick_sec) if sw > 0 else 0.0
            s_tr, s_tr_low = _slope_sign(B["scrollEvents"].to_numpy()[wpos].tolist(), w[wpos].tolist())
            dep = B["depth"].to_numpy()
            dok = ~np.isnan(dep) & wpos
            depth = float((w[dok] * dep[dok]).sum() / w[dok].sum()) if dok.any() and w[dok].sum() > 0 else np.nan
        else:
            vfd, sm, sstd, scrlfreq, s_tr, s_tr_low, depth = 0.0, 0.0, 0.0, 0.0, 0, True, np.nan

        # entry_scrlspeed: 읽기 구간 첫 진입 틱부터 첫 유효 속도
        entry = 0.0
        if first_entry is not None:
            zi = g[g["inzone"]]["i"].to_numpy()
            for i in zi:
                sv = df.at[i, "abs_scroll_v"]
                if not np.isnan(sv):
                    entry = float(sv)
                    break

        # ---- A채널: 커서가 이 유닛의 조각 상자 안 (apid == pid), 사용 틱만 ----
        A = df[(df["apid"] == pid) & df["use"]] if n else df
        n_a = len(A)
        if n_a:
            ai = A.index.to_numpy()
            # A-run: 원래 틱 순서에서 연속 + 같은 리셋 run
            a_brk = np.r_[True, (np.diff(ai) != 1) | (A["run"].to_numpy()[1:] != A["run"].to_numpy()[:-1])]
            a_run = np.cumsum(a_brk)
            Av = A[~a_brk]                       # 크기 계산은 A-run 첫 틱 제외
            cur_vals = Av["cur_speed"].tolist()
            cm = float(np.mean(cur_vals)) if cur_vals else 0.0
            cstd, _ = _std_guarded(cur_vals)
            c_tr, c_tr_low = _slope_sign(cur_vals)
            cursorfreq = float(A["mouseEvents"].sum()) / (n_a * tick_sec)
            cursor_conc = float(A["cy"].std(ddof=1)) if n_a > 1 else 0.0
            pause = sum(_count_pauses(A["moved"].to_numpy()[a_run == r].tolist()) for r in np.unique(a_run))
            xpix, ypix = float(Av["mdx"].sum()), float(Av["mdy"].sum())
            vw = float(A["vw"].median())
            xdist = xpix / (vw + EPS)
            hr = xpix / (xpix + ypix + EPS)
            mv = Av[Av["moved"]]
            hr_tr, hr_low = _slope_sign((mv["mdx"] / (mv["mdx"] + mv["mdy"])).tolist())
        else:
            cm = cstd = cursorfreq = cursor_conc = xdist = hr = 0.0
            c_tr_low = hr_low = True
            c_tr = hr_tr = pause = 0

        b = base.get(bundle["tester_id"], {"scroll_mean": 0, "scroll_std": 1, "cursor_mean": 0, "cursor_std": 1})
        charlen = para.get("charLen", 0)
        expected = charlen / CFG["CHARS_PER_SEC"] if charlen else np.nan

        rows.append({
            # --- 메타 ---
            "tester_id": bundle["tester_id"],
            "install_id": bundle["install_id"],
            "session_id": bundle["session_id"],
            "page_id": page_id,
            "url": meta.get("url"),
            "paragraph_id": pid,
            "unit_order": para.get("order", -1),
            "char_len": charlen,
            "text": (para.get("text") or "")[:120],
            "highlight_text": " || ".join(hl.get(pid, []))[:500],
            "copy_text": " || ".join(cp.get(pid, []))[:500],
            "query": query_info[0],
            "query_source": query_info[1],
            "scenario": bundle["session"].get("scenario"),
            "label_state": rat.get(pid) if lab else None,
            "label_n": RATE_N.get(rat.get(pid), np.nan) if lab else np.nan,
            "label_excluded": (pid in exc) if lab else np.nan,
            "label_rate_ms": rate_gap.get(pid, np.nan),
            "label_mark": (int(pid in mk) if pid in rat else np.nan) if lab else np.nan,
            "page_labeled": lab is not None,
            "label_trigger": lab.get("trigger") if lab else None,
            "page_label_ms": lab.get("ms") if lab else np.nan,
            "label_phase_ask_ms": pms.get("ask", np.nan),
            "label_phase_rate_ms": pms.get("rate", np.nan),
            "label_phase_mark_ms": pms.get("mark", np.nan),
            "label_phase_survey_ms": pms.get("survey", np.nan),
            "survey_gain": lab_sv.get("gain"),
            "survey_interest": lab_sv.get("interest", np.nan),
            "survey_familiarity": lab_sv.get("familiarity", np.nan),
            "n_labelask_no": n_ask_no,
            "is_noise": (pid in noise_set) if noise_set is not None else np.nan,
            "scroll_depth_pct": round(depth, 4) if depth == depth else np.nan,
            "dwell_gvam_sec": round(dwell_gvam, 3),
            "dwell_viewport_sec": round(dwell_view, 2),
            "dwell_normalized": round(dwell_gvam / expected, 3) if expected and expected > 0 else np.nan,
            "visit_count": visits,
            "n_vis_ticks": len(idx),
            "n_cursor_ticks": n_a,
            "z_is_weak": n_sess_tester < CFG["MIN_SESSIONS_FOR_Z"],
            "trend_low_sample": bool(s_tr_low or c_tr_low or hr_low),
            "page_disruptive_rescan": disruptive,
            "page_splice_count": n_splice,
            "is_retired": bool(para.get("retired")),
            "_after": para.get("after") if para.get("retired") else None,
            "page_missing_chunks": missing,
            "page_idle_sec": round(float(df["idle"].sum()) * tick_sec, 1) if n else 0.0,
            "page_edit_ticks": int(df["edit"].sum()) if n else 0,

            # --- 모델 feature ---
            "has_highlight": int(pid in hl),
            "has_copy": int(pid in cp),
            "viewport_fixed_duration": round(vfd, 3),
            "pause_count": int(pause),
            "horizontal_ratio": round(hr, 3),
            "horizontal_ratio_trend": hr_tr,
            "xdist": round(xdist, 3),
            "cursor_speed_z": round(_z(cm, b["cursor_mean"], b["cursor_std"]), 3) if n_a else 0.0,
            "cursor_speed_std": round(cstd, 3),
            "cursor_speed_trend": c_tr,
            "cursorfreq": round(cursorfreq, 3),
            "cursor_conc": round(cursor_conc, 2),
            "scroll_speed_z": round(_z(sm, b["scroll_mean"], b["scroll_std"]), 3) if sw > 0 else 0.0,
            "scroll_speed_std": round(sstd, 3),
            "scrlfreq": round(scrlfreq, 3),
            "scrlfreq_trend": s_tr,
            "entry_scrlspeed": round(entry, 2),
            "revisit_count": revisit,
        })
    return rows, G


# =============================================================================
# 7) 검색어: 세션 안 검색 결과 페이지 → 그 뒤에 연 글
# =============================================================================
def page_queries(bundle):
    """pageId → (query, source). 직전 검색 결과 페이지 URL > 팝업 수동 입력."""
    starts = []
    for p in bundle["pages"]:
        m = p["meta"]
        t0 = min((g.get("t", 0) for g in m.get("segments", [])), default=0)
        starts.append((t0, m.get("pageId"), m.get("url")))
    starts.sort()
    out, last = {}, None
    manual = bundle["session"].get("searchQuery")
    for _t, pid, url in starts:
        q = search_query_of(url or "")
        if q:
            last = q
            out[pid] = (q, "search_page")
        elif last:
            out[pid] = (last, "search_page")
        elif manual:
            out[pid] = (manual, "manual")
        else:
            out[pid] = (None, None)
    return out


# =============================================================================
# main
# =============================================================================
def reading_order(g):
    """한 페이지 행을 글 순서로: 최종 유닛은 order 순, 사라진 유닛은 사라질 때 바로 앞 유닛(after) 뒤에 끼운다.
    after 가 다시 사라진 유닛이면 사슬로 따라간다(토글 안 3-1 → 3-2 → 3-3). 앞을 못 찾으면 맨 끝."""
    alive = g[~g["is_retired"]].sort_values("unit_order", kind="stable")
    ret = g[g["is_retired"]]
    kids = {}
    for idx, r in ret.iterrows():
        kids.setdefault(r["_after"] if isinstance(r["_after"], str) else None, []).append(idx)
    seq, done = [], set()

    def emit(idx, pid):
        seq.append(idx)
        done.add(idx)
        for k in kids.get(pid, []):
            if k not in done:
                emit(k, g.at[k, "paragraph_id"])

    for k in kids.get(None, []):                         # 맨 앞에서 사라진 유닛
        if k not in done:
            emit(k, g.at[k, "paragraph_id"])
    for idx, r in alive.iterrows():
        emit(idx, r["paragraph_id"])
    seq += [k for k in ret.index if k not in done]       # 앞 유닛을 못 찾은 것
    o = g.loc[seq].copy()
    o["unit_order"] = range(len(o))
    return o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+", help="세션 bundle JSON (rbc_*.json)")
    ap.add_argument("-o", "--output", default="features.csv")
    ap.add_argument("--noise", help="본문 아닌 유닛 파일 {pageId|url: [pid, ...]}")
    ap.add_argument("--no-selection-features", action="store_true",
                    help="has_highlight / has_copy 를 모델 feature 목록에서 뺌 (컬럼은 남음)")
    ap.add_argument("--final-only", action="store_true",
                    help="기록 중 사라진 유닛(is_retired) 행을 뺌. 기본은 남김 — 사용자가 읽은 글은 전부 보존한다")
    args = ap.parse_args()

    noise = json.load(open(args.noise, encoding="utf-8")) if args.noise else None
    bundles = [load_bundle(p) for p in args.inputs]

    frames = []                       # (bundle, page, df)
    for bd in bundles:
        for pg in bd["pages"]:
            frames.append((bd, pg, prep_ticks(pg, bd["tick_ms"])))
    base = build_baselines([(bd["tester_id"], df) for bd, _pg, df in frames])
    n_sess = {}
    for bd in bundles:
        n_sess[bd["tester_id"]] = n_sess.get(bd["tester_id"], 0) + 1

    all_rows, checks = [], []
    for bd in bundles:
        qmap = page_queries(bd)
        for pg in bd["pages"]:
            df = next(d for b2, p2, d in frames if p2 is pg)
            rows, G = page_rows(bd, pg, df, base, n_sess[bd["tester_id"]],
                                qmap.get(pg["meta"].get("pageId"), (None, None)), noise)
            all_rows += rows
            checks.append((bd, pg, df, G, rows))

    out = pd.DataFrame(all_rows)
    if out.empty:
        sys.exit("유닛 행이 0개.")
    # 표 = 페이지마다 "사용자 화면에 나온 모든 유닛을 글 순서대로" + 행동 데이터 (2026-10-08 서현 결정).
    #   기록 중 본문 변경(토글 여닫기 등)으로 사라진 유닛(is_retired)도 화면에 한 번이라도 나왔으면 남긴다 — 읽은 글이다.
    #   화면에 한 번도 안 나온 사라진 유닛은 뺀다(잠깐 생겼다 사라진 덩어리). 최종 유닛은 안 나왔어도 남긴다(= 안 읽음).
    #   unit_order 는 다시 매긴 글 순서: 사라진 유닛은 사라질 때 자리 바로 앞에 놓는다.
    #   같은 글이 두 버전으로 두 줄에 있을 수 있다(예: 토글 닫힌 제목 덩어리 · 열린 덩어리).
    n_ret = int(out["is_retired"].sum())
    out = out[~out["is_retired"] | (out["n_vis_ticks"] > 0)]
    if args.final_only:
        out = out[~out["is_retired"]]
    out = pd.concat([reading_order(g) for _, g in out.groupby(["session_id", "page_id"], sort=False)],
                    ignore_index=True)
    out = out.drop(columns=["_after"])
    out.to_csv(args.output, index=False)

    feats = [f for f in MODEL_FEATURES if not (args.no_selection_features and f in SELECTION_FEATURES)]
    print(f"세션 {len(bundles)}개 · 페이지 {len(checks)}개 → 유닛 행 {len(out)}개  (→ {args.output})")
    print(f"  · 모델 feature {len(feats)}개")
    if n_ret:
        print(f"  · 기록 중 사라진 유닛 {n_ret}행 " + ("제외(--final-only)" if args.final_only else
              "중 화면에 나온 것만 글 순서대로 포함(is_retired=True)"))

    # ---- 검산 (판정 아님, 사람이 보는 용) ----
    for bd, pg, df, G, rows in checks:
        m = pg["meta"]
        if df.empty:
            print(f"\n[{m.get('url','')[:70]}] 틱 없음")
            continue
        tick_sec = bd["tick_ms"] / 1000.0
        sw_tick = G.groupby("i")["w"].sum() if len(G) else pd.Series(dtype=float)
        cmap = df["centerPid"].to_dict()
        gc = G[[cmap.get(i) == p for i, p in zip(G["i"], G["pid"])]] if len(G) else G
        n_center = int(df["centerPid"].notna().sum())
        c_ok = float(((gc["w"] > 0) & gc["inzone"]).sum()) / n_center if n_center else float("nan")
        used = float(df["use"].sum()) * tick_sec
        r = pd.DataFrame(rows)
        print(f"\n[{m.get('url','')[:70]}]")
        print(f"  틱 {len(df)} · run {df['run'].nunique()} · 사용 {used:.1f}s "
              f"(idle {df['idle'].sum()} · 편집 {df['edit'].sum()} 틱 제외)")
        print(f"  Σw/틱  평균 {sw_tick.mean():.3f} · 최대 {sw_tick.max():.3f}  (≤ 1 이어야 함)")
        print(f"  Σ dwell_gvam {r['dwell_gvam_sec'].sum():.1f}s ≤ 사용 {used:.1f}s · "
              f"centerPid 가 w>0 · 읽기 구간 안 {c_ok*100:.0f}%  (100% 근처여야 함)")
        print(f"  커서 귀속 틱: 글자 위 {df['cursorPid'].notna().mean()*100:.0f}% → 조각 상자 {df['apid'].notna().mean()*100:.0f}%")
        print(f"  유닛 {len(r)} · 화면에 나온 유닛 {(r['n_vis_ticks']>0).sum()} · "
              f"방문 ≥1 {(r['visit_count']>0).sum()} · 재방문 ≥1 {(r['revisit_count']>0).sum()} · "
              f"하이라이트 {r['has_highlight'].sum()} · 복사 {r['has_copy'].sum()} · "
              f"라벨 " + (" ".join(f"{k}{(r['label_state'] == k).sum()}" for k in RATE_N_ALL)
                         + f" · 중요 {int(r['label_mark'].sum())}" if r['page_labeled'].iloc[0] else '없음'))
        if r["page_disruptive_rescan"].any():
            print("  ⚠ 본문 교체(disruptive, 옛 확장) 페이지 — 학습 제외 권장")
        if r["is_retired"].any():
            rd = r["dwell_gvam_sec"].where(r["is_retired"], 0).sum()
            td = r["dwell_gvam_sec"].sum()
            print(f"  · 기록 중 본문 변경(splice {int(r['page_splice_count'].iloc[0])}회) — 사라진 유닛 "
                  f"{int(r['is_retired'].sum())}개, 체류 {rd:.1f}s / {td:.1f}s ({(rd / td * 100) if td else 0:.0f}%)"
                  f"{' — CSV 에서는 뺌(--final-only)' if args.final_only else ''}")
        if r["page_missing_chunks"].iloc[0]:
            print(f"  ⚠ 유실 조각 {r['page_missing_chunks'].iloc[0]}개")
        with pd.option_context("display.max_columns", None, "display.width", 200):
            cols = ["unit_order", "dwell_gvam_sec", "dwell_viewport_sec", "visit_count", "revisit_count",
                    "viewport_fixed_duration", "scrlfreq", "entry_scrlspeed", "pause_count",
                    "cursorfreq", "has_highlight", "label_state", "label_mark"]
            # CSV 와 같은 행만, 같은 글 순서로 (화면에 안 나온 사라진 유닛 제외)
            show = r[~r["is_retired"] | (r["n_vis_ticks"] > 0)].copy()
            show = reading_order(show.assign(session_id="", page_id=""))
            show["retired"] = show["is_retired"].map({True: "닫힘", False: ""})
            print(show[cols + ["retired"]].to_string(index=False))


if __name__ == "__main__":
    main()