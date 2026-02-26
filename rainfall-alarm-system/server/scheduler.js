import { getDatabase } from './config/database.js';
import { checkAlarmCondition, clearForecastCache, updateGridRN1 } from './services/alarmService.js';
import { emitAlarm, emitAlertState } from './websocket.js';
import { convertToGrid, getAWSRealtime15min, clearVsrtGridCache, clearAwsCache, fetchAllAwsData } from './services/kmaAPI.js';
import {
  updateAlertState,
  getStationsForFastPoll,
  getStationsForSlowPoll,
  getCurrentAlertState,
} from './services/weatherAlertService.js';

const BATCH_SIZE = 5;

// ─── 폴링 간격 ────────────────────────────────────────────────────────────
const ALERT_CHECK_IDLE   = 30 * 60 * 1000; // 30분
const ALERT_CHECK_ACTIVE =  5 * 60 * 1000; // 5분
const FAST_POLL_INTERVAL =  5 * 60 * 1000; // 5분 (호우주의보/경보 발효 지역)
const SLOW_POLL_INTERVAL = 30 * 60 * 1000; // 30분 (미발효 지역 / 전국 배경)

let alertCheckTimer = null;
let fastPollTimer   = null; // 5분 - 특보 발효 광역 전용
let slowPollTimer   = null; // 30분 - 미발효 광역 + IDLE 전체
let isPollRunning   = false; // 동시 실행 방지

export function startScheduler() {
  console.log('Scheduler started - 2-tier polling (fast: 5min alert areas / slow: 30min background)');
  scheduleAlertCheck(5000);      // 5초 후 첫 특보 체크
  scheduleSlowPoll(15 * 1000);   // 15초 후 첫 slow poll (서버 준비 대기)
}

function scheduleAlertCheck(delayMs) {
  if (alertCheckTimer) clearTimeout(alertCheckTimer);
  alertCheckTimer = setTimeout(() => runAlertCheck(), delayMs);
}

function scheduleFastPoll(delayMs) {
  if (fastPollTimer) clearTimeout(fastPollTimer);
  fastPollTimer = setTimeout(() => runFastPoll(), delayMs);
}

function scheduleSlowPoll(delayMs) {
  if (slowPollTimer) clearTimeout(slowPollTimer);
  slowPollTimer = setTimeout(() => runSlowPoll(), delayMs);
}

function stopFastPoll() {
  if (fastPollTimer) { clearTimeout(fastPollTimer); fastPollTimer = null; }
}

// 에러 시 backoff 계산 (최대 30분)
function getErrorBackoff(consecutiveErrors) {
  return Math.min(ALERT_CHECK_ACTIVE * Math.pow(2, consecutiveErrors - 1), ALERT_CHECK_IDLE);
}

async function runAlertCheck() {
  console.log(`[${new Date().toISOString()}] Running alert check...`);

  try {
    const { changed, state, error } = await updateAlertState();

    if (error) {
      const backoff = getErrorBackoff(state.consecutiveErrors);
      console.warn(`  [Scheduler] Alert API error - retry in ${(backoff / 60000).toFixed(1)}min (attempt ${state.consecutiveErrors})`);
      scheduleAlertCheck(backoff);
      // 특보 API 실패 → slow poll이 전체 폴백 담당 (getStationsForSlowPoll이 전체 반환)
      return;
    }

    if (changed) emitAlertState(state);

    if (state.level === 'ACTIVE') {
      if (changed) {
        console.log('  [Scheduler] IDLE→ACTIVE: starting fast poll (5min alert areas)');
        runFastPoll(); // 즉시 첫 fast poll
      }
      scheduleAlertCheck(ALERT_CHECK_ACTIVE);
    } else {
      if (changed) {
        console.log('  [Scheduler] ACTIVE→IDLE: stopping fast poll');
        stopFastPoll();
      }
      console.log('  [Scheduler] No rain alerts. IDLE - next check in 30min');
      scheduleAlertCheck(ALERT_CHECK_IDLE);
    }
  } catch (err) {
    console.error('Alert check error:', err);
    scheduleAlertCheck(ALERT_CHECK_ACTIVE);
  }
}

// ─── 배열을 n개씩 나누기 ─────────────────────────────────────────────────
function chunk(arr, n) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += n) chunks.push(arr.slice(i, i + n));
  return chunks;
}

// ─── 공통 폴링 로직 ───────────────────────────────────────────────────────
async function processStations(stations, label) {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] [${label}] Processing ${stations.length} stations...`);

  clearForecastCache();
  clearVsrtGridCache();
  clearAwsCache();
  await fetchAllAwsData(); // AWS 전국 10분 자료 1회 fetch

  // 격자좌표별 그룹핑
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
  console.log(`  [${label}] Grids: ${gridEntries.length} (${((1 - gridEntries.length / stations.length) * 100).toFixed(0)}% API saved)`);

  const alarms = [];
  let apiCalls = 0, forecastCalls = 0;

  const batches = chunk(gridEntries, BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    if (batchIdx > 0) await new Promise(r => setTimeout(r, 500));

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
        console.error(`  [${label}] Grid API error:`, result.reason?.message);
        continue;
      }

      const { group, realtime15min } = result.value;
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
              metroId: station.metro_id,
              realtime15min: alarmResult.realtime15min,
              forecastHourly: alarmResult.forecastHourly,
              timestamp: new Date().toISOString(),
            };
            alarms.push(alarm);
            emitAlarm(alarm);
            console.log(`  [${label}] ALARM: ${station.emd_name} - 15min: ${alarmResult.realtime15min}mm, forecast: ${alarmResult.forecastHourly}mm`);
          }
        } catch (err) {
          console.error(`  [${label}] Station ${station.stn_id} error:`, err.message);
        }
      }

      updateGridRN1(`${group.nx},${group.ny}`, realtime15min);
    }
  }

  // 오래된 데이터 정리 (1시간 이상)
  try {
    const db = await getDatabase();
    db.prepare("DELETE FROM rainfall_realtime WHERE timestamp < datetime('now', '-1 hour')").run();
    db.prepare("DELETE FROM rainfall_forecast WHERE base_time < datetime('now', '-1 hour')").run();
  } catch (cleanupErr) {
    console.error(`  [${label}] Cleanup error:`, cleanupErr.message);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  [${label}] Done in ${elapsed}s. API: ${apiCalls}+${forecastCalls}. Alarms: ${alarms.length}`);
}

// ─── Fast poll: 호우주의보/경보 발효 광역 (5분 간격) ──────────────────────
export async function runFastPoll() {
  if (isPollRunning) {
    console.log('  [Fast] Skipped - poll already running');
    scheduleFastPoll(FAST_POLL_INTERVAL);
    return;
  }

  const currentState = getCurrentAlertState();
  if (currentState.level !== 'ACTIVE' && currentState.consecutiveErrors === 0) {
    // ACTIVE가 아닌 경우 fast poll 불필요 (slow poll이 담당)
    return;
  }

  isPollRunning = true;
  try {
    const stations = await getStationsForFastPoll();
    if (stations.length > 0) {
      await processStations(stations, 'Fast');
    } else {
      console.log('  [Fast] No alert-area stations');
    }
  } catch (err) {
    console.error('Fast poll error:', err);
  } finally {
    isPollRunning = false;
  }

  // ACTIVE 유지 중이면 다음 fast poll 예약
  if (getCurrentAlertState().level === 'ACTIVE') {
    scheduleFastPoll(FAST_POLL_INTERVAL);
  }
}

// ─── Slow poll: 미발효 지역 / IDLE 전체 (30분 간격) ──────────────────────
async function runSlowPoll() {
  if (isPollRunning) {
    console.log('  [Slow] Skipped - poll already running, rescheduling');
    scheduleSlowPoll(SLOW_POLL_INTERVAL);
    return;
  }

  isPollRunning = true;
  try {
    const stations = await getStationsForSlowPoll();
    if (stations.length > 0) {
      await processStations(stations, 'Slow');
    } else {
      console.log('  [Slow] No non-alert stations (all covered by fast poll)');
    }
  } catch (err) {
    console.error('Slow poll error:', err);
  } finally {
    isPollRunning = false;
  }

  scheduleSlowPoll(SLOW_POLL_INTERVAL);
}

// 하위 호환성: 외부에서 runRainfallCheck 로 호출하는 경우 대응
export async function runRainfallCheck() {
  return runFastPoll();
}
