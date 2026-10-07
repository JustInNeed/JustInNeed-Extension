#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
inspect_bundle.py — 세션 bundle 의 "모양"을 사람이 읽게 요약한다.

check_session.py 는 불변식이 깨졌는지(PASS/FAIL)를 본다.
이건 시나리오가 의도대로 기록됐는지(방문 순서, 구간이 몇 개로 나뉘었나,
어느 탭에서 틱이 찍혔나)를 눈으로 확인하는 용도다. 판정은 하지 않는다.

  python3 inspect_bundle.py step7.json
"""
import json
import sys


def short(s, n=48):
    s = str(s)
    return s if len(s) <= n else s[:n - 1] + '…'


def main(path):
    b = json.load(open(path, encoding='utf-8'))
    if b.get('kind') != 'rbc-session':
        sys.exit('세션 bundle 이 아님')
    s = b['session']
    tick = s.get('tickMs', 150)

    # 페이지마다 짧은 별명 (P0, P1 ...) — 방문 목록을 읽기 쉽게
    alias = {p['meta']['pageId']: f'P{i}' for i, p in enumerate(b['pages'])}

    print(f'세션 {s["sessionId"][:8]} · focus {s["focusMs"] / 1000:.1f}s · 정지 사유 {s.get("stopReason")}')
    t = s.get('tester') or {}
    print(f'참여 번호 {t.get("participantNo") or "—"} · 설치 ID {t.get("testId") or "—"} · 태그 {t.get("tag") or "—"}'
          f' · 동의 v{t.get("consentVersion", "?")}')

    print('\n[방문 순서]')
    for v in s.get('visits', []):
        pid = v.get('pageId')
        name = alias.get(pid, '—' if pid is None else short(pid, 30))
        seg = (v.get('segId') or '')[:6]
        print(f'  {v["t"] / 1000:7.1f}s  {v["reason"]:<12} {name:<6} tab {v.get("tabId")}  seg {seg}')

    print('\n[페이지]')
    for p in b['pages']:
        m, tl = p['meta'], p['timeline']
        print(f'  {alias[m["pageId"]]}  {short(m["pageId"], 70)}')
        for g in m.get('segments', []):
            sid = g['segId']
            ev = [e for e in tl if e.get('segId') == sid]
            ticks = sum(1 for e in ev if e['type'] == 'tick')
            ends = [e.get('reason') for e in ev if e['type'] == 'segend']
            hides = sum(1 for e in ev if e['type'] == 'visibility' and e.get('hidden'))
            url_hash = '#' in (g.get('url') or '')
            print(f'      seg {sid[:6]} tab {g.get("tabId")}  틱 {ticks:4d} ({ticks * tick / 1000:.1f}s)'
                  f'  숨김 {hides}회  끝 {ends or "-"}' + ('  (시작 URL 에 #)' if url_hash else ''))

    rep = s.get('chunkReport', [])
    bad = [r for r in rep if r.get('missing') or r.get('orphan') or r.get('end') == 'open']
    print(f'\n[조각] 구간 {len(rep)}개 · 문제 {len(bad)}개 · 중복 {sum(r.get("duplicates", 0) for r in rep)}')
    for r in bad:
        print(f'  {r["segId"][:6]} missing {r.get("missing")} end {r.get("end")} orphan {r.get("orphan")}')
    if s.get('droppedPages'):
        print(f'[제외] {s["droppedPages"]}')


if __name__ == '__main__':
    main(sys.argv[1])