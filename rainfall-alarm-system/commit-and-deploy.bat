@echo off
chcp 65001 >nul
set APP_DIR=%~dp0
set REPO_ROOT=%APP_DIR%..

cd /d "%REPO_ROOT%"
echo === Git: 저장소 루트 %CD% ===
git add -A
git status
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "fix(sejong): 세종 신도심 14개 읍면동 관측소 재매핑 세종(360)→세종고운(494) + DB 자동 마이그레이션"
  if errorlevel 1 (
    echo [오류] 커밋 실패
    pause
    exit /b 1
  )
  echo === 커밋 완료 ===
) else (
  echo === 커밋할 변경 없음 - 배포만 진행 ===
)

cd /d "%APP_DIR%"
echo === Fly.io 배포 rainfall-alarm-kr ===
fly deploy --config fly.toml --app rainfall-alarm-kr
if %errorlevel% neq 0 (
  echo [오류] 배포 실패. fly auth login 확인
  pause
  exit /b 1
)
echo.
echo 배포 완료: https://rainfall-alarm-kr.fly.dev
pause
