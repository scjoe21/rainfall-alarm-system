# 배포 가이드 (실측치 표시를 위한 필수 설정)

## ✅ Cloudflare 배포 (한국 PoP 사용)

**Railway, Fly.io**에는 한국 리전이 없어 기상청 API IP 제한으로 실패할 수 있습니다.  
**Cloudflare**는 한국(인천 등) PoP를 보유하여, 앱이 Cloudflare에서 실행될 때 **한국 IP**로 기상청 API 호출이 가능합니다.

### 구성

1. **앱 서버**: Cloudflare Pages / Workers 등에서 실행
2. **Worker 프록시** (`worker/`): 기상청 API를 한국 PoP 경유로 중계
3. **CLOUDFLARE_WORKER_URL**: 앱에서 KMA API 호출 시 이 Worker URL을 사용

---

## 1. Cloudflare Worker 배포 (필수)

```bash
cd worker
npm install -g wrangler
wrangler login
wrangler deploy
```

배포 후 출력되는 URL (예: `https://rainfall-alarm-proxy.xxx.workers.dev`)을 앱 환경 변수 `CLOUDFLARE_WORKER_URL`에 설정합니다.

```bash
# (선택) 프록시 토큰
wrangler secret put PROXY_TOKEN
```

---

## 2. 환경 변수 / 시크릿 설정

Cloudflare Pages 또는 Workers 배포 시:

```bash
# wrangler 사용 시
wrangler secret put KMA_API_KEY
wrangler secret put KMA_APIHUB_KEY
wrangler secret put CLOUDFLARE_WORKER_URL   # Worker 배포 URL
wrangler secret put CLOUDFLARE_PROXY_TOKEN  # Worker에 PROXY_TOKEN 설정 시
```

또는 대시보드에서 환경 변수 설정:
- `KMA_API_KEY`: [공공데이터포털](https://www.data.go.kr/) 인증키
- `KMA_APIHUB_KEY`: [기상청 API허브](https://apihub.kma.go.kr/) 인증키
- `CLOUDFLARE_WORKER_URL`: 위 1번에서 배포한 Worker URL
- `CLOUDFLARE_PROXY_TOKEN`: Worker의 PROXY_TOKEN과 동일 (인증 시)

---

## 3. 진단 API

배포 후 실측치가 안 보이면 다음 URL로 확인하세요:

```
https://your-app-url/api/status
```

- `config`: 키/Worker 설정 여부
- `data`: aws_rainfall, rainfall_realtime 등 DB 상태
- `apiTest`: `?test=1` 추가 시 공공 API 연결 테스트

---

## 4. 환경 변수 요약

| 변수 | 필수 | 설명 |
|------|------|------|
| KMA_API_KEY | ✅ | 공공데이터포털 인증키 |
| KMA_APIHUB_KEY | 권장 | API허브 인증키 (없으면 공공 API 폴백) |
| CLOUDFLARE_WORKER_URL | ✅ | Worker 프록시 URL (KMA API 중계) |
| CLOUDFLARE_PROXY_TOKEN | Worker 인증 시 | X-Proxy-Token 값 |
| MOCK_MODE | - | true 시 가짜 데이터 (개발용) |
| KMA_DAILY_LIMIT | - | 일일 API 호출 한도 (기본 50000) |
