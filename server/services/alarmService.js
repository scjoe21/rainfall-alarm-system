import { getDatabase } from '../config/database.js';
import kma from './kmaAPI.js';

const REALTIME_THRESHOLD = 20.0;
const TOTAL_THRESHOLD = 55.0;

// 격자좌표별 예보 캐시 (동일 실행 사이클 내에서만 유효)
let forecastCache = {};

export function clearForecastCache() {
  forecastCache = {};
}

/**
 * 알람 조건 체크
 * @param {Object} station - 관측소 정보
 * @param {number|null} preloadedRealtime - 이미 조회된 실시간 강우량 (null이면 직접 조회)
 * @param {number|null} preloadedNx - 이미 계산된 격자 X좌표
 * @param {number|null} preloadedNy - 이미 계산된 격자 Y좌표
 */
export async function checkAlarmCondition(station, preloadedRealtime = null, preloadedNx = null, preloadedNy = null) {
  const db = await getDatabase();

  // 1. 실시간 강우량: 전달받은 값 사용 또는 직접 조회
  const realtime15min = preloadedRealtime !== null
    ? preloadedRealtime
    : await kma.getAWSRealtime15min(station.stn_id, station.lat, station.lon);

  // Save realtime data
  db.prepare(
    'INSERT INTO rainfall_realtime (station_id, rainfall_15min) VALUES (?, ?)'
  ).run(station.id, realtime15min);

  // 조건 1: 15분 실시간 > 20mm 아니면 스킵
  if (realtime15min <= REALTIME_THRESHOLD) {
    return { realtime15min, forecast45min: 0, total60min: realtime15min, alarm: false, forecastCalled: false };
  }

  // 2. 격자 좌표
  const nx = preloadedNx !== null ? preloadedNx : kma.convertToGrid(station.lat, station.lon).nx;
  const ny = preloadedNy !== null ? preloadedNy : kma.convertToGrid(station.lat, station.lon).ny;

  // 3. 45분 예측 강우량 (격자좌표 캐시 활용)
  const gridKey = `${nx},${ny}`;
  let forecast45min;
  let forecastCalled = false;

  if (gridKey in forecastCache) {
    forecast45min = forecastCache[gridKey];
  } else {
    forecast45min = await kma.getForecast45min(nx, ny);
    forecastCache[gridKey] = forecast45min;
    forecastCalled = true;
  }

  // 4. 총 강우량 계산
  const total60min = +(realtime15min + forecast45min).toFixed(1);

  // Save forecast data
  db.prepare(
    'INSERT INTO rainfall_forecast (station_id, base_time, forecast_time, rainfall_forecast) VALUES (?, datetime("now"), datetime("now", "+45 minutes"), ?)'
  ).run(station.id, forecast45min);

  // 조건 2: 총 60분 > 55mm
  // 알람 이력은 DB에 저장하지 않음 (실시간 표시 4분 50초 후 자동 만료)
  if (total60min > TOTAL_THRESHOLD) {
    return { realtime15min, forecast45min, total60min, alarm: true, forecastCalled };
  }

  return { realtime15min, forecast45min, total60min, alarm: false, forecastCalled };
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
  return db.prepare(`
    SELECT
      e.code as emd_code,
      e.name as emd_name,
      ws.name as station_name,
      COALESCE(rr.rainfall_15min, 0) as realtime_15min,
      COALESCE(rf.rainfall_forecast, 0) as forecast_45min,
      COALESCE(rr.rainfall_15min, 0) + COALESCE(rf.rainfall_forecast, 0) as total_60min
    FROM emds e
    LEFT JOIN weather_stations ws ON ws.emd_id = e.id
    LEFT JOIN rainfall_realtime rr ON rr.station_id = ws.id
      AND rr.id = (SELECT MAX(id) FROM rainfall_realtime WHERE station_id = ws.id)
    LEFT JOIN rainfall_forecast rf ON rf.station_id = ws.id
      AND rf.id = (SELECT MAX(id) FROM rainfall_forecast WHERE station_id = ws.id)
    WHERE e.district_id = ?
  `).all(districtId);
}

export default {
  checkAlarmCondition,
  clearForecastCache,
  getAlarmsByDistrict,
  getAlarmCountsByMetro,
  getLatestRainfallByDistrict,
};
