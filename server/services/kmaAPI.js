import axios from 'axios';

const BASE_URL = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const APIHUB_BASE_URL = 'https://apihub.kma.go.kr/api/typ01/cgi-bin/url';

// env 변수를 호출 시점에 읽음 (ES module import 순서 문제 방지)
function getApiKey() { return process.env.KMA_API_KEY; }
function getApihubKey() { return process.env.KMA_APIHUB_KEY; }
function isMockMode() { return process.env.MOCK_MODE === 'true'; }
function getDailyLimit() { return parseInt(process.env.KMA_DAILY_LIMIT) || 10000; }

// 일일 API 호출량 추적
let apiCallCount = 0;
let apiCallDate = ''; // 'YYYY-MM-DD' 형식, 날짜 바뀌면 리셋

function getKSTDateKey() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function trackApiCall() {
  const today = getKSTDateKey();
  if (apiCallDate !== today) {
    apiCallCount = 0;
    apiCallDate = today;
  }
  apiCallCount++;
}

export function getApiUsage() {
  const today = getKSTDateKey();
  if (apiCallDate !== today) return { date: today, calls: 0, limit: getDailyLimit(), remaining: getDailyLimit() };
  const limit = getDailyLimit();
  return { date: apiCallDate, calls: apiCallCount, limit, remaining: Math.max(0, limit - apiCallCount) };
}

// 공공데이터포털 API 호출 헬퍼
export async function callKmaApi(operation, params, baseUrl = BASE_URL) {
  const limit = getDailyLimit();
  const today = getKSTDateKey();
  if (apiCallDate !== today) {
    apiCallCount = 0;
    apiCallDate = today;
  }

  if (apiCallCount >= limit) {
    console.error(`  [API] Daily limit reached (${apiCallCount}/${limit}). Skipping ${operation}`);
    throw new Error(`KMA API daily limit exceeded (${limit})`);
  }

  trackApiCall();

  if (apiCallCount % 100 === 0) {
    console.log(`  [API] Daily usage: ${apiCallCount}/${limit} (${((apiCallCount / limit) * 100).toFixed(1)}%)`);
  }

  const res = await axios.get(`${baseUrl}/${operation}`, {
    params: { serviceKey: getApiKey(), ...params },
    timeout: 15000,
  });
  return res.data;
}

// 위경도 → 기상청 격자좌표 변환
export function convertToGrid(lat, lon) {
  const RE = 6371.00877;
  const GRID = 5.0;
  const SLAT1 = 30.0;
  const SLAT2 = 60.0;
  const OLON = 126.0;
  const OLAT = 38.0;
  const XO = 43;
  const YO = 136;

  const DEGRAD = Math.PI / 180.0;
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  const nx = Math.floor(ra * Math.sin(theta) + XO + 0.5);
  const ny = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);

  return { nx, ny };
}

// 한국 시간(KST = UTC+9) 기준 날짜/시간 유틸
function getKSTNow() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst;
}

function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function formatTime(d) {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}${m}`;
}

// AWS 분단위 자료 조회 시각 (현재 KST에서 2분 여유)
function getAWSTm() {
  const kst = getKSTNow();
  let h = kst.getUTCHours();
  let m = kst.getUTCMinutes() - 2;
  if (m < 0) {
    m += 60;
    h -= 1;
    if (h < 0) {
      h = 23;
      kst.setUTCDate(kst.getUTCDate() - 1);
    }
  }
  return formatDate(kst) + String(h).padStart(2, '0') + String(m).padStart(2, '0');
}

// Mock 데이터 생성
function generateMockRealtime() {
  const rand = Math.random();
  if (rand < 0.7) return +(Math.random() * 5).toFixed(1);
  if (rand < 0.9) return +(10 + Math.random() * 15).toFixed(1);
  return +(20 + Math.random() * 15).toFixed(1);
}

function generateMockForecast() {
  return +(Math.random() * 40).toFixed(1);
}

// ─────────────────────────────────────────────────────────────
// AWS 전국 분단위 관측 (15분 강수량) - apihub.kma.go.kr
// ─────────────────────────────────────────────────────────────

// 전국 관측소 캐시: 폴링 사이클당 1회 API 호출
let awsGridCache = null; // { tm, grid: Map<stn_id, rn15> }

export function clearAWSGridCache() {
  awsGridCache = null;
}

// 응답 텍스트 파싱 → Map<stn_id(string), rn15(mm)>
// nph-aws2_min 응답 형식 (disp=1) — 실측 확인:
//   헤더: # YYMMDDHHMI STN WD1 WS1 ... RN-15m RN-60m ...  (공백 구분, STN=col1, RN-15m=col10)
//   단위: # KST ID deg m/s ... mm mm ...
//   데이터: 202602242115,108,...,0.0,...,=    (쉼표 구분, 끝에 = 마커)
//   전국 관측소: ~731개
function parseAWSGridText(text) {
  const grid = new Map();
  const lines = text.split('\n');

  // 실제 컬럼명: RN-15m (하이픈, 소문자 m) — 대소문자 무관 탐지
  const RN15_CANDIDATES = ['RN-15M', 'RN_15M', 'RN15M', 'R15M', 'RN15', 'R_15M'];
  let colStn = -1, colRn15 = -1;
  let matchedRn15Col = null;
  let headerLogged = false;
  let firstDataLogged = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '#START7777' || trimmed === '#7777END') continue;

    if (trimmed.startsWith('#')) {
      // 헤더는 항상 공백 구분
      const raw = trimmed.replace(/^#+\s*/, '').trim();
      const tokens = raw.split(/\s+/);

      tokens.forEach((t, i) => {
        const upper = t.toUpperCase();
        if (upper === 'STN' || upper === 'STN_ID') colStn = i;
        if (RN15_CANDIDATES.includes(upper)) { colRn15 = i; matchedRn15Col = t; }
      });

      if (!headerLogged && colStn >= 0) {
        console.log(`  [AWS parse] 컬럼 헤더: ${raw.slice(0, 120)}`);
        console.log(`  [AWS parse] STN col=${colStn}, RN15 col=${colRn15} (매칭: ${matchedRn15Col ?? '미탐지'})`);
        if (colRn15 < 0) {
          console.warn(`  [AWS parse] ⚠ 15분 강수량 컬럼 미탐지. 전체 컬럼: ${tokens.join(' ')}`);
        }
        headerLogged = true;
      }
      continue;
    }

    if (colStn < 0 || colRn15 < 0) continue;

    // 데이터 행: 쉼표 구분 (disp=1), 끝에 = 마커 포함 가능
    const parts = trimmed.split(',').map(t => t.trim()).filter(t => t !== '=');

    if (parts.length <= Math.max(colStn, colRn15)) continue;

    const stn = parts[colStn];
    const raw = parts[colRn15];
    if (!stn || raw === '' || raw === '-' || raw === 'null') continue;

    if (!firstDataLogged) {
      console.log(`  [AWS parse] 첫 데이터: STN=${stn}, ${matchedRn15Col}=${raw}`);
      firstDataLogged = true;
    }

    const rn15 = parseFloat(raw);
    grid.set(String(stn), isNaN(rn15) || rn15 < 0 ? 0 : +rn15.toFixed(1));
  }

  return grid;
}

// 전국 AWS 분단위 자료 fetch (폴링 사이클당 1회)
async function fetchAWSGrid() {
  const apihubKey = getApihubKey();
  if (!apihubKey) {
    console.warn('  [API] KMA_APIHUB_KEY 미설정 - AWS 실측 조회 불가');
    return null;
  }

  const tm = getAWSTm();

  // 캐시 히트
  if (awsGridCache && awsGridCache.tm === tm) {
    return awsGridCache.grid;
  }

  try {
    console.log(`  [API] nph-aws2_min: tm=${tm} (전국 AWS 15분 강수 fetch)`);
    const res = await axios.get(`${APIHUB_BASE_URL}/nph-aws2_min`, {
      params: { tm2: tm, stn: 0, disp: 1, help: 1, authKey: apihubKey },
      timeout: 30000,
      responseType: 'text',
    });

    const grid = parseAWSGridText(res.data);
    awsGridCache = { tm, grid };
    console.log(`  [API] AWS grid loaded: ${grid.size} stations`);
    return grid;
  } catch (err) {
    console.error('  [API] AWS fetch error:', err.message);
    return null;
  }
}

// AWS 15분 실측 강수량 조회 (stn_id로 캐시 조회)
export async function getAWSRealtime15min(stnId) {
  if (isMockMode()) {
    return generateMockRealtime();
  }

  const grid = await fetchAWSGrid();
  if (!grid) return 0;

  const val = grid.get(String(stnId));
  if (val === undefined) {
    console.warn(`  [API] AWS stn=${stnId} not found in grid`);
    return 0;
  }

  console.log(`  [API] AWS stn=${stnId} RN_15M=${val}mm`);
  return val;
}

// ─────────────────────────────────────────────────────────────
// 초단기 강수예측 (레이더 기반, 10분 갱신) - apihub.kma.go.kr
// ─────────────────────────────────────────────────────────────

// 전국 격자 캐시: 한 폴링 사이클에서 1회 API 호출로 전국 데이터 확보
let vsrtGridCache = null; // { tmfc, tmef, grid: Map<'nx,ny', {rn1, pty}> }

export function clearVsrtGridCache() {
  vsrtGridCache = null;
}

// VSRT 발표시각: 10분 간격, 10분 여유(API 반영 지연)
function getVsrtBaseTime() {
  const kst = getKSTNow();
  let h = kst.getUTCHours();
  let m = kst.getUTCMinutes() - 10; // 10분 여유
  if (m < 0) {
    m += 60;
    h -= 1;
    if (h < 0) {
      h = 23;
      kst.setUTCDate(kst.getUTCDate() - 1);
    }
  }
  m = Math.floor(m / 10) * 10; // 10분 단위로 내림
  return formatDate(kst) + String(h).padStart(2, '0') + String(m).padStart(2, '0');
}

// 발효시각: 향후 60분에 해당하는 다음 정시
function getVsrtEffectiveTime() {
  const kst = getKSTNow();
  const nextHour = new Date(kst.getTime() + 60 * 60 * 1000);
  return formatDate(nextHour) + String(nextHour.getUTCHours()).padStart(2, '0');
}

// 응답 텍스트 파싱 → Map<'nx,ny', {rn1, pty}>
// 기상청 apihub 텍스트 형식: 주석(#)을 제외한 행 = 공백 구분 컬럼
// 헤더 예시: # TM_FC TM_EF  NX   NY  RN1  PTY
// 데이터 예시: 202403011020 2024030111  79 133  2.5  1
function parseVsrtGridText(text) {
  const grid = new Map();
  const lines = text.split('\n');

  let colNx = -1, colNy = -1, colRn1 = -1, colPty = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      // 컬럼 헤더 감지
      const tokens = trimmed.replace(/^#+\s*/, '').trim().split(/\s+/);
      tokens.forEach((t, i) => {
        switch (t.toUpperCase()) {
          case 'NX': colNx = i; break;
          case 'NY': colNy = i; break;
          case 'RN1': colRn1 = i; break;
          case 'PTY': colPty = i; break;
        }
      });
      continue;
    }

    const parts = trimmed.split(/\s+/);

    let nx, ny, rn1, pty;
    if (colNx >= 0 && colNy >= 0 && colRn1 >= 0 && parts.length > colRn1) {
      // 헤더에서 컬럼 위치 파악된 경우
      nx  = parseInt(parts[colNx]);
      ny  = parseInt(parts[colNy]);
      rn1 = parseFloat(parts[colRn1]) || 0;
      pty = colPty >= 0 && parts.length > colPty ? parseInt(parts[colPty]) : -1;
    } else if (parts.length >= 5) {
      // 헤더 없이 기본 가정: TM_FC TM_EF NX NY RN1 [PTY]
      nx  = parseInt(parts[2]);
      ny  = parseInt(parts[3]);
      rn1 = parseFloat(parts[4]) || 0;
      pty = parts.length >= 6 ? parseInt(parts[5]) : -1;
    } else {
      continue;
    }

    if (isNaN(nx) || isNaN(ny)) continue;
    if (rn1 < 0) rn1 = 0; // 결측값(-999 등) 처리
    grid.set(`${nx},${ny}`, { rn1, pty });
  }

  return grid;
}

/**
 * 초단기 강수예측 (레이더 기반, 10분 갱신) - 향후 60분 시간당 강수량 조회
 * - apihub.kma.go.kr nph-dfs_vsrt_grd 사용
 * - 전국 격자를 1회 fetch 후 캐시하여 API 호출 최소화
 * - KMA_APIHUB_KEY 필수 (미설정 시 0 반환)
 */
export async function getVsrtForecastHourly(nx, ny) {
  if (isMockMode()) {
    return generateMockForecast();
  }

  const apihubKey = getApihubKey();
  if (!apihubKey) {
    console.warn(`  [API] KMA_APIHUB_KEY 미설정 - VSRT 예보 생략`);
    return 0;
  }

  const tmfc = getVsrtBaseTime();
  const tmef = getVsrtEffectiveTime();
  const gridKey = `${nx},${ny}`;

  // 캐시 히트: 같은 발표시각이면 전국 격자 재사용
  if (vsrtGridCache && vsrtGridCache.tmfc === tmfc && vsrtGridCache.tmef === tmef) {
    const val = vsrtGridCache.grid.get(gridKey);
    if (!val) return 0;
    if (val.pty === 0) return 0;
    return +val.rn1.toFixed(1);
  }

  // 전국 격자 fetch (폴링 사이클당 1회)
  try {
    console.log(`  [API] nph-dfs_vsrt_grd: tmfc=${tmfc}, tmef=${tmef} (전국 격자 fetch)`);

    const res = await axios.get(`${APIHUB_BASE_URL}/nph-dfs_vsrt_grd`, {
      params: { tmfc, tmef, vars: 'RN1:PTY', authKey: apihubKey },
      timeout: 30000,
      responseType: 'text',
    });

    const grid = parseVsrtGridText(res.data);
    vsrtGridCache = { tmfc, tmef, grid };

    console.log(`  [API] VSRT grid loaded: ${grid.size} points`);

    const val = grid.get(gridKey);
    if (!val) {
      console.warn(`  [API] VSRT (${nx},${ny}) not found in grid`);
      return 0;
    }
    if (val.pty === 0) {
      console.log(`  [API] VSRT PTY=0 → 강수없음 예보 (${nx},${ny})`);
      return 0;
    }
    console.log(`  [API] VSRT RN1=${val.rn1}mm for (${nx},${ny})`);
    return +val.rn1.toFixed(1);

  } catch (err) {
    console.error(`  [API] VSRT error:`, err.message);
    return 0;
  }
}

export default {
  convertToGrid,
  getAWSRealtime15min,
  getVsrtForecastHourly,
  clearVsrtGridCache,
  clearAWSGridCache,
};
