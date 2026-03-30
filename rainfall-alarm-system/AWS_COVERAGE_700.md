# AWS 700개+ 커버리지 확대 가이드

## 적용된 변경 사항

### Step 1: nph-aws2_stn 좌표 확인
- **디버그 엔드포인트**: `GET /api/debug/aws-stn-coords`
- 배포 후 호출하여 nph-aws2_stn이 제공하는 좌표 개수 확인 가능

### Step 2: aws-stations-fallback.json 확장
- **동기화 스크립트**: `npm run sync-aws-fallback`
- nph-aws2_min(731개) + nph-aws2_stn + 공공데이터 API를 병합하여 `data/aws-stations-fallback.json` 생성

### Step 3: 공공데이터 지점정보 API 보강
- **Worker 라우트 추가**: `/kma-basicinfo/*` → WethrBasicInfoService
- **스크립트**: sync-aws-fallback.js에서 getAwsObsvStnList 호출
- Worker 재배포 필요: `cd worker && wrangler deploy`

---

## 실행 순서

### 1. Worker 재배포 (kma-basicinfo 라우트 추가)
```bash
cd worker
wrangler deploy
```

### 2. AWS fallback 동기화
```bash
cd C:\Users\승주\Documents\GitHub\시우량\rainfall-alarm-system
npm run sync-aws-fallback
```

`.env` 필수:
- `KMA_APIHUB_KEY` - 기상청 API허브 인증키
- `KMA_API_KEY` - 공공데이터포털 인증키
- `CLOUDFLARE_WORKER_URL` - Worker URL
- `CLOUDFLARE_PROXY_TOKEN` - Worker 인증 토큰

### 3. 앱 배포
```bash
fly deploy --app rainfall-alarm-kr
```

### 4. (선택) APIHUB 실패 시 폴백 700개 사용
폴백 모드에서 700개 이상 처리하려면 Fly.io 시크릿 설정:
```bash
fly secrets set AWS_FALLBACK_MAX=731 --app rainfall-alarm-kr
```

⚠️ **주의**: AWS_FALLBACK_MAX=731 시 공공 API 호출이 하루 수만~20만 회까지 증가. 공공데이터 일일 한도(1,000~10,000) 초과 가능. APIHUB 정상 시에는 영향 없음.

---

## APIHUB typ02 권한 확인

`getAwsStnLstTbl`(방재기상관측지점일람표)은 **typ02** API이며, 별도 활용신청이 필요합니다.

### 확인 방법

1. [기상청 API허브](https://apihub.kma.go.kr) 로그인
2. **활용신청** 또는 **내 API** 메뉴 이동
3. **방재기상관측(AWS)** → **5.3 방재기상관측지점일람표조회 (getAwsStnLstTbl)** 구독 여부 확인

### API 경로

- `https://apihub.kma.go.kr/api/typ02/openApi/AwsYearlyInfoService/getAwsStnLstTbl`
- 파라미터: `pageNo`, `numOfRows`, `dataType`, `year`, `month`, `authKey`

### 403 오류 시

- typ02 API가 인증키에 포함되어 있지 않을 수 있음
- API허브에서 **방재기상관측(AWS)** 카테고리 활용신청 후 승인 대기

---

## 검증

1. **nph-aws2_stn**: `https://rainfall-alarm-kr.fly.dev/api/debug/aws-stn-coords`
2. **nph-aws2_min**: `https://rainfall-alarm-kr.fly.dev/api/debug/aws-parse` (이미 731개 확인됨)
3. **aws_rainfall**: 배포 후 `/api/status`에서 `aws_rainfall_1h`가 700개 근처로 증가하는지 확인
