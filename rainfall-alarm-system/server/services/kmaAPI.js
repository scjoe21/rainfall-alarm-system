import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const APIHUB_BASE_URL = 'https://apihub.kma.go.kr/api/typ01/cgi-bin/url';

// env 변수를 호출 시점에 읽음 (ES module import 순서 문제 방지)
function getApiKey() { return process.env.KMA_API_KEY; }
function getApihubKey() { return process.env.KMA_APIHUB_KEY; }
function isMockMode() { return process.env.MOCK_MODE === 'true'; }
function getDailyLimit() { return parseInt(process.env.KMA_DAILY_LIMIT) || 50000; }

// Cloudflare Worker 프록시 (CLOUDFLARE_WORKER_URL=https://xxx.workers.dev)
// Worker가 서울 PoP(인천) 경유로 KMA API를 중계 → 한국 IP 요건 충족
function getWorkerUrl()   { return process.env.CLOUDFLARE_WORKER_URL; }
function getWorkerToken() { return process.env.CLOUDFLARE_PROXY_TOKEN; }

function getKmaPublicBaseUrl() {
  const w = getWorkerUrl();
  return w ? `${w}/kma-public` : BASE_URL;
}

function getKmaApihubBaseUrl() {
  const w = getWorkerUrl();
  return w ? `${w}/kma-apihub` : APIHUB_BASE_URL;
}

const AWS1MI_BASE_URL = 'https://apis.data.go.kr/1360000/Aws1miInfoService';
function getKmaAws1miBaseUrl() {
  const w = getWorkerUrl();
  return w ? `${w}/kma-aws1mi` : AWS1MI_BASE_URL;
}

function workerHeaders() {
  const token = getWorkerToken();
  return token ? { 'X-Proxy-Token': token } : {};
}

// 일일 API 호출량 추적
let apiCallCount = 0;
let apiCallDate = ''; // 'YYYY-MM-DD' 형식, 날짜 바뀌면 리셋

// 공공 API 쿼터 초과 회로 차단
// 429 수신 시 즉시 true → 이후 callKmaApi는 HTTP 없이 즉시 에러 반환
// → 자정(KST)에 일일 카운터 리셋 시 함께 해제
let publicApiQuotaExceeded = false;

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
// bypassLimit=true: 일일 한도 체크 없이 호출 (특보 조회 등 안전 임계 API 전용)
export async function callKmaApi(operation, params, baseUrl = BASE_URL, bypassLimit = false) {
  const limit = getDailyLimit();
  const today = getKSTDateKey();
  if (apiCallDate !== today) {
    apiCallCount = 0;
    apiCallDate = today;
    publicApiQuotaExceeded = false; // 자정 리셋 시 circuit breaker 해제
  }

  if (!bypassLimit) {
    // 회로 차단: 429 수신 이후 자정까지 공공 API 호출 차단
    if (publicApiQuotaExceeded) {
      throw new Error('KMA public API quota exceeded — circuit breaker active');
    }

    if (apiCallCount >= limit) {
      console.error(`  [API] Daily limit reached (${apiCallCount}/${limit}). Skipping ${operation}`);
      throw new Error(`KMA API daily limit exceeded (${limit})`);
    }

    trackApiCall();

    if (apiCallCount % 100 === 0) {
      console.log(`  [API] Daily usage: ${apiCallCount}/${limit} (${((apiCallCount / limit) * 100).toFixed(1)}%)`);
    }
  }

  const effectiveBaseUrl = (baseUrl === BASE_URL) ? getKmaPublicBaseUrl()
                         : (baseUrl === APIHUB_BASE_URL) ? getKmaApihubBaseUrl()
                         : baseUrl;
  const res = await axios.get(`${effectiveBaseUrl}/${operation}`, {
    params: { serviceKey: getApiKey(), ...params },
    timeout: 15000,
    headers: workerHeaders(),
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

// 초단기예보 발표시각 계산 (매시 30분 발표, API 제공은 ~45분 소요)
// base_time: 매시 30분. 현재 시각에서 가장 최근 발표시각 결정
function getUltraSrtBaseTime() {
  const kst = getKSTNow();
  let baseHour = kst.getUTCHours();
  let baseMin = kst.getUTCMinutes();

  // 초단기예보: 매시 30분 발표, API 제공 ~45분
  // 현재 분이 45분 미만이면 이전 시간의 30분 발표 사용
  if (baseMin < 45) {
    baseHour -= 1;
    if (baseHour < 0) {
      baseHour = 23;
      kst.setUTCDate(kst.getUTCDate() - 1);
    }
  }

  const baseDate = formatDate(kst);
  const baseTime = String(baseHour).padStart(2, '0') + '30';
  return { baseDate, baseTime };
}

// 초단기실황 발표시각 계산 (매시 정각 발표, ~40분 소요)
function getUltraSrtNcstBaseTime() {
  const kst = getKSTNow();
  let baseHour = kst.getUTCHours();
  let baseMin = kst.getUTCMinutes();

  // 초단기실황: 매시 정각 발표, API 제공 ~40분
  if (baseMin < 40) {
    baseHour -= 1;
    if (baseHour < 0) {
      baseHour = 23;
      kst.setUTCDate(kst.getUTCDate() - 1);
    }
  }

  const baseDate = formatDate(kst);
  const baseTime = String(baseHour).padStart(2, '0') + '00';
  return { baseDate, baseTime };
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

// 격자별 RN1 캐시 (한 배치 내 중복 API 호출 방지)
let ncstGridCache = null; // { baseKey, grid: Map<'nx,ny', rn1> }

export function clearNcstGridCache() {
  ncstGridCache = null;
}

/** 격자 좌표로 RN1(1시간 강수량) 조회 — 배치 내 캐시 사용 */
async function getRN1ForGrid(nx, ny) {
  if (isMockMode()) return generateMockRealtime();

  const { baseDate, baseTime } = getUltraSrtNcstBaseTime();
  const baseKey = `${baseDate}_${baseTime}`;

  if (ncstGridCache && ncstGridCache.baseKey === baseKey) {
    const cached = ncstGridCache.grid.get(`${nx},${ny}`);
    if (cached !== undefined) return cached;
  } else {
    ncstGridCache = { baseKey, grid: new Map() };
  }

  try {
    const data = await callKmaApi('getUltraSrtNcst', {
      numOfRows: 10,
      pageNo: 1,
      dataType: 'JSON',
      base_date: baseDate,
      base_time: baseTime,
      nx,
      ny,
    });

    const body = data?.response?.body;
    if (!body || !body.items) {
      ncstGridCache.grid.set(`${nx},${ny}`, 0);
      return 0;
    }

    const rawItems = body.items.item || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    // PTY: 강수형태 (0=없음, 1=비, 2=비/눈, 3=눈, 5=빗방울, 6=빗방울눈날림, 7=눈날림)
    // ※ PTY=0 필터 제거: 영동형 산지 강수 등 특보 없이 내리는 비는 격자 PTY가 0으로
    //   수신되더라도 RN1 값 자체는 올바르게 증가한다. delta 계산이 강수 중단을 자연스럽게
    //   처리하므로(RN1이 늘지 않으면 delta=0) PTY 필터는 불필요하다.
    //   RN1='강수없음' 문자열 처리로 실제 강수 없음 상태는 이미 걸러진다.
    const ptyItem = items.find(i => i.category === 'PTY');

    // RN1: 1시간 강수량 (mm)
    const rn1Item = items.find(i => i.category === 'RN1');
    if (!rn1Item) {
      ncstGridCache.grid.set(`${nx},${ny}`, 0);
      return 0;
    }

    const val = rn1Item.obsrValue;
    if (val === '강수없음' || val === null || val === undefined) {
      ncstGridCache.grid.set(`${nx},${ny}`, 0);
      return 0;
    }
    const rainfall = parseFloat(val) || 0;
    if (rainfall < 0) {
      ncstGridCache.grid.set(`${nx},${ny}`, 0);
      return 0;
    }
    if (rainfall > 0) {
      console.log(`  [API] RN1=${rainfall}mm (${nx},${ny})`);
    }
    const result = +rainfall.toFixed(1);
    ncstGridCache.grid.set(`${nx},${ny}`, result);
    return result;
  } catch (err) {
    if (err.response?.status === 429) {
      publicApiQuotaExceeded = true;
      console.error('  [API] 429 quota exceeded — circuit breaker 활성화 (자정까지 공공 API 차단)');
    }
    console.error(`  [API] Ultra short ncst error:`, err.message);
    return 0;
  }
}

// 초단기실황 조회 - 현재 1시간 슬라이딩 누적 강수량 (RN1) 반환
// getRN1ForGrid 사용 (격자별 캐시로 배치 최적화)
export async function getAWSRealtime15min(stnId, lat, lon) {
  if (isMockMode()) return generateMockRealtime();
  const { nx, ny } = convertToGrid(lat, lon);
  return getRN1ForGrid(nx, ny);
}

/** 디버그: 공공 API 초단기실황 원시 응답 (격자 nx,ny 기준) */
export async function getNcstDebug(lat = 36.48, lon = 127.259) {
  const { nx, ny } = convertToGrid(lat, lon);
  const { baseDate, baseTime } = getUltraSrtNcstBaseTime();
  const data = await callKmaApi('getUltraSrtNcst', {
    numOfRows: 10, pageNo: 1, dataType: 'JSON',
    base_date: baseDate, base_time: baseTime, nx, ny,
  });
  const items = data?.response?.body?.items?.item;
  const raw = Array.isArray(items) ? items : (items ? [items] : []);
  const rn1Item = raw.find(i => i.category === 'RN1');
  return {
    baseDate, baseTime, nx, ny, lat, lon,
    items: raw.map(i => ({ category: i.category, obsrValue: i.obsrValue })),
    rn1: rn1Item ? rn1Item.obsrValue : null,
  };
}

/** 디버그: APIHUB nph-aws2_min 원시 응답 + 파싱 결과 */
export async function fetchAwsDebug() {
  const apihubKey = getApihubKey();
  if (!apihubKey || apihubKey.startsWith('여기에')) return { error: 'KMA_APIHUB_KEY 미설정' };
  const tm = getAws1mBaseTime();
  try {
    const res = await axios.get(`${getKmaApihubBaseUrl()}/nph-aws2_min`, {
      params: { tm2: tm, stn: 0, help: 1, authKey: apihubKey },
      timeout: 30000,
      responseType: 'text',
      headers: workerHeaders(),
    });
    const parsed = parseAwsTextWithDebug(res.data);
    const headerLines = (res.data || '').split('\n').filter(l => l.startsWith('#')).slice(0, 5);
    return {
      tm,
      headerLines,
      parsed: parsed?.debug ?? null,
      sampleWithRain: parsed?.debug?.sampleRows?.filter(r => (r.rn15 || 0) > 0 || (r.rn60 || 0) > 0) ?? [],
    };
  } catch (e) {
    return { error: e.message };
  }
}

// 초단기예보 조회 - 45분 후까지의 예측 강수량 (RN1)
export async function getForecast45min(nx, ny) {
  if (isMockMode()) {
    return generateMockForecast();
  }

  try {
    const { baseDate, baseTime } = getUltraSrtBaseTime();

    console.log(`  [API] getUltraSrtFcst: base=${baseDate} ${baseTime}, nx=${nx}, ny=${ny}`);

    const data = await callKmaApi('getUltraSrtFcst', {
      numOfRows: 60,
      pageNo: 1,
      dataType: 'JSON',
      base_date: baseDate,
      base_time: baseTime,
      nx,
      ny,
    });

    const body = data?.response?.body;
    if (!body || !body.items) {
      console.error(`  [API] No data returned for fcst (${nx},${ny})`);
      console.error(`  [API] Response:`, JSON.stringify(data?.response?.header));
      return 0;
    }

    const rawItems = body.items.item || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    // RN1·PTY 카테고리 분리
    const rnItems = items.filter(i => i.category === 'RN1');
    const ptyItems = items.filter(i => i.category === 'PTY');

    if (rnItems.length === 0) {
      console.log(`  [API] No RN1 forecast items`);
      return 0;
    }

    // ※ PTY=0 필터 제거: 예보 PTY가 0이어도 RN1 예보값 자체를 그대로 사용한다.
    //   영동형 산지 강수 등 특보 미발효 상황에서도 RN1 예보값이 올바르게 제공된다.
    const firstRn1 = rnItems[0];
    const matchingPty = ptyItems.find(
      p => p.fcstDate === firstRn1.fcstDate && p.fcstTime === firstRn1.fcstTime
    );
    console.log(`  [API] Forecast PTY=${matchingPty?.fcstValue ?? 'N/A'} at ${firstRn1.fcstTime} for (${nx},${ny})`);

    // 초단기예보는 1시간 단위 6시간까지 제공
    // 45분 예측: 가장 가까운 1개 시간대의 RN1값 사용
    let total = 0;
    if (firstRn1) {
      const val = firstRn1.fcstValue;
      if (val !== '강수없음' && val !== null) {
        total = parseFloat(val) || 0;
      }
    }

    console.log(`  [API] Forecast RN1=${total}mm for (${nx},${ny})`);
    return +total.toFixed(1);
  } catch (err) {
    console.error(`  [API] Ultra short fcst error:`, err.message);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// 공공데이터 Aws1miInfoService — 1회 호출로 전국 AWS 15분/60분 강수량
// APIHUB 파싱 오류 회피, 관측소별 실측치 직접 제공
// ─────────────────────────────────────────────────────────────

/** 공공데이터 Aws1miInfoService getAws1miList — 1회 호출로 전국 관측소 강수량 */
export async function fetchAws1miFromPublicApi() {
  if (isMockMode()) return null;

  const apiKey = getApiKey();
  if (!apiKey || apiKey.startsWith('your_')) return null;

  const awsDt = getAws1mBaseTime();
  try {
    const url = `${getKmaAws1miBaseUrl()}/getAws1miList`;
    const res = await axios.get(url, {
      params: {
        serviceKey: apiKey,
        pageNo: 1,
        numOfRows: 1000,
        dataType: 'JSON',
        awsDt,
        awsId: 0,
      },
      timeout: 20000,
      headers: workerHeaders(),
    });

    const items = res.data?.response?.body?.items?.item;
    if (!items) return null;

    const raw = Array.isArray(items) ? items : [items];
    const stations = new Map();

    for (const row of raw) {
      const stnId = String(row.stnId ?? row.awsId ?? row.STN ?? '').trim();
      if (!stnId || !/^\d+$/.test(stnId)) continue;

      const rn15 = parseFloat(row.rn15 ?? row.rn_15m ?? row.RN15 ?? row.RN_15M ?? 0) || 0;
      const rn60 = parseFloat(row.rn60 ?? row.rn_60m ?? row.RN60 ?? row.RN_60M ?? 0) || 0;
      if (rn15 < 0 || rn60 < 0) continue;

      stations.set(stnId, {
        rn15: +(rn15.toFixed(1)),
        rn60: +(rn60.toFixed(1)),
        lat: null,
        lon: null,
        name: row.stnNm ?? row.stnName ?? `관측소${stnId}`,
      });
    }

    if (stations.size === 0) return null;
    console.log(`  [AWS] 공공 Aws1mi: ${stations.size}개, RN15>0 ${[...stations.values()].filter(s => s.rn15 > 0).length}개`);
    return stations;
  } catch (err) {
    console.warn('  [AWS] 공공 Aws1mi 오류:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// AWS 전국 10분 관측 캐시 - apihub.kma.go.kr/nph-aws2_min (폴백)
// ─────────────────────────────────────────────────────────────

let awsDataCache = null;  // { tm, stations: Map<stnId, {rn15, lat, lon}>, hasCoords }
let awsStnCoords = null;  // Map<stnId, {lat, lon}> — nph-aws2_stn에서 1회 로드, 서버 재시작 전까지 유지

export function clearAwsCache() {
  awsDataCache = null;
  // awsStnCoords는 클리어 안 함: 관측소 위치는 변하지 않으므로 재사용
}

/**
 * AWS 관측소 좌표 목록을 nph-aws2_stn에서 1회 로드
 * nph-aws2_min에는 LAT/LON이 없으므로 이 데이터로 최근접 매칭 보완
 * awsStnCoords !== null이면 재호출 시 즉시 반환 (빈 Map도 재시도 안 함)
 */
async function fetchAwsStnCoords() {
  if (awsStnCoords !== null) return;

  const apihubKey = getApihubKey();
  if (!apihubKey || apihubKey.startsWith('여기에')) return;

  try {
    console.log('  [AWS] nph-aws2_stn: 관측소 좌표 로드 중...');
    const res = await axios.get(`${getKmaApihubBaseUrl()}/nph-aws2_stn`, {
      params: { authKey: apihubKey, help: 0 },
      timeout: 30000,
      responseType: 'text',
      headers: workerHeaders(),
    });

    const stations = parseAwsText(res.data);
    if (!stations || stations.size === 0) {
      console.warn('  [AWS] nph-aws2_stn: 파싱 실패 또는 빈 응답');
      awsStnCoords = new Map();
      return;
    }

    const coords = new Map();
    for (const [stnId, data] of stations) {
      if (data.lat !== null && data.lon !== null) {
        coords.set(stnId, { lat: data.lat, lon: data.lon });
      }
    }
    awsStnCoords = coords;
    console.log(`  [AWS] nph-aws2_stn: ${coords.size}개 관측소 좌표 로드 완료`);
  } catch (err) {
    console.error('  [AWS] nph-aws2_stn 오류:', err.message);
    awsStnCoords = new Map(); // 재시도 방지
  }
}

// AWS 1분 자료 최신 관측시각 (매분 생산, 약 2분 지연) — nph-aws2_min용
function getAws1mBaseTime() {
  const kst = getKSTNow();
  let h = kst.getUTCHours();
  let m = kst.getUTCMinutes() - 2;
  if (m < 0) { m += 60; h = (h - 1 + 24) % 24; }
  return formatDate(kst) + String(h).padStart(2, '0') + String(m).padStart(2, '0');
}

// AWS 텍스트 파싱 (help=1 포함)
// 날씨누리 "강수15" = RN_15M 컬럼 (15분 강수량, mm)
// 컬럼명이 버전에 따라 다를 수 있으므로 패턴 매칭으로 자동 감지
function parseAwsText(text) {
  const result = parseAwsTextWithDebug(text);
  return result?.stations ?? null;
}

function parseAwsTextWithDebug(text) {
  const lines = text.split('\n');
  let colStn = -1, colRn15 = -1, colRn60 = -1, colLat = -1, colLon = -1, colName = -1;
  let headerLine = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) continue;

    const tokens = trimmed.replace(/^#+\s*/, '').trim().toUpperCase().split(/\s+/);

    // STN 컬럼이 있는 헤더 행 탐지
    const stnIdx = tokens.indexOf('STN');
    if (stnIdx < 0) continue;

    headerLine = trimmed;
    tokens.forEach((t, i) => {
      if (t === 'STN' || t === 'ID') colStn = i;
      else if (/^RN[-_]?15/.test(t) || /^R_?15M?$/.test(t) || t === '15M' || /^15M$/i.test(t)) colRn15 = i;
      else if (/^RN[-_]?60/.test(t) || /^R_?60M?$/.test(t) || t === '60M' || /^60M$/i.test(t) || t === 'RN1') colRn60 = i;
      else if (t === 'LAT') colLat = i;
      else if (t === 'LON' || t === 'LNG') colLon = i;
      else if (t === 'STN_NM' || t === 'STN_NAME' || t === 'NAME' || t === 'NM') colName = i;
    });

    if (colStn >= 0) break;
  }

  if (colStn < 0) return null;

  const stations = new Map();
  const sampleRows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    const rawStn = parts[colStn];
    if (!rawStn || !/^\d+$/.test(rawStn)) continue;

    const rn15Raw = colRn15 >= 0 ? parseFloat(parts[colRn15]) : NaN;
    const rn60Raw = colRn60 >= 0 ? parseFloat(parts[colRn60]) : NaN;
    const lat = colLat >= 0 ? parseFloat(parts[colLat]) : NaN;
    const lon = colLon >= 0 ? parseFloat(parts[colLon]) : NaN;
    const name = colName >= 0 && parts[colName] ? String(parts[colName]).trim() : null;

    const rn15 = (!isNaN(rn15Raw) && rn15Raw >= 0) ? +rn15Raw.toFixed(1) : null;
    const rn60 = (!isNaN(rn60Raw) && rn60Raw >= 0) ? +rn60Raw.toFixed(1) : null;
    stations.set(rawStn, { rn15, rn60, lat: isNaN(lat) ? null : lat, lon: isNaN(lon) ? null : lon, name: name || `관측소${rawStn}` });

    if (sampleRows.length < 5 || (rn15 > 0 || rn60 > 0)) {
      sampleRows.push({ stn: rawStn, name: name || rawStn, rn15, rn60, rawRn15: colRn15 >= 0 ? parts[colRn15] : 'N/A', rawRn60: colRn60 >= 0 ? parts[colRn60] : 'N/A' });
    }
  }

  return {
    stations,
    debug: {
      headerLine,
      colIndices: { colStn, colRn15, colRn60, colLat, colLon, colName },
      sampleRows: sampleRows.slice(0, 10),
      totalStations: stations.size,
      rn15NonZero: [...stations.values()].filter(s => s.rn15 > 0).length,
      rn60NonZero: [...stations.values()].filter(s => s.rn60 > 0).length,
    },
  };
}

/**
 * AWS 전국 10분 관측 자료를 1회 fetch하여 캐시
 * VSRT와 동일한 전국 캐시 패턴 (폴링 사이클당 1회 API 호출)
 * KMA_APIHUB_KEY 미설정 시 건너뜀
 */
export async function fetchAllAwsData() {
  if (isMockMode()) return;

  const apihubKey = getApihubKey();
  if (!apihubKey || apihubKey.startsWith('여기에')) return;

  const tm = getAws1mBaseTime();
  if (awsDataCache && awsDataCache.tm === tm) return; // 이미 최신

  // 최대 2회 시도 (타임아웃·네트워크 오류 대비)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`  [AWS] nph-aws2_min: tm=${tm} (전국 fetch, 시도 ${attempt}/2)`);

      const res = await axios.get(`${getKmaApihubBaseUrl()}/nph-aws2_min`, {
        params: { tm2: tm, stn: 0, help: 1, disp: 0, authKey: apihubKey },
        timeout: 60000,
        responseType: 'text',
        headers: workerHeaders(),
      });

      const parsed = parseAwsTextWithDebug(res.data);
      const stations = parsed?.stations ?? null;
      if (!stations || stations.size === 0) {
        const rawLines = (res.data || '').split('\n').slice(0, 15).join('\n');
        console.warn('  [AWS] 파싱 실패 또는 빈 응답. raw 헤더:', rawLines.substring(0, 500));
        if (attempt < 2) { await new Promise(r => setTimeout(r, 5000)); continue; }
        return;
      }

      const rn15Count = [...stations.values()].filter(s => s.rn15 !== null && s.rn15 > 0).length;
      const rn60Count = [...stations.values()].filter(s => s.rn60 !== null && s.rn60 > 0).length;
      const hasCoords = [...stations.values()].some(s => s.lat !== null);
      awsDataCache = { tm, stations, hasCoords };
      console.log(`  [AWS] 로드 완료: ${stations.size}개, RN15>0 ${rn15Count}개, RN60>0 ${rn60Count}개, 좌표 ${hasCoords ? '있음' : '없음'}`);
      if (parsed.debug && (rn15Count === 0 && rn60Count === 0)) {
        console.log('  [AWS-DEBUG] 전 관측소 0mm. 헤더:', parsed.debug.headerLine?.substring(0, 200));
        console.log('  [AWS-DEBUG] 컬럼인덱스:', JSON.stringify(parsed.debug.colIndices));
        console.log('  [AWS-DEBUG] 샘플:', JSON.stringify(parsed.debug.sampleRows?.slice(0, 5)));
      }

      // nph-aws2_min에 좌표 없으면 nph-aws2_stn으로 보완 (1회만 fetch)
      if (!hasCoords) await fetchAwsStnCoords();
      return; // 성공

    } catch (err) {
      console.error(`  [AWS] fetch 오류 (${attempt}/2):`, err.message);
      if (attempt < 2) {
        console.log('  [AWS] 10초 후 재시도...');
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }
}

/** typ02 getAwsStnLstTbl 디버그: 활용신청 완료 여부 확인 */
export async function fetchTyp02AwsStnLstTblDebug() {
  const apihubKey = getApihubKey();
  if (!apihubKey || apihubKey.startsWith('여기에')) {
    return { ok: false, error: 'KMA_APIHUB_KEY 미설정' };
  }
  const w = getWorkerUrl();
  const typ02Base = w ? `${w}/kma-apihub-typ02` : 'https://apihub.kma.go.kr/api/typ02/openApi/AwsYearlyInfoService';
  const url = `${typ02Base}/getAwsStnLstTbl?pageNo=1&numOfRows=1000&dataType=JSON&year=2024&month=03&authKey=${encodeURIComponent(apihubKey)}`;
  try {
    const res = await axios.get(url, { timeout: 15000, headers: workerHeaders() });
    const items = res.data?.response?.body?.items?.item;
    const count = Array.isArray(items) ? items.length : (items ? 1 : 0);
    return { ok: true, count, sample: Array.isArray(items) ? items.slice(0, 2) : (items ? [items] : []) };
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message ?? e.message;
    return { ok: false, error: msg, status: status ?? 'network_error' };
  }
}

/** nph-aws2_stn 디버그: 좌표 제공 개수 확인 (캐시 무시, 신규 fetch) */
export async function fetchAwsStnCoordsDebug() {
  const apihubKey = getApihubKey();
  if (!apihubKey || apihubKey.startsWith('여기에')) {
    return { error: 'KMA_APIHUB_KEY 미설정' };
  }
  try {
    const res = await axios.get(`${getKmaApihubBaseUrl()}/nph-aws2_stn`, {
      params: { authKey: apihubKey, help: 1 },
      timeout: 30000,
      responseType: 'text',
      headers: workerHeaders(),
    });
    const parsed = parseAwsTextWithDebug(res.data);
    if (!parsed?.stations) {
      return { error: '파싱 실패', rawLines: (res.data || '').split('\n').slice(0, 20) };
    }
    const { stations } = parsed;
    const withCoords = [...stations.values()].filter(s => s.lat != null && s.lon != null);
    return {
      totalStations: stations.size,
      withCoords: withCoords.length,
      colIndices: parsed.debug?.colIndices ?? null,
      headerLine: parsed.debug?.headerLine ?? null,
      sampleWithCoords: withCoords.slice(0, 5).map(s => ({ stn: s.name || '?', lat: s.lat, lon: s.lon })),
    };
  } catch (e) {
    return { error: e.message };
  }
}

/** AWS 캐시 성공 여부 (processStations 폴백 결정에 사용) */
export function isAwsCacheAvailable() {
  return awsDataCache !== null && awsDataCache.stations != null && awsDataCache.stations.size > 0;
}

/** AWS 관측소 목록 (캐시 성공 시): { stn_id, name, lat, lon, rn15, rn60 }[] */
export function getAwsStationsWithRainfall() {
  if (!awsDataCache || !awsDataCache.stations) return [];
  const { stations } = awsDataCache;
  const fallback = getAwsStationsForFallback();
  const fallbackMap = new Map(fallback.map(s => [String(s.stn_id), s]));

  const list = [];
  for (const [stnId, entry] of stations) {
    let lat = entry.lat, lon = entry.lon, name = entry.name || `관측소${stnId}`;
    if ((lat === null || lon === null) && awsStnCoords) {
      const c = awsStnCoords.get(stnId);
      if (c) { lat = c.lat; lon = c.lon; }
    }
    if ((lat === null || lon === null) && fallbackMap.has(stnId)) {
      const fb = fallbackMap.get(stnId);
      lat = fb.lat; lon = fb.lon; name = fb.name || name;
    }
    if (lat === null || lon === null) continue;
    list.push({
      stn_id: stnId,
      name,
      lat, lon,
      rn15: entry.rn15,
      rn60: entry.rn60,
    });
  }
  return list;
}

let awsStationsFallback = null;

/** AWS 관측소 폴백 목록 (APIHUB 실패 시): data/aws-stations-fallback.json */
export function getAwsStationsForFallback() {
  if (awsStationsFallback) return awsStationsFallback;
  try {
    const p = path.join(__dirname, '..', '..', 'data', 'aws-stations-fallback.json');
    if (fs.existsSync(p)) {
      awsStationsFallback = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return awsStationsFallback;
    }
  } catch (e) {
    console.warn('  [AWS] aws-stations-fallback.json 로드 실패:', e.message);
  }
  awsStationsFallback = [];
  return awsStationsFallback;
}

/**
 * AWS 캐시에서 해당 관측소의 15분 강수량 반환
 * - 실제 AWS 지점번호(숫자)이면 직접 매핑
 * - 가상 관측소이거나 매핑 실패 시 위경도 기준 최근접 AWS 지점 사용
 * - 데이터 없으면 null 반환 (→ 호출부에서 fallback 처리)
 */
export function getAwsRn15FromCache(stnId, lat, lon) {
  if (!awsDataCache || !awsDataCache.stations) return null;
  const { stations, hasCoords } = awsDataCache;

  // 실제 AWS 지점번호 직접 조회
  const stnStr = String(stnId).replace(/\D/g, ''); // 숫자만 추출
  if (stnStr) {
    const entry = stations.get(stnStr);
    if (entry && entry.rn15 !== null) return entry.rn15;
  }

  // 위경도 기반 최근접 관측소 검색
  // hasCoords=true이면 stations 안에 LAT/LON 포함, false이면 awsStnCoords로 보완
  const canNearest = hasCoords || (awsStnCoords && awsStnCoords.size > 0);
  if (canNearest && !isNaN(lat) && !isNaN(lon)) {
    let minDist = Infinity;
    let nearestRn15 = null;

    for (const [id, entry] of stations) {
      if (entry.rn15 === null) continue;

      let entryLat = entry.lat;
      let entryLon = entry.lon;

      // nph-aws2_min에 좌표 없으면 awsStnCoords에서 보완
      if ((entryLat === null || entryLon === null) && awsStnCoords) {
        const stnCoord = awsStnCoords.get(id);
        if (stnCoord) { entryLat = stnCoord.lat; entryLon = stnCoord.lon; }
      }

      if (entryLat === null || entryLon === null) continue;
      const d = (entryLat - lat) ** 2 + (entryLon - lon) ** 2;
      if (d < minDist) { minDist = d; nearestRn15 = entry.rn15; }
    }

    // 약 50km(위경도 ~0.45도) 이내만 유효
    if (nearestRn15 !== null && minDist < 0.2) return nearestRn15;
  }

  return null;
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
 * - KMA_APIHUB_KEY 미설정 시 기존 getUltraSrtFcst(30분 갱신)로 폴백
 */
export async function getVsrtForecastHourly(nx, ny) {
  if (isMockMode()) {
    return generateMockForecast();
  }

  const apihubKey = getApihubKey();
  if (!apihubKey || apihubKey.startsWith('여기에')) {
    return getForecast45min(nx, ny);
  }

  const tmfc = getVsrtBaseTime();
  const tmef = getVsrtEffectiveTime();
  const gridKey = `${nx},${ny}`;

  // 캐시 히트: 같은 발표시각이면 전국 격자 재사용
  if (vsrtGridCache && vsrtGridCache.tmfc === tmfc && vsrtGridCache.tmef === tmef) {
    const val = vsrtGridCache.grid.get(gridKey);
    if (!val) {
      console.warn(`  [API] VSRT cache miss (${nx},${ny}) → fallback to getUltraSrtFcst`);
      return getForecast45min(nx, ny);
    }
    // PTY=0 필터 제거: PTY 무관하게 RN1 예보값을 그대로 반환
    return +val.rn1.toFixed(1);
  }

  // 전국 격자 fetch (폴링 사이클당 1회)
  try {
    console.log(`  [API] nph-dfs_vsrt_grd: tmfc=${tmfc}, tmef=${tmef} (전국 격자 fetch)`);

    const res = await axios.get(`${getKmaApihubBaseUrl()}/nph-dfs_vsrt_grd`, {
      params: { tmfc, tmef, vars: 'RN1:PTY', authKey: apihubKey },
      timeout: 30000,
      responseType: 'text',
      headers: workerHeaders(),
    });

    const grid = parseVsrtGridText(res.data);
    // 빈 grid(파싱 실패/API 형식 변경) 시 캐시하지 않고 공공 API 폴백
    if (grid.size === 0) {
      console.warn(`  [API] VSRT grid empty (parse failed) → fallback to getUltraSrtFcst`);
      return getForecast45min(nx, ny);
    }
    vsrtGridCache = { tmfc, tmef, grid };

    console.log(`  [API] VSRT grid loaded: ${grid.size} points`);

    const val = grid.get(gridKey);
    if (!val) {
      console.warn(`  [API] VSRT (${nx},${ny}) not found in grid → fallback to getUltraSrtFcst`);
      return getForecast45min(nx, ny);
    }
    // PTY=0 필터 제거: PTY 무관하게 RN1 예보값을 그대로 반환
    console.log(`  [API] VSRT PTY=${val.pty}, RN1=${val.rn1}mm for (${nx},${ny})`);
    return +val.rn1.toFixed(1);

  } catch (err) {
    console.error(`  [API] VSRT error:`, err.message, '→ fallback to getUltraSrtFcst');
    return getForecast45min(nx, ny);
  }
}

export default {
  convertToGrid,
  getAWSRealtime15min,
  getForecast45min,
  getVsrtForecastHourly,
  clearVsrtGridCache,
  fetchAllAwsData,
  clearAwsCache,
  getAwsRn15FromCache,
};
