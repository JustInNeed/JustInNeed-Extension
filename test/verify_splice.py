"""splice 시험 글(splice_test.html) 기록을 단계별로 검증한다 — 0-B splice 가 실제 브라우저에서 맞게 도는지.

사용:
    cd tests && python3 -m http.server 8000      # 다른 터미널
    # 크롬에서 http://localhost:8000/splice_test.html → 기록 → 단계 1~4 → 끝까지 → 평가 → 저장
    python3 verify_splice.py ~/Downloads/rbc_….json

보는 것 (각 줄 PASS/WARN/FAIL):
  [1] 재스캔 순서: 단계 1·2·3 = splice, 단계 4 = append. 자체 검증 전부 [0,0], 루트 안 바뀜
  [2] 표식([P1]…[P12] · [INS-A] · [AD-B] · [TAIL])마다 어느 유닛에 들었나 — 마지막 화면 기준 살아 있어야 할 것 / 사라졌어야 할 것
  [3] 끼어든 곳 밖 유닛은 pid 유지: [P9]~[P11] 유닛(광고 뒤) · [P12] 유닛(끝에 덧붙기 전)이 처음부터 끝까지 한 pid
  [4] 노란 문단 체류: [INS-A] 유닛에 중앙선 체류가 잡혔나 (단계 1 안내대로 봤다면 1.5초 이상)
  [5] 사라진 유닛 이후 틱: 사라진 pid 를 가리키는 틱이 그 뒤에 없나
  [6] 같은 글 두 버전: 한 표식이 서로 다른 유닛 여러 개에 들어 있으면 보고 (일반 사이트에 벽이 없어서 생기는 경우)
  [7] 글 순서 복원: extract_features 와 같은 규칙으로 최종 목록을 표식으로 찍어 줌 (눈으로 확인)
"""
import json
import re
import sys

OK, WARN, FAIL = "ok  [PASS]", "!!  [WARN]", "XX  [FAIL]"
TAG = re.compile(r"\[(P\d+|INS-A|AD-B|TAIL)\]")


def main(path):
    d = json.load(open(path, encoding="utf-8"))
    pages = [p for p in d.get("pages", []) if "splice_test" in (p["meta"].get("url") or "")]
    if not pages:
        sys.exit("splice_test 페이지 기록이 없음")
    pg = pages[0]
    meta, tl = pg["meta"], pg["timeline"]
    paras = meta["paragraphs"]
    ticks = [e for e in tl if e.get("type") == "tick"]
    res = []

    # [1] 재스캔 순서
    rs = [e for e in tl if e.get("type") == "rescan"]
    seq = [e.get("mode") for e in rs]
    print("재스캔:", " → ".join(f"{e.get('mode')}(t={e.get('t', 0) / 1000:.1f}s"
                                  + (f", 유지 {e.get('kept')} 새 {e.get('added')} 사라짐 {e.get('retired')} 검증 {e.get('check')}"
                                     if e.get("mode") == "splice" else "") + ")" for e in rs) or "없음")
    n_sp, n_ap = seq.count("splice"), seq.count("append")
    bad = [e for e in rs if e.get("mode") == "splice" and (e.get("check") or [0, 0])[0] > 0]
    rootc = [e for e in rs if e.get("rootChanged")]
    lv = FAIL if bad or rootc or n_sp < 3 or n_ap < 1 else OK
    res.append((lv, "재스캔 순서", f"splice {n_sp}회(기대 3) · append {n_ap}회(기대 1) · 검증 실패 {len(bad)} · 루트 변경 {len(rootc)}"))

    # [2] 표식 위치
    where = {}
    for p in paras:
        for t in TAG.findall(p.get("text") or ""):
            where.setdefault(t, []).append(p)
    alive_tags = {t for p in paras if not p.get("retired") for t in TAG.findall(p.get("text") or "")}
    want_alive = {f"P{i}" for i in range(1, 13)} | {"AD-B", "TAIL"}
    miss = sorted(want_alive - alive_tags, key=lambda x: (len(x), x))
    ins_alive = "INS-A" in alive_tags
    ins_any = "INS-A" in where
    lv = FAIL if miss or ins_alive or not ins_any else OK
    res.append((lv, "표식 위치", f"마지막 화면에 없는 표식 {miss or '없음'} · [INS-A] 데이터에 {'있음' if ins_any else '없음!'}"
                                + (" · [INS-A] 가 아직 살아 있음(단계 3 반영 안 됨)" if ins_alive else " (사라진 유닛으로 보존)")))

    # [3] pid 유지 — 광고 뒤 · 덧붙기 전 끝 유닛
    stable = []
    for t in ("P9", "P12"):
        us = where.get(t, [])
        if len(us) == 1 and not us[0].get("retired"):
            pid = us[0]["pid"]
            first = next((e["t"] for e in ticks if any(v[0] == pid for v in (e.get("vis") or []))), None)
            stable.append(f"[{t}] 한 pid({pid}) 유지" + (f", 첫 노출 t={first / 1000:.1f}s" if first is not None else ""))
        else:
            stable.append(f"[{t}] 유닛 {len(us)}개({'/'.join(('사라짐' if u.get('retired') else '살아있음') for u in us)})")
    lv = OK if all("한 pid" in s for s in stable) else FAIL
    res.append((lv, "끼어든 곳 밖 pid 유지", " · ".join(stable)))

    # [4] 노란 문단 체류
    ins_pids = {p["pid"] for p in where.get("INS-A", [])}
    n = sum(1 for e in ticks if e.get("centerPid") in ins_pids)
    tick_ms = d.get("session", {}).get("tickMs", 150)
    sec = n * tick_ms / 1000
    res.append((OK if sec >= 1.5 else WARN, "노란 문단 체류",
                f"[INS-A] 유닛 중앙선 체류 {sec:.1f}s" + ("" if sec >= 1.5 else " — 단계 1 안내대로 3초 봤다면 FAIL 급, 아니면 무시")))

    # [5] 사라진 유닛을 가리키는 틱 (사라진 뒤)
    retired = {p["pid"] for p in paras if p.get("retired")}
    last_sp = max((e["t"] for e in rs if e.get("mode") == "splice"), default=None)
    stale = [e for e in ticks if last_sp is not None and e["t"] > last_sp
             and (e.get("centerPid") in retired or any(v[0] in retired for v in (e.get("vis") or [])))]
    res.append((FAIL if stale else OK, "사라진 뒤 틱", f"마지막 splice 뒤 사라진 pid 를 가리키는 틱 {len(stale)}개"))

    # [6] 같은 글 두 버전
    dup = {t: us for t, us in where.items() if len(us) > 1}
    if dup:
        det = " · ".join(f"[{t}] {len(us)}개({'/'.join(('사라짐' if u.get('retired') else '살아있음') for u in us)})"
                         for t, us in sorted(dup.items(), key=lambda x: (len(x[0]), x[0])))
        res.append((WARN, "같은 글 두 버전", det))
    else:
        res.append((OK, "같은 글 두 버전", "없음"))

    for lv, name, msg in res:
        print(f"  {lv} {name} — {msg}")

    # [7] 글 순서
    alive = sorted([p for p in paras if not p.get("retired")], key=lambda p: p.get("order", 0))
    kids = {}
    for p in paras:
        if p.get("retired"):
            kids.setdefault(p.get("after"), []).append(p)
    out, seen = [], set()

    def emit(p):
        out.append(p)
        seen.add(p["pid"])
        for k in kids.get(p["pid"], []):
            if k["pid"] not in seen:
                emit(k)

    for k in kids.get(None, []):
        emit(k)
    for p in alive:
        emit(p)
    out += [p for p in paras if p["pid"] not in seen]
    print("\n글 순서 (CSV 와 같은 규칙, 사라진 유닛 = ✗):")
    for i, p in enumerate(out):
        tags = " ".join(TAG.findall(p.get("text") or "")) or (p.get("text") or "")[:20]
        print(f"  {i:2d} {'✗' if p.get('retired') else ' '} {p['pid']:<12} {p.get('charLen', 0):>4}자  {tags}")


if __name__ == "__main__":
    main(sys.argv[1])