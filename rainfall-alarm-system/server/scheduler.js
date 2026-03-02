import { getDatabase } from './config/database.js';
import { checkAlarmCondition, clearForecastCache, updateGridRN1 } from './services/alarmService.js';
import { emitAlarm, emitAlertState } from './websocket.js';
import { convertToGrid, getAWSRealtime15min, clearVsrtGridCache, clearAwsCache, fetchAllAwsData, isAwsCacheAvailable } from './services/kmaAPI.js';
import {
  updateAlertState,
  getStationsForFastPoll,
  getStationsForSlowPoll,
  getCurrentAlertState,
} from './services/weatherAlertService.js';
import { getAwsRn15FromCache } from './services/kmaAPI.js';

const BATCH_SIZE = 5;

// ─── 폴링 간격 ────────────────────────────────────────────────────────────
const ALERT_CHECK_IDLE   = 30 * 60 * 1000; // 30분
const ALERT_CHECK_ACTIVE =  5 * 60 * 1000; // 5분
const FAST_POLL_INTERVAL =  5 * 60 * 1000; // 5분 (호우주의보/경보 발효 지역)
const SLOW_POLL_INTERVAL = 30 * 60 * 1000; // 30분 (미발효 지역 / 전국 배경)
const AWS_REFRESH_INTERVAL = 10 * 60 * 1000; // 10분 (AWS 캐시 전용, 공공 API 미사용)

let alertCheckTimer  = null;
let fastPollTimer    = null; // 5분 - 특보 발효 광역 전용
let slowPollTimer    = null; // 30분 - 미발효 광역 + IDLE 전체
let awsRefreshTimer  = null; // 10분 - AWS 캐시 단독 갱신
let isPollRunning    = false; // 동시 실행 방지

// ─── KMA AWS 10분 자료 정렬 타이머 ────────────────────────────────────────
// 기상청 AWS 10분 자료는 매 :00, :10, :20... 이후 ~5분 지연으로 제공됨
// → :07, :17, :27, :37, :47, :57 에 폴링 (2분 추가 버퍼)
function msUntilNextAwsPoll() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const min  = kst.getUTCMinutes();
  const sec  = kst.getUTCSeconds();
  const msec = kst.getUTCMilliseconds();

  // 현재 10분 주기 내 경과 시간
  const elapsedInPeriod = ((min % 10) * 60 + sec) * 1000 + msec;
  const targetOffsetMs  = 7 * 60 * 1000; // 매 10분 주기의 7분 지점

  let delay = targetOffsetMs - elapsedInPeriod;
  if (delay <= 30 * 1000) delay += AWS_REFRESH_INTERVAL; // 30초 미만이면 다음 주기
  return delay;
}

function scheduleAwsRefresh(delayMs) {
  if (awsRefreshTimer) clearTimeout(awsRefreshTimer);
  awsRefreshTimer = setTimeout(() => runAwsRefresh(), delayMs);
}

// ─── 10분 AWS 단독 갱신: APIHUB 1회 호출, 공공 API 0회 ──────────────────
// fetchAllAwsData()로 전국 AWS 자료를 캐시에 올린 뒤,
// DB의 모든 관측소에 대해 캐시 조회 → rainfall_realtime 즉시 갱신.
// 관측소별 공공 API 호출(getUltraSrtNcst)은 수행하지 않으므로
// 일일 API 한도를 전혀 소모하지 않는다.
async function runAwsRefresh() {
  try {
    clearAwsCache();
    await fetchAllAwsData(); // APIHUB 1회 (callKmaApi 카운터 미포함)

    const db = await getDatabase();
    const stations = db.prepare(
      'SELECT id, stn_id, lat, lon FROM weather_stations'
    ).all();

    const stmt = db.prepare(
      'INSERT INTO rainfall_realtime (station_id, rainfall_15min) VALUES (?, ?)'
    );

    let updated = 0;
    for (const station of stations) {
      const rn15 = getAwsRn15FromCache(station.stn_id, station.lat, station.lon);
      if (rn15 !== null) {
        stmt.run(station.id, rn15);
        updated++;
      }
    }

    console.log(`  [AWS10m] ${updated}/${stations.length}개 관측소 갱신 (공공 API 0회)`);
  } catch (err) {
    console.error('[AWS10m] 갱신 오류:', err.message);
  }

  scheduleAwsRefresh(AWS_REFRESH_INTERVAL);
}

export function startScheduler() {
  console.log('Scheduler started - 3-tier: fast(5min) / slow(30min) / AWS-only(10min KMA-aligned)');
  scheduleAlertCheck(5000);      // 5초 후 첫 특보 체크
  scheduleSlowPoll(15 * 1000);   // 15초 후 첫 slow poll (서버 준비 대기)

  // AWS 10분 갱신: KMA 데이터 제공 시각(:07, :17, :27...)에 맞춰 첫 실행 예약
  const firstAwsDelay = msUntilNextAwsPoll();
  console.log(`  [AWS10m] 첫 갱신까지 ${(firstAwsDelay / 60000).toFixed(1)}분 대기 (KMA :07/:17/:27... 정렬)`);
  scheduleAwsRefresh(firstAwsDelay);
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
      console.log('  [Scheduler] No rain alerts. IDLE - next check in 30min. Running background rainfall check...');
      scheduleAlertCheck(ALERT_CHECK_IDLE);
      // 특보 미발효 시에도 강우량을 수집: 특보 체크(30분)와 slow poll(30분)이
      // 별도 스케줄로 어긋날 경우 최대 30분 공백이 생기는 문제를 방지한다.
      // isPollRunning 가드로 slow poll 자체 스케줄과 겹치면 자동으로 건너뜀.
      runSlowPollOnce();
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
  const awsCacheOk = isAwsCacheAvailable();
  console.log(`  [${label}] Grids: ${gridEntries.length}, AWS캐시: ${awsCacheOk ? '사용가능' : '없음(폴백제한)'}`);

  const alarms = [];
  let apiCalls = 0, forecastCalls = 0;

  // ── AWS 캐시 성공 시: 캐시 조회 전용, 공공 API 0회 (병렬 배치)
  // ── AWS 캐시 실패 시: 전체 격자에 공공 API 직렬 폴백 (1개씩, 750ms 간격 → 429 방지)
  //    직렬 처리: ~1377격자 × 750ms ≈ 17분 (30분 폴링 주기 이내)
  const batchSize = awsCacheOk ? BATCH_SIZE : 1;
  const batchDelay = awsCacheOk ? 0 : 750;
  if (!awsCacheOk) {
    const estMin = Math.round(gridEntries.length * 0.75 / 60);
    console.log(`  [${label}] APIHUB 없음 → 공공 API 직렬 폴백 (${gridEntries.length}격자, 약 ${estMin}분 소요)`);
  }

  const batches = chunk(gridEntries, batchSize);
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    if (batchIdx > 0 && batchDelay > 0) await new Promise(r => setTimeout(r, batchDelay));

    const realtimeResults = await Promise.allSettled(
      batch.map(async ([key, group]) => {
        const stnId = group.stations[0].stn_id;
        const cachedRn15 = getAwsRn15FromCache(stnId, group.lat, group.lon);

        let realtime15min, skippedNcst;

        if (cachedRn15 !== null) {
          // AWS 캐시 히트: 15분 실측값 직접 사용
          realtime15min = cachedRn15;
          skippedNcst = true;
        } else if (awsCacheOk) {
          // AWS 캐시 정상이나 반경 내 관측소 없음 → 0 처리
          realtime15min = 0;
          skippedNcst = true;
        } else {
          // APIHUB 완전 실패 → 격자 기반 공공 API 폴백 (가상 관측소 포함 전체 격자)
          realtime15min = await getAWSRealtime15min(stnId, group.lat, group.lon);
          skippedNcst = false;
        }

        return { key, group, realtime15min, skippedNcst };
      })
    );

    for (const result of realtimeResults) {
      if (result.status === 'rejected') {
        console.error(`  [${label}] Grid API error:`, result.reason?.message);
        continue;
      }

      const { group, realtime15min, skippedNcst } = result.value;
      if (!skippedNcst) apiCalls++;

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

      // prevRN1ByGrid는 RN1 누적값(1시간 슬라이딩) delta 계산에 사용된다.
      // AWS 캐시 경로(skippedNcst=true)는 이미 15분 실측값을 직접 반환하므로
      // prevRN1ByGrid를 15분 값으로 오염시키지 않는다 (다음 사이클 delta 오계산 방지).
      if (!skippedNcst) {
        updateGridRN1(`${group.nx},${group.ny}`, realtime15min);
      }
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

// ─── Slow poll 핵심 로직 (스케줄 없음) ───────────────────────────────────
// runSlowPoll(스케줄드) 과 runAlertCheck IDLE 분기 양쪽에서 공유
async function runSlowPollOnce() {
  if (isPollRunning) {
    console.log('  [Slow] Skipped - poll already running');
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
}

// ─── Slow poll: 미발효 지역 / IDLE 전체 (30분 간격) ──────────────────────
async function runSlowPoll() {
  await runSlowPollOnce();
  scheduleSlowPoll(SLOW_POLL_INTERVAL);
}

// 하위 호환성: 외부에서 runRainfallCheck 로 호출하는 경우 대응
export async function runRainfallCheck() {
  return runFastPoll();
}
