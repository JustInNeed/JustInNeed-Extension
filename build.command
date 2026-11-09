#!/usr/bin/env bash
# 합치기 — Finder 에서 더블클릭. 기록 엔진(recorder-core/) + 버전 폴더 하나를 합쳐 build/<버전>/ 을 만든다.
# 크롬 "압축해제된 확장 프로그램 로드"에는 build/<버전>/ 을 고른다. build/ 는 git 밖(매번 새로 만든다).
# 같은 경로의 파일이 엔진과 버전 폴더 양쪽에 있으면 덮어쓰지 않고 멈춘다(어느 쪽이 맞는지 사람이 정할 일).
# 터미널에서: bash build.command            → 전부(data-collect · service · service-dev) — 더블클릭과 같음
#             bash build.command data-collect → 하나만
#             bash build.command service-dev  → 시험 서버용(#34): service 와 같고, 서버 · 웹 주소와 manifest 허용 목록만
#                                              localhost(BE 8080 · 웹 3000)로 바꾼 build/service-dev/. 더블클릭에도 같이 만든다(#36, 11-03 서현).
#                                              확장 ID 가 같아서 service 와 동시에 켤 수 없다 — 하나만 로드할 것
#             bash build.command zip          → 팀 배포 zip (#67). 아래 "배포 zip" 참고
#
# 개발 빌드 표시 (#67, 11-09 서현 — build/ 폴더와 zip 을 푼 폴더가 크롬 카드에서 똑같이 보여 분간이 안 됨):
#   build/<버전>/manifest.json 에 version_name = "<버전> · 개발 <브랜치> <커밋>[+수정] <MM-DD HH:MM>" 을 넣는다.
#   크롬 확장 카드는 version_name 이 있으면 숫자 대신 그 글자를 보여 준다. version 숫자 · 확장 ID 는 그대로.
#   +수정 = 커밋 안 한 변경(recorder-core · data-collect · service)이 섞인 빌드.
# 배포 zip (#67): main · 커밋 안 한 변경 없음 · origin/main 과 같음을 확인하고(아니면 멈춤), data-collect · service 를
#   version_name 없이 합쳐 build/release/justinneed-<버전>-<숫자>-<MMDD>-<커밋>.zip 을 만든 뒤 zip 안을 검사한다.
#   검사 하나라도 실패면 그 zip 을 지우고 실패로 끝난다(크롬에 올려 보지 않아도 되게 — 결과 줄만 보면 됨).
cd "$(dirname "$0")" || exit 1
CORE=recorder-core
DEV_API='http://localhost:8080'
DEV_WEB='http://localhost:3000'

# 파일 안의 글자를 정확히 한 번 바꾼다. 없거나 여러 번이면 실패(원본 줄 모양이 바뀌었다는 뜻 — 조용히 넘어가지 않게)
swap() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
p, a, b = sys.argv[1:4]
s = open(p, encoding='utf-8').read()
n = s.count(a)
if n != 1:
    sys.exit(f"  {p}: '{a}' 가 {n}번 있음 (1번이어야 함)")
open(p, 'w', encoding='utf-8').write(s.replace(a, b))
PY
}

# service-dev = service 합본에서 주소만 시험 서버로
to_dev() {
  local out=$1
  swap "$out/bg-auth.js" "const API_BASE = PROD_API;" "const API_BASE = '$DEV_API';" &&
  swap "$out/bg-auth.js" "const WEB_BASE = PROD_WEB;" "const WEB_BASE = '$DEV_WEB';" &&
  swap "$out/manifest.json" '"https://api.justinneed.xyz/*"' "\"$DEV_API/*\"" &&
  swap "$out/manifest.json" '"https://just-in-need-fe.vercel.app/*"' "\"$DEV_WEB/*\"" &&
  swap "$out/manifest.json" '"name": "JustInNeed",' '"name": "JustInNeed (시험 서버)",'
}
# manifest 에 개발 빌드 표시를 넣는다 (#67). 실패하면 합본을 쓰지 않게 실패로 돌려준다.
mark_dev() {
  local out=$1 label
  label="개발 $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?') $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  [ -n "$(git status --porcelain -- recorder-core data-collect service 2>/dev/null)" ] && label="$label+수정"
  label="$label $(date +'%m-%d %H:%M')"
  python3 - "$out/manifest.json" "$label" <<'PY2'
import json, sys
p, label = sys.argv[1:3]
m = json.load(open(p, encoding='utf-8'))
m['version_name'] = f"{m['version']} · {label}"
open(p, 'w', encoding='utf-8').write(json.dumps(m, ensure_ascii=False, indent=2) + '\n')
print(f"  카드 표시: {m['version_name']}")
PY2
}

# 배포 zip (#67)
release() {
  local branch head origin dirty ver day rel z
  branch=$(git rev-parse --abbrev-ref HEAD) || return 1
  [ "$branch" = main ] || { echo "zip 은 main 에서만 — 지금 브랜치: $branch (git checkout main && git pull)" >&2; return 1; }
  dirty=$(git status --porcelain -- recorder-core data-collect service build.command)
  [ -z "$dirty" ] || { echo "커밋 안 한 변경이 있어 멈춤:"$'\n'"$dirty" >&2; return 1; }
  git fetch -q origin main || { echo "origin/main 을 받지 못함(인터넷?) — 멈춤" >&2; return 1; }
  head=$(git rev-parse --short HEAD); origin=$(git rev-parse --short origin/main)
  [ "$head" = "$origin" ] || { echo "main($head) 이 origin/main($origin) 과 다름 — git pull 먼저" >&2; return 1; }
  rel=build/release; day=$(date +'%m%d')
  mkdir -p "$rel" || return 1
  local made=() v
  # 중간에 실패하면 그때까지 만든 zip 과 임시 폴더를 지운다 — build/release 에는 검사를 통과한 zip 만 남게 (#67 검토)
  bail() { rm -f "${made[@]}"; rm -rf "${rel:?}/data-collect" "${rel:?}/service"; echo "$1 — 만든 zip 을 지움" >&2; return 1; }
  for v in data-collect service; do
    merge "$v" "$rel/$v" no-mark || { bail "$v 합치기 실패"; return 1; }
    ver=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$rel/$v/manifest.json") || { bail "$v 버전 읽기 실패"; return 1; }
    z="$rel/justinneed-$v-$ver-$day-$head.zip"
    rm -f "$z"
    made+=("$z")
    # git 이 지키는 파일만 들어가야 한다 — .gitignore 된 기록 JSON · CSV 가 폴더에 있어도 zip 에 실려 나가지 않게 (#67 검토)
    git ls-files -- "$CORE" "$v" | sed -e "s#^$CORE/##" -e "s#^$v/##" | sort -u > "$rel/$v.tracked" || { bail "$v 파일 목록 실패"; return 1; }
    (cd "$rel/$v" && zip -qr "../$(basename "$z")" . -x '.*') || { bail "$z 묶기 실패"; return 1; }
    rm -rf "${rel:?}/$v"
  done
  # zip 안 검사 — 실패면 zip 을 지운다
  python3 - "${made[@]}" <<'PY2' || { rm -f "${made[@]}" "$rel"/*.tracked; echo "검사 실패 — zip 을 지움. 위 ✗ 줄을 볼 것" >&2; return 1; }
import json, sys, zipfile
ok = True
def check(cond, msg):
    global ok
    print(('  ✓ ' if cond else '  ✗ ') + msg)
    ok = ok and cond
vers = []
for z in sys.argv[1:]:
    kind = 'service' if '-service-' in z else 'data-collect'
    print(z)
    f = zipfile.ZipFile(z)
    names = f.namelist()
    m = json.loads(f.read('manifest.json'))
    vers.append(m['version'])
    want = 'JustInNeed' if kind == 'service' else 'JustInNeed 데이터 수집'
    check(m.get('name') == want, f"이름 = {m.get('name')!r} (기대 {want!r})")
    check('version_name' not in m, f"개발 표시(version_name) 없음 — 카드에 {m['version']} 만 보임")
    check(not any(n.endswith('.pem') for n in names), '개인 키(.pem) 없음')
    check(not any(p.startswith('.') for n in names for p in n.split('/') if p), '숨김 파일(.DS_Store 등) 없음')
    tracked = set(open(z.rsplit('/', 1)[0] + f'/{kind}.tracked', encoding='utf-8').read().split('\n')) - {''}
    extra = sorted(n for n in names if not n.endswith('/') and n not in tracked)
    check(not extra, 'git 이 지키는 파일만 (기록 JSON · CSV 같은 무시 파일 없음)' + (f' — 섞인 것: {extra[:5]}' if extra else ''))
    check('localhost' not in json.dumps(m), 'manifest 에 localhost 없음')
    if kind == 'service':
        check(bool(m.get('key')), '확장 ID 고정 key 있음 (ID pgmclbgdbaiigahdhpnieemifhgoikpa 그대로)')
        check(m.get('host_permissions') == ['https://api.justinneed.xyz/*'], f"서버 주소 = {m.get('host_permissions')}")
        auth = f.read('bg-auth.js').decode('utf-8')
        check('const API_BASE = PROD_API;' in auth and 'const WEB_BASE = PROD_WEB;' in auth, 'bg-auth 운영 주소(시험 서버 아님)')
    else:
        check('key' not in m, 'key 없음 (데이터 수집 버전은 원래 없음)')
check(len(set(vers)) == 1, f"두 버전 번호 같음: {vers}")
sys.exit(0 if ok else 1)
PY2
  rm -f "$rel"/*.tracked
  echo "배포 zip 끝 (main $head):"; printf '  %s\n' "${made[@]}"
}

# 합치기: 엔진 + 버전 폴더 → out. 세 번째 인자 no-mark 면 개발 표시를 안 넣는다(배포용)
merge() {
  local v=$1 out=$2 mark=${3:-mark} src clash
  # 아는 버전 이름만 — out 을 지우므로 '../x' · 'build' 같은 이름이 레포 폴더를 지우지 않게
  case "$v" in
    data-collect|service) src=$v ;;
    service-dev) src=service ;;
    *) echo "모르는 버전 이름: $v (data-collect · service · service-dev 만)" >&2; return 1 ;;
  esac
  if [ ! -d "$src" ]; then echo "버전 폴더 없음: $src" >&2; return 2; fi
  clash=$(cd "$src" && find . -type f ! -name '.DS_Store' | while IFS= read -r f; do
    [ -e "../$CORE/$f" ] && echo "  ${f#./}"
  done)
  if [ -n "$clash" ]; then
    echo "$src: 엔진과 같은 경로의 파일이 있어 멈춤:"$'\n'"$clash" >&2; return 1
  fi
  rm -rf "$out" && mkdir -p "$out" || { echo "$out 을 만들 수 없음" >&2; return 1; }
  cp -R "$CORE/." "$out/" && cp -R "$src/." "$out/" || { echo "$v: 복사 실패" >&2; return 1; }
  find "$out" -name '.DS_Store' -delete
  if [ "$v" = service-dev ]; then
    to_dev "$out" || { echo "$v: 시험 서버 주소로 바꾸기 실패 — 위 메시지를 볼 것" >&2; rm -rf "$out"; return 1; }
  fi
  # 개발 표시는 맨 마지막 — mark_dev 가 manifest 를 json 으로 다시 써서 줄 모양이 바뀌므로, 글자 그대로 바꾸는 swap(to_dev)은 그 앞에
  if [ "$mark" = mark ]; then
    mark_dev "$out" || { echo "$v: 개발 빌드 표시 넣기 실패" >&2; rm -rf "$out"; return 1; }
  fi
  echo "만듦: $out"
}

if [ "${1:-}" = zip ]; then
  release; exit $?
fi

versions=("$@")
[ ${#versions[@]} -eq 0 ] && versions=(data-collect service service-dev)
fail=0

for v in "${versions[@]}"; do
  merge "$v" "build/$v"; r=$?
  # 버전 폴더가 없을 때(2)는 이름을 직접 줬을 때만 오류
  if [ $r -eq 1 ] || { [ $r -eq 2 ] && [ $# -gt 0 ]; }; then fail=1; fi
done

if [ $fail -eq 0 ]; then echo "합치기 끝"; else echo "합치기 실패 — 위 메시지를 볼 것" >&2; fi
exit $fail
