import { getDatabase } from '../config/database.js';
import kma from './kmaAPI.js';

const REALTIME_THRESHOLD = 20.0;
const FORECAST_THRESHOLD = 55.0;

// AWS 관측소용 격자별 이전 RN1 (prevRN1ByGrid와 별도)
const prevRN1ByAwsGrid = {};

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

  // 조건 1: 15분 강수량 >= 20mm 아니면 스킵 (20밀리 이상)
  // forecast=0 저장: 비가 그쳤을 때 예측값이 DB에 잔류하여 오표시되는 것 방지
  if (realtime15min < REALTIME_THRESHOLD) {
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

  // 조건 2: 60분 예측치 >= 55mm (초단기 강수예측, 향후 1시간 시간당 강수량)
  if (forecastHourly >= FORECAST_THRESHOLD) {
    return { realtime15min, forecastHourly, alarm: true, forecastCalled };
  }

  return { realtime15min, forecastHourly, alarm: false, forecastCalled };
}

// ─── AWS 관측소 기준 알람 (관측소 이름 기준) ─────────────────────────────────

export function updateAwsGridRN1(gridKey, rn1) {
  prevRN1ByAwsGrid[gridKey] = rn1;
}

export function getPrevAwsGridRN1(gridKey) {
  return prevRN1ByAwsGrid[gridKey] ?? null;
}

/**
 * AWS 관측소 기준 알람 조건 체크
 * @param {Object} awsStation - { stn_id, name, lat, lon, rn15?, rn60? }
 * @param {number} preloadedRealtime - 이미 조회된 15분 강수량 (캐시 또는 폴백)
 * @param {number} preloadedNx - 격자 nx
 * @param {number} preloadedNy - 격자 ny
 * @param {number} preloadedRn60 - 1시간 실측치 (RN1 또는 RN_60M, 특보 없을 때 표시용)
 */
export async function checkAlarmConditionForAwsStation(awsStation, preloadedRealtime = null, preloadedNx = null, preloadedNy = null, preloadedRn60 = null) {
  const db = await getDatabase();

  const rainfall1hour = preloadedRn60 ?? awsStation.rn60 ?? null;

  let realtime15min;

  if (preloadedRealtime !== null) {
    realtime15min = preloadedRealtime;
  } else {
    const cachedRn15 = kma.getAwsRn15FromCache(awsStation.stn_id, awsStation.lat, awsStation.lon);
    if (cachedRn15 !== null) {
      realtime15min = cachedRn15;
    } else {
      const currentRN1 = await kma.getAWSRealtime15min(awsStation.stn_id, awsStation.lat, awsStation.lon);
      const nx = preloadedNx ?? kma.convertToGrid(awsStation.lat, awsStation.lon).nx;
      const ny = preloadedNy ?? kma.convertToGrid(awsStation.lat, awsStation.lon).ny;
      const gridKey = `${nx},${ny}`;
      const prevRN1 = prevRN1ByAwsGrid[gridKey] ?? null;
      realtime15min = (prevRN1 !== null && currentRN1 >= prevRN1)
        ? +(currentRN1 - prevRN1).toFixed(1)
        : 0;
    }
  }

  const nx = preloadedNx ?? kma.convertToGrid(awsStation.lat, awsStation.lon).nx;
  const ny = preloadedNy ?? kma.convertToGrid(awsStation.lat, awsStation.lon).ny;
  const gridKey = `${nx},${ny}`;

  // 1시간 예측치: 항상 조회·저장 (표시용, 눈/가벼운 비에서도 표시)
  let forecastHourly;
  let forecastCalled = false;
  if (gridKey in forecastCache) {
    forecastHourly = forecastCache[gridKey];
  } else {
    forecastHourly = await kma.getVsrtForecastHourly(nx, ny);
    forecastCache[gridKey] = forecastHourly;
    forecastCalled = true;
  }

  saveAwsRainfall(db, awsStation.stn_id, awsStation.name, awsStation.lat, awsStation.lon, realtime15min, forecastHourly, rainfall1hour);

  // 알람: 15분 실측치 >= 20mm AND 60분 예측치 >= 55mm
  if (realtime15min >= REALTIME_THRESHOLD && forecastHourly >= FORECAST_THRESHOLD) {
    return { realtime15min, forecastHourly, alarm: true, forecastCalled };
  }
  return { realtime15min, forecastHourly, alarm: false, forecastCalled };
}

export function saveAwsRainfall(db, stnId, name, lat, lon, rainfall15min, forecastHourly, rainfall1hour = null) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO aws_rainfall (stn_id, name, lat, lon, rainfall_15min, rainfall_1hour, forecast_hourly, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(stnId, name, lat, lon, rainfall15min, rainfall1hour, forecastHourly ?? null);
}

export async function getLatestRainfallByAwsStation() {
  const db = await getDatabase();
  return db.prepare(`
    SELECT stn_id, name, lat, lon, rainfall_15min, rainfall_1hour, forecast_hourly, updated_at
    FROM aws_rainfall
    WHERE updated_at >= datetime('now', '-60 minutes')
    ORDER BY updated_at DESC
  `).all();
}

export async function getAwsAlarmLogs(limit = 50) {
  const db = await getDatabase();
  return db.prepare(`
    SELECT stn_id, station_name, realtime_15min, forecast_hourly, timestamp
    FROM aws_alarm_logs
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit);
}

export async function logAwsAlarm(stnId, stationName, realtime15min, forecastHourly) {
  const db = await getDatabase();
  db.prepare(`
    INSERT INTO aws_alarm_logs (stn_id, station_name, realtime_15min, forecast_hourly)
    VALUES (?, ?, ?, ?)
  `).run(stnId, stationName, realtime15min, forecastHourly);
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

/**
 * AWS 관측소 데이터를 rainfall_realtime/rainfall_forecast에 동기화
 * → 기존 클라이언트(읍면동 맵)가 15분 실측치를 표시할 수 있도록 함
 */
export async function syncAwsToRainfallRealtime() {
  const db = await getDatabase();
  const awsRows = db.prepare(`
    SELECT stn_id, lat, lon, rainfall_15min, rainfall_1hour, forecast_hourly
    FROM aws_rainfall
    WHERE updated_at >= datetime('now', '-60 minutes')
      AND (rainfall_15min IS NOT NULL OR rainfall_1hour IS NOT NULL OR forecast_hourly IS NOT NULL)
  `).all();

  if (awsRows.length === 0) return 0;

  const weatherStations = db.prepare(
    'SELECT id, lat, lon FROM weather_stations'
  ).all();

  const insertRealtime = db.prepare(
    'INSERT INTO rainfall_realtime (station_id, rainfall_15min, rainfall_1hour) VALUES (?, ?, ?)'
  );
  const insertForecast = db.prepare(`
    INSERT INTO rainfall_forecast (station_id, base_time, forecast_time, rainfall_forecast)
    VALUES (?, datetime('now'), datetime('now', '+1 hour'), ?)
  `);

  let synced = 0;
  for (const ws of weatherStations) {
    if (ws.lat == null || ws.lon == null) continue;

    let nearest = null;
    let minDist = 2.0; // ~140km 이내 (기존 0.5는 ~78km, 매칭 실패 시 확대)

    for (const aws of awsRows) {
      if (aws.lat == null || aws.lon == null) continue;
      const d = (aws.lat - ws.lat) ** 2 + (aws.lon - ws.lon) ** 2;
      if (d < minDist) {
        minDist = d;
        nearest = aws;
      }
    }

    if (nearest) {
      const rn15 = nearest.rainfall_15min ?? 0;
      const rn60 = nearest.rainfall_1hour ?? null;
      const fcst = nearest.forecast_hourly ?? 0;
      insertRealtime.run(ws.id, rn15, rn60);
      insertForecast.run(ws.id, fcst);
      synced++;
    }
  }

  return synced;
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
      COALESCE(rr.rainfall_1hour, 0) AS realtime_1hour,
      COALESCE(rf.rainfall_forecast, 0) AS forecast_hourly
    FROM emds e
    LEFT JOIN weather_stations ws ON ws.emd_id = e.id
    LEFT JOIN rainfall_realtime rr ON rr.station_id = ws.id
      AND rr.id = (
        SELECT MAX(id) FROM rainfall_realtime
        WHERE station_id = ws.id
          AND timestamp >= datetime('now', '-60 minutes')
      )
    LEFT JOIN rainfall_forecast rf ON rf.station_id = ws.id
      AND rf.id = (
        SELECT MAX(id) FROM rainfall_forecast
        WHERE station_id = ws.id
          AND base_time >= datetime('now', '-60 minutes')
      )
    WHERE e.district_id = ?
  `).all(districtId);
}

export default {
  checkAlarmCondition,
  checkAlarmConditionForAwsStation,
  clearForecastCache,
  updateGridRN1,
  updateAwsGridRN1,
  saveAwsRainfall,
  syncAwsToRainfallRealtime,
  getLatestRainfallByAwsStation,
  getAwsAlarmLogs,
  logAwsAlarm,
  getAlarmsByDistrict,
  getAlarmCountsByMetro,
  getLatestRainfallByDistrict,
};
