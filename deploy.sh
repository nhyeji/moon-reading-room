#!/usr/bin/env bash
# MOON's Reading Room — GitHub Pages 배포 스크립트
# 전제: ~/github 연결(@nhyeji)에서 저장소 쓰기 권한이 있는 저장소가 하나 이상 선택되어 있어야 합니다.
# 사용법: bash /workspace/moon-reading-room-pages/deploy.sh
set -u
OWNER="nhyeji"
REPO="moon-reading-room"
URL="https://${OWNER}.github.io/${REPO}/"
cd "$(dirname "$0")" || exit 1

echo "== 1. 저장소 확인: ${OWNER}/${REPO}"
if gh api "/repos/${OWNER}/${REPO}" >/dev/null 2>&1; then
  echo "   이미 있습니다."
else
  echo "   없음 → 생성 시도"
  if gh repo create "${REPO}" --public --description "MOON's Reading Room" 2>&1 | tee /tmp/mrr-create.log | grep -q .; then :; fi
  if ! gh api "/repos/${OWNER}/${REPO}" >/dev/null 2>&1; then
    echo "   ✗ 저장소를 만들 수 없습니다."
    cat /tmp/mrr-create.log
    cat <<'MSG'

   해결 방법 (사람이 해야 하는 부분):
   1) GitHub에서 공개 저장소를 직접 만듭니다: https://github.com/new
      - Owner: nhyeji · Repository name: moon-reading-room · Public · README 없이 Create
   2) Pickle 앱 → 설정 → 연결 → GitHub 에서 이 저장소(moon-reading-room)를
      선택(또는 'All repositories')으로 추가합니다.
      https://github.com/apps/pickle/installations/new
   3) 이 스크립트를 다시 실행합니다: bash /workspace/moon-reading-room-pages/deploy.sh
MSG
    exit 2
  fi
  echo "   생성됨."
fi

echo "== 2. 파일 올리기 (main)"
git remote remove origin 2>/dev/null
git remote add origin "https://github.com/${OWNER}/${REPO}.git"
if ! git push -u origin main 2>&1 | tail -3; then :; fi
if ! git ls-remote --heads origin main 2>/dev/null | grep -q main; then
  # 저장소에 이미 다른 커밋(README 등)이 있으면 합쳐서 다시 올린다
  git fetch origin 2>/dev/null && git rebase --autostash origin/main >/dev/null 2>&1 && git push -u origin main 2>&1 | tail -3
fi
if ! git ls-remote --heads origin main 2>/dev/null | grep -q main; then
  echo "   ✗ push 실패 — 위 오류를 확인하세요(저장소 접근 권한이 없는 경우가 대부분입니다)."
  echo "     → Pickle 설정 → 연결 → GitHub 에서 이 저장소가 선택되어 있는지 확인하세요."
  exit 3
fi
echo "   ✓ main 브랜치 push 완료"

echo "== 3. GitHub Pages 켜기 (main / root)"
gh api -X POST "/repos/${OWNER}/${REPO}/pages" \
  -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1 \
  || gh api -X PUT "/repos/${OWNER}/${REPO}/pages" \
       -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1 \
  || echo "   ! API로 켜지 못했습니다. GitHub 저장소 → Settings → Pages → Source: Deploy from a branch → main / (root) → Save"

echo "== 4. 주소 확인: ${URL}"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$URL")
  echo "   [$i] HTTP $code"
  [ "$code" = "200" ] && { echo "   ✓ 배포 완료: ${URL}"; exit 0; }
  sleep 10
done
echo "   ! 아직 200이 아닙니다. Pages 빌드가 진행 중일 수 있으니 1~2분 뒤 다시 확인하세요."
exit 4
