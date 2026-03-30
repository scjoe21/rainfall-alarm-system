@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo === 1. AWS fallback 동기화 (typ02 700+ 확대) ===
call npm run sync-aws-fallback
if errorlevel 1 (
  echo [오류] sync 실패. .env에 KMA_APIHUB_KEY, CLOUDFLARE_WORKER_URL 확인
  pause
  exit /b 1
)

echo.
echo === 2. Fly.io 배포 ===
call fly deploy --app rainfall-alarm-kr
if errorlevel 1 (
  echo [오류] 배포 실패
  pause
  exit /b 1
)

echo.
echo === 완료 ===
echo https://rainfall-alarm-kr.fly.dev/api/status 에서 aws_rainfall_1h 확인
pause
