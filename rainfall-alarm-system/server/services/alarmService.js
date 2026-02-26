import { getDatabase } from '../config/database.js';
import kma from './kmaAPI.js';

const REALTIME_THRESHOLD = 20.0;
const FORECAST_THRESHOLD = 55.0;

// 격자좌표별 예보 캐시 (동일 실행 사이클 내에서만 유효)
let forecastCache = {};

export function clearForecastCache() {
  forecastCache = {};
}

// ─── 격자별 이전 RN1 인메모리 스토어 ─────────────────────────────────────────
// 키: `${nx},${ny}` (격자좌표)
// 값: 직전 폴링 사이클에서 취득한 초단기실황 RN1 (1시간 슬라이딩 누적값)
// 서버 재시작 시 초기화됨 → 첫 사이클은 delta=0 (보수적 동작)
// updateGridRN1() 은 scheduler 에서 그리드 배치가 끝난 뒤 호출
const prevRN1ByGrid = {};

export function updateGridRN1(gridKey, rn1) {
  prevRN1ByGrid[gridKey] = rn1;
}

/**
 * 알람 조건 체크
 *
 * [실시간 15분 강수량 취득 우선순위]
 *  1순위: APIHUB AWS 캐시 → getAwsRn15FromCache()
 *         기상청 날씨누리 "강수15"와 동일한 AWS 관측 실측값 (직접 계측, 가장 정확)
 *  2순위: 초단기실황 RN1 격자 차분 (getAWSRealtime15min 반환 원시 RN1)
 *         RN1_현재 − RN1_이전폴링 ≈ 15분 강수량 근사치
 *         preloaded/prevRN1ByGrid 인메모리 스토어 사용, DB 조회 없음
 *
 * [DB 저장 정책]
 *  - rainfall_realtime.rainfall_15min: 실제 15분 강수량(mm) 저장
 *    (직접 계측값 또는 차분값 모두 '진짜 15분 값')
 *  - 표시 쿼리(getLatestRainfallByDistrict)는 이 값을 그대로 사용
 */
export async function checkAlarmCondition(station, preloadedRealtime = null, preloadedNx = null, preloadedNy = null) {
  const db = await getDatabase();

  // ─── 실시간 강우량 ───────────────────────────────────────────────────────

  let realtime15min;

  // 1순위: AWS 캐시에서 해당 관측소의 실제 15분 강수량 직접 조회
  const awsRn15 = kma.getAwsRn15FromCache(station.stn_id, station.lat, station.lon);

  if (awsRn15 !== null) {
    // 기상청 AWS 관측망 실측값 (날씨누리 "강수15"와 동일 소스)
    realtime15min = awsRn15;
  } else {
    // 2순위: 초단기실황 RN1 인메모리 차분
    const currentRN1 = preloadedRealtime !== null
      ? preloadedRealtime
      : await kma.getAWSRealtime15min(station.stn_id, station.lat, station.lon);

    const nx = preloadedNx !== null ? preloadedNx : kma.convertToGrid(station.lat, station.lon).nx;
    const ny = preloadedNy !== null ? preloadedNy : kma.convertToGrid(station.lat, station.lon).ny;
    const gridKey = `${nx},${ny}`;

    const prevRN1 = prevRN1ByGrid[gridKey] ?? null;
    realtime15min = (prevRN1 !== null && currentRN1 >= prevRN1)
      ? +(currentRN1 - prevRN1).toFixed(1)
      : 0;
  }

  // 실제 15분 강수량을 DB에 저장 (표시 쿼리 전용, 차분 계산 불필요)
  db.prepare(
    'INSERT INTO rainfall_realtime (station_id, rainfall_15min) VALUES (?, ?)'
  ).run(station.id, realtime15min);

  // 조건 1: 15분 강수량 > 20mm 아니면 스킵
  // forecast=0 저장: 비가 그쳤을 때 예측값이 DB에 잔류하여 오표시되는 것 방지
  if (realtime15min <= REALTIME_THRESHOLD) {
    db.prepare(
      'INSERT INTO rainfall_forecast (station_id, base_time, forecast_time, rainfall_forecast) VALUES (?, datetime("now"), datetime("now", "+1 hour"), ?)'
    ).run(station.id, 0);
    return { realtime15min, forecastHourly: 0, alarm: false, forecastCalled: false };
  }

  // 격자 좌표
  const nx = preloadedNx !== null ? preloadedNx : kma.convertToGrid(station.lat, station.lon).nx;
  const ny = preloadedNy !== null ? preloadedNy : kma.convertToGrid(station.lat, station.lon).ny;

  // 초단기 강수예측 시간당 강수량 (레이더 기반, 10분 갱신 / 격자좌표 캐시 활용)
  const gridKey = `${nx},${ny}`;
  let forecastHourly;
  let forecastCalled = false;

  if (gridKey in forecastCache) {
    forecastHourly = forecastCache[gridKey];
  } else {
    forecastHourly = await kma.getVsrtForecastHourly(nx, ny);
    forecastCache[gridKey] = forecastHourly;
    forecastCalled = true;
  }

  db.prepare(
    'INSERT INTO rainfall_forecast (station_id, base_time, forecast_time, rainfall_forecast) VALUES (?, datetime("now"), datetime("now", "+1 hour"), ?)'
  ).run(station.id, forecastHourly);

  // 조건 2: 초단기예보 시간당 강수량 >= 55mm
  if (forecastHourly >= FORECAST_THRESHOLD) {
    return { realtime15min, forecastHourly, alarm: true, forecastCalled };
  }

  return { realtime15min, forecastHourly, alarm: false, forecastCalled };
}

export async function getAlarmsByDistrict(districtId, limit = 20) {
  const db = await getDatabase();
  return db.prepare(`
    SELECT al.*, e.name as emd_name, e.code as emd_code
    FROM alarm_logs al
    JOIN emds e ON al.emd_id = e.id
    WHERE e.district_id = ?
    ORDER BY al.timestamp DESC
    LIMIT ?
  `).all(districtId, limit);
}

export async function getAlarmCountsByMetro(metroId) {
  const db = await getDatabase();
  const rows = db.prepare(`
    SELECT d.id as district_id, COUNT(al.id) as alarm_count
    FROM districts d
    LEFT JOIN emds e ON e.district_id = d.id
    LEFT JOIN alarm_logs al ON al.emd_id = e.id
      AND al.timestamp > datetime('now', '-1 hour')
    WHERE d.metro_id = ?
    GROUP BY d.id
  `).all(metroId);

  const counts = {};
  for (const row of rows) {
    counts[row.district_id] = row.alarm_count;
  }
  return counts;
}

export async function getLatestRainfallByDistrict(districtId) {
  const db = await getDatabase();
  // ─── 실측값: DB에 저장된 실제 15분 강수량 직접 조회 ─────────────────────
  // checkAlarmCondition 에서 항상 진짜 15분 강수량을 저장하므로 delta 계산 불필요.
  //   - AWS 캐시 경로: getAwsRn15FromCache → AWS 관측 15분 실측값
  //   - 차분 경로: RN1 차분으로 계산한 15분 근사값
  // 30분 이내 기록 없으면 COALESCE 로 0 반환 (폴링 중단·IDLE 상태 보호)
  return db.prepare(`
    SELECT
      e.code as emd_code,
      e.name as emd_name,
      ws.name as station_name,
      COALESCE(rr.rainfall_15min, 0) AS realtime_15min,
      COALESCE(rf.rainfall_forecast, 0) AS forecast_hourly
    FROM emds e
    LEFT JOIN weather_stations ws ON ws.emd_id = e.id
    LEFT JOIN rainfall_realtime rr ON rr.station_id = ws.id
      AND rr.id = (
        SELECT MAX(id) FROM rainfall_realtime
        WHERE station_id = ws.id
          AND timestamp >= datetime('now', '-30 minutes')
      )
    LEFT JOIN rainfall_forecast rf ON rf.station_id = ws.id
      AND rf.id = (
        SELECT MAX(id) FROM rainfall_forecast
        WHERE station_id = ws.id
          AND base_time >= datetime('now', '-30 minutes')
      )
    WHERE e.district_id = ?
  `).all(districtId);
}

export default {
  checkAlarmCondition,
  clearForecastCache,
  updateGridRN1,
  getAlarmsByDistrict,
  getAlarmCountsByMetro,
  getLatestRainfallByDistrict,
};
