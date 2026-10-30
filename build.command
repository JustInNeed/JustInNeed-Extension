#!/usr/bin/env bash
# 합치기 — Finder 에서 더블클릭. 기록 엔진(recorder-core/) + 버전 폴더 하나를 합쳐 build/<버전>/ 을 만든다.
# 크롬 "압축해제된 확장 프로그램 로드"에는 build/<버전>/ 을 고른다. build/ 는 git 밖(매번 새로 만든다).
# 같은 경로의 파일이 엔진과 버전 폴더 양쪽에 있으면 덮어쓰지 않고 멈춘다(어느 쪽이 맞는지 사람이 정할 일).
# 터미널에서: bash build.command            → 버전 폴더 전부
#             bash build.command data-collect → 하나만
cd "$(dirname "$0")" || exit 1
CORE=recorder-core
versions=("$@")
[ ${#versions[@]} -eq 0 ] && versions=(data-collect service)
fail=0

for v in "${versions[@]}"; do
  if [ ! -d "$v" ]; then
    [ $# -gt 0 ] && { echo "버전 폴더 없음: $v" >&2; fail=1; }   # 이름을 직접 줬을 때만 오류
    continue
  fi
  clash=$(cd "$v" && find . -type f ! -name '.DS_Store' | while IFS= read -r f; do
    [ -e "../$CORE/$f" ] && echo "  ${f#./}"
  done)
  if [ -n "$clash" ]; then
    echo "$v: 엔진과 같은 경로의 파일이 있어 멈춤:"$'\n'"$clash" >&2; fail=1; continue
  fi
  out="build/$v"
  rm -rf "$out" && mkdir -p "$out" || { echo "$out 을 만들 수 없음" >&2; fail=1; continue; }
  cp -R "$CORE/." "$out/" && cp -R "$v/." "$out/" || { echo "$v: 복사 실패" >&2; fail=1; continue; }
  find "$out" -name '.DS_Store' -delete
  echo "만듦: $out"
done

if [ $fail -eq 0 ]; then echo "합치기 끝"; else echo "합치기 실패 — 위 메시지를 볼 것" >&2; fi
exit $fail
