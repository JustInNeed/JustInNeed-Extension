#!/usr/bin/env python3
"""기록 파일 목록 — 파일마다 참여 번호 · 질문 태그 · 글 · 평가 여부 · 유닛 수를 한 줄씩.

    python3 tools/list_files.py data/*.json

글 이름은 아래 GLOBS 의 주소 조각으로 판정 (1차 글 묶음, 2026-10-11). 글 묶음이 바뀌면 여기만 고친다.
한 파일에 글이 둘 이상이면(평가 없이 다음 글로 넘어간 경우) 페이지마다 한 줄씩 나온다.
"""
import json
import sys

GLOBS = [   # 채점표 드롭다운 표기와 같게 (2026-10-11)
    ("015/0005339227", "0-연습"),
    ("notion.site", "1-노션"),
    ("app.notion.com", "1-노션(앱 화면 · 유닛 구성 다름 → 제외)"),
    ("bizwatch", "2-비즈워치"),
    ("215/0001253530", "3-네이버 기사"),
    ("m.blog.naver", "4-네이버 블로그"),
]


def labeled(page):
    return any(e.get("type") == "label" and not e.get("cancelled") for e in page.get("timeline", []))


def main(paths):
    for f in sorted(paths):
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception as e:  # 깨진 파일도 목록에서 빠지지 않게
            print(f"{f.split('/')[-1]}\t읽기 실패: {e}")
            continue
        t = (d.get("session") or {}).get("tester") or {}
        for p in d.get("pages", []):
            m = p.get("meta", {})
            url = m.get("url", "")
            name = next((v for k, v in GLOBS if k in url), "?(" + url[:40] + ")")
            print("\t".join([f.split("/")[-1][:30], str(t.get("participantNo")), str(t.get("tag")), name,
                             "평가O" if labeled(p) else "평가X", f"유닛 {len(m.get('paragraphs', []))}"]))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])