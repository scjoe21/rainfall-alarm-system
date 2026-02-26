import { callKmaApi } from './kmaAPI.js';
import { getDatabase } from '../config/database.js';

const ALERT_BASE_URL = 'https://apis.data.go.kr/1360000/WthrWrnInfoService';

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
    // stnId 미지정 → 전국 모든 지방청 발표 특보 조회
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
    const itemArray = Array.isArray(wrnItems) ? wrnItems : [wrnItems];

    // 지방기상청(stnId)별로 그룹핑하여 각 기관의 가장 최신 공문만 파싱한다.
    //
    // [이전 버그1] 전체 공문을 모두 누적하면, 해제 공문 이전의 발효 공문까지
    //   포함되어 이미 해제된 지역을 여전히 특보 중으로 잘못 인식했음.
    //
    // [이전 버그2] 전역 최신 1건만 파싱하면, KMA 지방청(서울·부산·대구 등)이
    //   각자 독립 공문을 발표하므로 다른 기관의 유효한 특보가 누락됨.
    //   (예: 부산청이 오전에 호우주의보 발효 → 서울청이 오후에 해제 공문 발행
    //        → 전역 최신이 서울 해제 공문이 되어 부산 특보를 놓침)
    //
    // [현재 방식] stnId 기준으로 그룹핑 후 각 기관의 최신 공문만 채택,
    //   전 기관 결과를 합산하여 현재 유효한 특보 목록을 정확히 산출한다.
    const latestByStn = {};
    for (const item of itemArray) {
      const stnKey = String(item.stnId ?? item.stn_id ?? 'national');
      const currTime = parseInt(item.tmFc || '0', 10);
      const prevTime = parseInt(latestByStn[stnKey]?.tmFc || '0', 10);
      if (currTime > prevTime) {
        latestByStn[stnKey] = item;
      }
    }

    const latestBulletins = Object.values(latestByStn);

    if (latestBulletins.length === 0) {
      console.log(`  [Alert] No bulletin for today`);
    } else {
      for (const bulletin of latestBulletins) {
        if (!bulletin?.t2) continue;
        const lines = bulletin.t2.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          const parsed = parseAlertTitle(line); // 주의보/경보만 매칭
          if (parsed) results.push(parsed);
        }
      }
      console.log(`  [Alert] ${latestBulletins.length} regional bulletin(s) processed, found ${results.length} rain alert(s)`);
    }
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

// ─── 2단계 폴링용 관측소 쿼리 함수 ────────────────────────────────────────

const ALL_STATIONS_SQL = `
  SELECT ws.*, e.code as emd_code, e.name as emd_name, e.district_id, d.metro_id
  FROM weather_stations ws
  JOIN emds e ON ws.emd_id = e.id
  JOIN districts d ON e.district_id = d.id
`;

/**
 * [Fast poll - 5분] 호우주의보/경보 발효 광역자치단체의 관측소
 * ACTIVE 상태일 때만 반환. IDLE이면 빈 배열.
 */
export async function getStationsForFastPoll() {
  const db = await getDatabase();

  if (alertState.level === 'IDLE' || alertState.affectedMetroIds.length === 0) {
    return [];
  }

  const placeholders = alertState.affectedMetroIds.map(() => '?').join(',');
  const stations = db.prepare(
    `${ALL_STATIONS_SQL} WHERE d.metro_id IN (${placeholders})`
  ).all(...alertState.affectedMetroIds);

  console.log(`  [Fast] ${stations.length}개 관측소 (특보 발효 ${alertState.affectedMetroIds.length}개 광역)`);
  return stations;
}

/**
 * [Slow poll - 30분] 호우주의보/경보 미발효 광역자치단체의 관측소
 * - IDLE: 전체 관측소 (전국 배경 모니터링)
 * - ACTIVE: 특보 미발효 광역자치단체만 (발효 지역은 fast poll이 담당)
 * - 특보 API 오류 시: 전체 관측소 (폴백)
 */
export async function getStationsForSlowPoll() {
  const db = await getDatabase();

  if (alertState.consecutiveErrors > 0) {
    const stations = db.prepare(ALL_STATIONS_SQL).all();
    console.log(`  [Slow] ${stations.length}개 관측소 (특보 API 오류 - 전체 폴백)`);
    return stations;
  }

  if (alertState.level === 'IDLE' || alertState.affectedMetroIds.length === 0) {
    const stations = db.prepare(ALL_STATIONS_SQL).all();
    console.log(`  [Slow] ${stations.length}개 관측소 (IDLE - 전국 배경 모니터링)`);
    return stations;
  }

  // ACTIVE: 특보 미발효 광역만 slow poll
  const placeholders = alertState.affectedMetroIds.map(() => '?').join(',');
  const stations = db.prepare(
    `${ALL_STATIONS_SQL} WHERE d.metro_id NOT IN (${placeholders})`
  ).all(...alertState.affectedMetroIds);

  console.log(`  [Slow] ${stations.length}개 관측소 (특보 미발효 광역, ACTIVE)`);
  return stations;
}

// 하위 호환성 유지 (기존 호출부 대응)
export async function getStationsToPoll() {
  return getStationsForFastPoll();
}

// 현재 상태 반환
export function getCurrentAlertState() {
  return { ...alertState };
}
