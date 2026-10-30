"""기록 파일에서 '본문 블록 떼어냄(가상화)' 흔적 검사.  사용: python3 check_virtual.py *.json
- splice_ret: retired > 0 인 splice 수 (토글을 안 건드렸는데 0 이 아니면 의심)
- dup: 앞 30자가 같은데 pid 가 다른 문단 쌍 (같은 글이 다르게 잘림 = pid 깨짐)
- alive_max / total: 동시에 살아 있던 유닛 최대 수 / 기록된 문단 수 (차이가 크면 창만 붙어 있던 것)"""
import json, sys, collections

for path in sys.argv[1:]:
    d = json.load(open(path))
    for p in d.get('pages', []):
        m, tl = p['meta'], p['timeline']
        resc = [e for e in tl if e.get('type') == 'rescan']
        splice_ret = sum(1 for e in resc if e.get('mode') == 'splice' and e.get('retired', 0) > 0)
        alive_max = max([e.get('units', 0) for e in resc] or [0])
        paras = m.get('paragraphs', [])
        alive_max = max(alive_max, sum(1 for x in paras if not x.get('retired')))
        heads = collections.defaultdict(set)
        for x in paras:
            t = (x.get('text') or '').strip()[:30]
            if len(t) >= 15:
                heads[t].add(x['pid'])
        dup = sum(1 for s in heads.values() if len(s) > 1)
        bad = splice_ret > 0 and dup > 0
        print(f"{'의심' if bad else 'OK  '}  splice_ret={splice_ret:<3} dup={dup:<3} "
              f"alive_max={alive_max:<3} total={len(paras):<4} {m.get('root', {}).get('how')}  "
              f"{(m.get('title') or '')[:30]}  [{path.split('/')[-1]}]")