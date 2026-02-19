import { callKmaApi } from './kmaAPI.js';
import { getDatabase } from '../config/database.js';

const ALERT_BASE_URL = 'http://apis.data.go.kr/1360000/WthrWrnInfoService';

function isMockMode() { return process.env.MOCK_MODE === 'true'; }

// KMA 지역명 → DB metros.id 매핑
const REGION_TO_METRO_ID = {
  '서울특별시': 1, '서울': 1,
  '부산광역시': 2, '부산': 2,
  '대구광역시': 3, '대구': 3,
  '인천광역시': 4, '인천': 4,
  '광주광역시': 5, '광주': 5,
  '대전광역시': 6, '대전': 6,
  '울산광역시': 7, '울산': 7,
  '세종특별자치시': 8, '세종': 8,
  '경기도': 9, '경기도남부': 9, '경기도북부': 9, '경기남부': 9, '경기북부': 9,
  '강원특별자치도': 10, '강원도': 10, '강원도영서': 10, '강원도영동': 10,
  '강원영서': 10, '강원영동': 10, '강원': 10,
  '충청북도': 11, '충북': 11,
  '충청남도': 12, '충남': 12,
  '전북특별자치도': 13, '전라북도': 13, '전북': 13,
  '전라남도': 14, '전남': 14,
  '경상북도': 15, '경북': 15, '경북북부': 15, '경북남부': 15,
  '경상남도': 16, '경남': 16, '경남서부': 16, '경남동부': 16,
  '제주특별자치도': 17, '제주도': 17, '제주': 17,
};

// 상태 관리
let alertState = {
  level: 'IDLE',           // 'IDLE' | 'ACTIVE'
  affectedMetroIds: [],
  activeAlerts: [],        // 파싱된 특보 목록
  lastChecked: null,
  consecutiveErrors: 0,    // 연속 실패 횟수
  lastError: null,         // 마지막 에러 메시지
};

// KST 날짜 포맷 (yyyyMMdd)
function getKSTDateString() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// Mock 특보 데이터 (주의보/경보만)
function getMockAlerts() {
  const rand = Math.random();
  if (rand < 0.5) {
    return [];
  }
  const mockRegions = [
    ['서울특별시', '경기도남부'],
    ['부산광역시', '경상남도'],
    ['제주특별자치도'],
    ['강원도영동', '강원도영서'],
  ];
  const regions = mockRegions[Math.floor(Math.random() * mockRegions.length)];
  const levels = ['주의보', '경보'];
  const level = levels[Math.floor(Math.random() * levels.length)];
  return [{
    type: '호우',
    level,
    regions,
    raw: `호우${level} : ${regions.join(', ')}`,
  }];
}

// t2 필드 파싱: "호우주의보 : 서울특별시, 경기도남부"
// 주의보/경보만 처리 (예비특보 제외)
export function parseAlertTitle(t2) {
  if (!t2) return null;

  // 패턴: (호우)(주의보|경보) : 지역1, 지역2, ...
  const match = t2.match(/^(호우)(주의보|경보)\s*:\s*(.+)$/);
  if (!match) return null;

  const type = match[1];
  const level = match[2];
  const regions = match[3].split(',').map(r => r.trim()).filter(Boolean);

  return { type, level, regions, raw: t2 };
}

// 지역명 배열 → metro ID 배열
export function resolveRegionsToMetroIds(regions) {
  const metroIds = new Set();
  for (const region of regions) {
    const id = REGION_TO_METRO_ID[region];
    if (id) metroIds.add(id);
  }
  return [...metroIds];
}

// 특보목록(주의보/경보) API 호출, 호우 항목만 반환
// 반환: { alerts: [...], hasError: boolean }
export async function fetchWeatherAlerts() {
  if (isMockMode()) {
    const alerts = getMockAlerts();
    console.log(`  [Alert] MOCK mode: ${alerts.length} alert(s)`);
    return { alerts, hasError: false };
  }

  const today = getKSTDateString();
  const commonParams = {
    stnId: '108',
    fromTmFc: today,
    toTmFc: today,
    dataType: 'JSON',
    numOfRows: 100,
    pageNo: 1,
  };

  const results = [];

  // 특보목록 호출 (주의보/경보만 - 예비특보 API는 사용하지 않음)
  try {
    const wrnData = await callKmaApi('getWthrWrnList', commonParams, ALERT_BASE_URL);
    const wrnItems = wrnData?.response?.body?.items?.item || [];
    for (const item of (Array.isArray(wrnItems) ? wrnItems : [wrnItems])) {
      if (!item?.t2) continue;
      const lines = item.t2.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const parsed = parseAlertTitle(line); // 주의보/경보만 매칭
        if (parsed) results.push(parsed);
      }
    }
    console.log(`  [Alert] Found ${results.length} rain alert(s) (주의보/경보)`);
    return { alerts: results, hasError: false };
  } catch (err) {
    console.error('  [Alert] getWthrWrnList error:', err.message);
    return { alerts: [], hasError: true };
  }
}

// 상태 업데이트 (IDLE ↔ ACTIVE)
export async function updateAlertState() {
  const { alerts, hasError } = await fetchWeatherAlerts();
  const prevLevel = alertState.level;

  // API 모두 실패 시: 이전 상태 유지 (안전 측 판단)
  if (hasError) {
    alertState.consecutiveErrors++;
    alertState.lastError = new Date().toISOString();
    alertState.lastChecked = new Date().toISOString();
    console.warn(`  [Alert] Keeping previous state (${alertState.level}) due to API error. Consecutive errors: ${alertState.consecutiveErrors}`);
    return { changed: false, state: alertState, error: true };
  }

  // API 성공 시 에러 카운터 리셋
  alertState.consecutiveErrors = 0;
  alertState.lastError = null;

  if (alerts.length === 0) {
    alertState = {
      ...alertState,
      level: 'IDLE',
      affectedMetroIds: [],
      activeAlerts: [],
      lastChecked: new Date().toISOString(),
      consecutiveErrors: 0,
      lastError: null,
    };
  } else {
    const allMetroIds = new Set();
    for (const alert of alerts) {
      const ids = resolveRegionsToMetroIds(alert.regions);
      ids.forEach(id => allMetroIds.add(id));
    }

    alertState = {
      ...alertState,
      level: 'ACTIVE',
      affectedMetroIds: [...allMetroIds].sort((a, b) => a - b),
      activeAlerts: alerts,
      lastChecked: new Date().toISOString(),
      consecutiveErrors: 0,
      lastError: null,
    };
  }

  if (prevLevel !== alertState.level) {
    console.log(`  [Alert] State changed: ${prevLevel} -> ${alertState.level}`);
    if (alertState.level === 'ACTIVE') {
      console.log(`  [Alert] Affected metros: ${alertState.affectedMetroIds.join(', ')}`);
    }
  }

  return { changed: prevLevel !== alertState.level, state: alertState, error: false };
}

// ACTIVE 시 해당 metro의 관측소만 쿼리
export async function getStationsToPoll() {
  const db = await getDatabase();

  if (alertState.level === 'IDLE' || alertState.affectedMetroIds.length === 0) {
    return [];
  }

  const placeholders = alertState.affectedMetroIds.map(() => '?').join(',');
  const stations = db.prepare(`
    SELECT ws.*, e.code as emd_code, e.name as emd_name, e.district_id
    FROM weather_stations ws
    JOIN emds e ON ws.emd_id = e.id
    JOIN districts d ON e.district_id = d.id
    WHERE d.metro_id IN (${placeholders})
  `).all(...alertState.affectedMetroIds);

  console.log(`  [Alert] Polling ${stations.length} stations in ${alertState.affectedMetroIds.length} affected metro(s)`);
  return stations;
}

// 현재 상태 반환
export function getCurrentAlertState() {
  return { ...alertState };
}
