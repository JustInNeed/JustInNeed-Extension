#!/usr/bin/env bash
# 합치기 — Finder 에서 더블클릭. 기록 엔진(recorder-core/) + 버전 폴더 하나를 합쳐 build/<버전>/ 을 만든다.
# 크롬 "압축해제된 확장 프로그램 로드"에는 build/<버전>/ 을 고른다. build/ 는 git 밖(매번 새로 만든다).
# 같은 경로의 파일이 엔진과 버전 폴더 양쪽에 있으면 덮어쓰지 않고 멈춘다(어느 쪽이 맞는지 사람이 정할 일).
# 터미널에서: bash build.command            → 전부(data-collect · service · service-dev) — 더블클릭과 같음
#             bash build.command data-collect → 하나만
#             bash build.command service-dev  → 시험 서버용(#34): service 와 같고, 서버 · 웹 주소와 manifest 허용 목록만
#                                              localhost(BE 8080 · 웹 3000)로 바꾼 build/service-dev/. 더블클릭에도 같이 만든다(#36, 11-03 서현).
#                                              확장 ID 가 같아서 service 와 동시에 켤 수 없다 — 하나만 로드할 것
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
versions=("$@")
[ ${#versions[@]} -eq 0 ] && versions=(data-collect service service-dev)
fail=0

for v in "${versions[@]}"; do
  # 아는 버전 이름만 — build/<이름> 을 지우므로 '../x' · 'build' 같은 이름이 레포 폴더를 지우지 않게
  case "$v" in
    data-collect|service) src=$v ;;
    service-dev) src=service ;;
    *) echo "모르는 버전 이름: $v (data-collect · service · service-dev 만)" >&2; fail=1; continue ;;
  esac
  if [ ! -d "$src" ]; then
    [ $# -gt 0 ] && { echo "버전 폴더 없음: $src" >&2; fail=1; }   # 이름을 직접 줬을 때만 오류
    continue
  fi
  clash=$(cd "$src" && find . -type f ! -name '.DS_Store' | while IFS= read -r f; do
    [ -e "../$CORE/$f" ] && echo "  ${f#./}"
  done)
  if [ -n "$clash" ]; then
    echo "$src: 엔진과 같은 경로의 파일이 있어 멈춤:"$'\n'"$clash" >&2; fail=1; continue
  fi
  out="build/$v"
  rm -rf "$out" && mkdir -p "$out" || { echo "$out 을 만들 수 없음" >&2; fail=1; continue; }
  cp -R "$CORE/." "$out/" && cp -R "$src/." "$out/" || { echo "$v: 복사 실패" >&2; fail=1; continue; }
  find "$out" -name '.DS_Store' -delete
  if [ "$v" = service-dev ]; then
    to_dev "$out" || { echo "$v: 시험 서버 주소로 바꾸기 실패 — 위 메시지를 볼 것" >&2; rm -rf "$out"; fail=1; continue; }
  fi
  echo "만듦: $out"
done

if [ $fail -eq 0 ]; then echo "합치기 끝"; else echo "합치기 실패 — 위 메시지를 볼 것" >&2; fi
exit $fail
