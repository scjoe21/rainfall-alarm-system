import axios from 'axios';

const BASE_URL = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';

// env 변수를 호출 시점에 읽음 (ES module import 순서 문제 방지)
function getApiKey() { return process.env.KMA_API_KEY; }
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

// 초단기실황 조회 - 현재 1시간 강수량 (RN1)
// 이걸 15분 기준으로 환산: RN1 / 4 * 1 (15분 비율)
// 또는 단순히 RN1 값 자체를 15분 대리값으로 사용
export async function getAWSRealtime15min(stnId, lat, lon) {
  if (isMockMode()) {
    return generateMockRealtime();
  }

  try {
    const { nx, ny } = convertToGrid(lat, lon);
    const { baseDate, baseTime } = getUltraSrtNcstBaseTime();

    console.log(`  [API] getUltraSrtNcst: base=${baseDate} ${baseTime}, nx=${nx}, ny=${ny}`);

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
      console.error(`  [API] No data returned for ncst (${nx},${ny})`);
      console.error(`  [API] Response:`, JSON.stringify(data?.response?.header));
      return 0;
    }

    const rawItems = body.items.item || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    // PTY: 강수형태 (0=없음, 1=비, 2=비/눈, 3=눈, 5=빗방울, 6=빗방울눈날림, 7=눈날림)
    // 관측 시점에 PTY=0이면 현재 강수 없음 → RN1에 이전 시간 잔류값이 있어도 0 반환
    // 이 처리가 없으면 비가 그친 후에도 RN1 누적값으로 인해 허위 알람이 발생함
    const ptyItem = items.find(i => i.category === 'PTY');
    if (!ptyItem || ptyItem.obsrValue === '0') {
      console.log(`  [API] PTY=${ptyItem?.obsrValue ?? 'N/A'} → 강수없음, RN1 무시 (${nx},${ny})`);
      return 0;
    }

    // RN1: 1시간 강수량 (mm)
    const rn1Item = items.find(i => i.category === 'RN1');
    if (!rn1Item) {
      console.log(`  [API] No RN1 category in response`);
      return 0;
    }

    // "강수없음", 결측값(-999 등), 또는 숫자값
    const val = rn1Item.obsrValue;
    if (val === '강수없음' || val === null || val === undefined) return 0;
    const rainfall = parseFloat(val) || 0;
    if (rainfall < 0) return 0; // 결측값 (-999, -998.9 등) 필터

    console.log(`  [API] PTY=${ptyItem.obsrValue}, RN1=${rainfall}mm for (${nx},${ny})`);
    return +rainfall.toFixed(1);
  } catch (err) {
    console.error(`  [API] Ultra short ncst error:`, err.message);
    return 0;
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

    // 가장 가까운 예보시간의 PTY 확인
    // PTY=0이면 해당 시간대에 강수 없음 → RN1 잔류값이 있어도 0 반환
    // (관측 PTY와 동일한 원칙: 현재 강수 없으면 누적값 무시)
    const firstRn1 = rnItems[0];
    const matchingPty = ptyItems.find(
      p => p.fcstDate === firstRn1.fcstDate && p.fcstTime === firstRn1.fcstTime
    );
    if (matchingPty && matchingPty.fcstValue === '0') {
      console.log(`  [API] Forecast PTY=0 at ${firstRn1.fcstTime} → 강수없음 예보, RN1 무시 (${nx},${ny})`);
      return 0;
    }

    // 초단기예보는 1시간 단위 6시간까지 제공
    // 45분 예측: 가장 가까운 1개 시간대의 RN1값 사용
    let total = 0;
    if (firstRn1) {
      const val = firstRn1.fcstValue;
      if (val !== '강수없음' && val !== null) {
        total = parseFloat(val) || 0;
      }
    }

    console.log(`  [API] Forecast PTY=${matchingPty?.fcstValue ?? 'N/A'}, RN1=${total}mm for (${nx},${ny})`);
    return +total.toFixed(1);
  } catch (err) {
    console.error(`  [API] Ultra short fcst error:`, err.message);
    return 0;
  }
}

export default {
  convertToGrid,
  getAWSRealtime15min,
  getForecast45min,
};
