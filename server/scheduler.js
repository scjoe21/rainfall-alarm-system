import { getDatabase } from './config/database.js';
import { checkAlarmCondition, clearForecastCache } from './services/alarmService.js';
import { emitAlarm, emitAlarmCounts, emitAlertState } from './websocket.js';
import { convertToGrid, getAWSRealtime15min } from './services/kmaAPI.js';
import {
  updateAlertState,
  getStationsToPoll,
  getCurrentAlertState,
} from './services/weatherAlertService.js';

const BATCH_SIZE = 10;

// 간격 설정 (밀리초)
const ALERT_CHECK_IDLE = 30 * 60 * 1000;   // 30분
const ALERT_CHECK_ACTIVE = 5 * 60 * 1000;  // 5분
const RAINFALL_POLL_INTERVAL = 5 * 60 * 1000; // 5분

let alertCheckTimer = null;
let rainfallPollTimer = null;

export function startScheduler() {
  console.log('Scheduler started - adaptive polling mode');
  // 5초 후 첫 특보 체크
  scheduleAlertCheck(5000);
}

function scheduleAlertCheck(delayMs) {
  if (alertCheckTimer) clearTimeout(alertCheckTimer);
  alertCheckTimer = setTimeout(() => runAlertCheck(), delayMs);
}

function scheduleRainfallPoll(delayMs) {
  if (rainfallPollTimer) clearTimeout(rainfallPollTimer);
  rainfallPollTimer = setTimeout(() => runRainfallCheck(), delayMs);
}

function stopRainfallPoll() {
  if (rainfallPollTimer) {
    clearTimeout(rainfallPollTimer);
    rainfallPollTimer = null;
  }
}

// 에러 시 backoff 계산 (최대 30분)
function getErrorBackoff(consecutiveErrors) {
  const base = ALERT_CHECK_ACTIVE; // 5분
  const backoff = Math.min(base * Math.pow(2, consecutiveErrors - 1), ALERT_CHECK_IDLE);
  return backoff;
}

async function runAlertCheck() {
  console.log(`[${new Date().toISOString()}] Running alert check...`);

  try {
    const { changed, state, error } = await updateAlertState();

    // API 에러 시 backoff 적용
    if (error) {
      const backoff = getErrorBackoff(state.consecutiveErrors);
      const backoffMin = (backoff / 60000).toFixed(1);
      console.warn(`  [Scheduler] Alert API error - retry in ${backoffMin}min (attempt ${state.consecutiveErrors})`);
      scheduleAlertCheck(backoff);
      return;
    }

    // 상태 변경 시 WebSocket 알림
    if (changed) {
      emitAlertState(state);
    }

    if (state.level === 'ACTIVE') {
      if (changed) {
        // IDLE → ACTIVE 전환: 즉시 강우 폴링 시작
        console.log('  [Scheduler] ACTIVE - starting rainfall polling (1min interval)');
        runRainfallCheck();
      }
      // ACTIVE: 5분 후 재체크
      scheduleAlertCheck(ALERT_CHECK_ACTIVE);
    } else {
      // IDLE: 강우 폴링 중지, 30분 후 재체크
      if (changed) {
        console.log('  [Scheduler] IDLE - stopping rainfall polling');
        stopRainfallPoll();
      }
      console.log('  [Scheduler] No rain alerts. IDLE - next check in 30min');
      scheduleAlertCheck(ALERT_CHECK_IDLE);
    }
  } catch (err) {
    console.error('Alert check error:', err);
    scheduleAlertCheck(ALERT_CHECK_ACTIVE);
  }
}

// 배열을 n개씩 나누기
function chunk(arr, n) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += n) {
    chunks.push(arr.slice(i, i + n));
  }
  return chunks;
}

export async function runRainfallCheck() {
  const currentState = getCurrentAlertState();
  if (currentState.level !== 'ACTIVE') {
    console.log('  [Rainfall] Skipped - not in ACTIVE state');
    return;
  }

  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Running rainfall check...`);

  try {
    const stations = await getStationsToPoll();

    if (stations.length === 0) {
      console.log('  [Rainfall] No stations to poll');
      scheduleRainfallPoll(RAINFALL_POLL_INTERVAL);
      return;
    }

    clearForecastCache();

    // 1단계: 격자좌표별 그룹핑
    const gridGroups = {};
    for (const station of stations) {
      const { nx, ny } = convertToGrid(station.lat, station.lon);
      const key = `${nx},${ny}`;
      if (!gridGroups[key]) {
        gridGroups[key] = { nx, ny, lat: station.lat, lon: station.lon, stations: [] };
      }
      gridGroups[key].stations.push(station);
    }

    const gridEntries = Object.entries(gridGroups);
    console.log(`  Stations: ${stations.length}, Unique grids: ${gridEntries.length} (${((1 - gridEntries.length / stations.length) * 100).toFixed(0)}% API calls saved)`);

    // 2단계: 배치 병렬 실황 API 호출
    const alarms = [];
    let apiCalls = 0;
    let forecastCalls = 0;

    const batches = chunk(gridEntries, BATCH_SIZE);

    for (const batch of batches) {
      const realtimeResults = await Promise.allSettled(
        batch.map(async ([key, group]) => {
          const realtime15min = await getAWSRealtime15min(
            group.stations[0].stn_id, group.lat, group.lon
          );
          return { key, group, realtime15min };
        })
      );

      for (const result of realtimeResults) {
        if (result.status === 'rejected') {
          console.error(`  Grid API error:`, result.reason?.message);
          continue;
        }

        const { key, group, realtime15min } = result.value;
        apiCalls++;

        for (const station of group.stations) {
          try {
            const alarmResult = await checkAlarmCondition(station, realtime15min, group.nx, group.ny);

            if (alarmResult.forecastCalled) forecastCalls++;

            if (alarmResult.alarm) {
              const alarm = {
                emdCode: station.emd_code,
                emdName: station.emd_name,
                districtId: station.district_id,
                realtime15min: alarmResult.realtime15min,
                forecast45min: alarmResult.forecast45min,
                total60min: alarmResult.total60min,
                timestamp: new Date().toISOString(),
              };
              alarms.push(alarm);
              emitAlarm(alarm);
              console.log(`  ALARM: ${station.emd_name} - 15min: ${alarmResult.realtime15min}mm, total: ${alarmResult.total60min}mm`);
            }
          } catch (err) {
            console.error(`  Station ${station.stn_id} error:`, err.message);
          }
        }
      }
    }

    // 3단계: 알람 카운트 업데이트
    const db = await getDatabase();
    const metros = db.prepare('SELECT * FROM metros').all();
    for (const metro of metros) {
      const rows = db.prepare(`
        SELECT d.id as district_id, COUNT(al.id) as alarm_count
        FROM districts d
        LEFT JOIN emds e ON e.district_id = d.id
        LEFT JOIN alarm_logs al ON al.emd_id = e.id
          AND al.timestamp > datetime('now', '-1 hour')
        WHERE d.metro_id = ?
        GROUP BY d.id
      `).all(metro.id);

      const counts = {};
      for (const row of rows) {
        counts[row.district_id] = row.alarm_count;
      }
      emitAlarmCounts(counts);
    }

    // 4단계: 오래된 데이터 정리
    try {
      db.prepare("DELETE FROM rainfall_realtime WHERE timestamp < datetime('now', '-24 hours')").run();
      db.prepare("DELETE FROM rainfall_forecast WHERE base_time < datetime('now', '-24 hours')").run();
      db.prepare("DELETE FROM alarm_logs WHERE timestamp < datetime('now', '-7 days')").run();
    } catch (cleanupErr) {
      console.error('  Cleanup error:', cleanupErr.message);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  Done in ${elapsed}s. API: ${apiCalls} realtime + ${forecastCalls} forecast. Alarms: ${alarms.length}`);
  } catch (err) {
    console.error('Rainfall check error:', err);
  }

  // 다음 폴링 예약 (ACTIVE 상태 유지 시)
  const latestState = getCurrentAlertState();
  if (latestState.level === 'ACTIVE') {
    scheduleRainfallPoll(RAINFALL_POLL_INTERVAL);
  }
}
