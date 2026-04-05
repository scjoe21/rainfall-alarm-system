import { getDatabase } from './config/database.js';
import {
  checkAlarmConditionForAwsStation,
  clearForecastCache,
  updateAwsGridRN1,
  getPrevAwsGridRN1,
  logAwsAlarm,
  syncAwsToRainfallRealtime,
  saveAwsRainfall,
  buildAwsToEmdMap,
  findNearestEmd,
} from './services/alarmService.js';
import { emitAlarm, emitAlertState } from './websocket.js';
import {
  convertToGrid,
  getAWSRealtime15min,
  getVsrtForecastHourly,
  prefetchVsrtForecastGrid,
  clearAwsCache,
  clearNcstGridCache,
  fetchAllAwsData,
  isAwsCacheAvailable,
  getAwsStationsWithRainfall,
  getAwsStationsForFallback,
  getAwsRn15FromCache,
} from './services/kmaAPI.js';
import {
  updateAlertState,
  getCurrentAlertState,
} from './services/weatherAlertService.js';

const BATCH_SIZE = 5;

// ─── 폴링 간격 ────────────────────────────────────────────────────────────
// 알람: 15분 실측치 >= 20mm AND 60분 예측치 >= 55mm
// 호우주의보/경보 있을 때: 5분마다 조건 확인 | 비 없을 때: 30분마다 전국 폴링
const ALERT_CHECK_IDLE   = 30 * 60 * 1000; // 30분
const ALERT_CHECK_ACTIVE =  5 * 60 * 1000; // 5분
const FAST_POLL_INTERVAL =  5 * 60 * 1000; // 5분 (특보 발효 시)
const SLOW_POLL_INTERVAL = 30 * 60 * 1000; // 30분 (특보 미발효 / 전국)
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
// aws_rainfall 테이블에 관측소별 15분 강수량 갱신.
// 폴백 시 우선 처리할 관측소 (세종·조치원·대전 등 비가 와도 수치가 안 나오던 지역)
const FALLBACK_PRIORITY_STN_IDS = ['494', '360', '861', '133', '232', '131', '108', '119', '112'];

async function runAwsRefresh() {
  try {
    await fetchAllAwsData();
    clearNcstGridCache(); // 공공 API 격자 캐시 초기화
    await prefetchVsrtForecastGrid(); // API허브 VSRT 전국 격자 1회 → 1시간 예측 공공 API 폭주 방지

    let stations = getAwsStationsWithRainfall();
    const db = await getDatabase();

    // APIHUB가 전부 0 반환 시 신뢰 불가 → 공공 API 사용 (며칠째 0만 나오는 문제 해결)
    const allZeros = stations.length > 0 && stations.every(s =>
      ((s.rn15 ?? 0) === 0 && (s.rn60 ?? 0) === 0)
    );
    if (allZeros) {
      stations = [];
      console.log('  [AWS10m] APIHUB 전부 0 → 공공 API(초단기실황) 사용');
    }

    let updated = 0;
    if (stations.length === 0) {
      const fallback = getAwsStationsForFallback();
      const priority = fallback.filter(s => FALLBACK_PRIORITY_STN_IDS.includes(String(s.stn_id)));
      const rest = fallback.filter(s => !FALLBACK_PRIORITY_STN_IDS.includes(String(s.stn_id)));
      const fallbackMax = parseInt(process.env.AWS_FALLBACK_MAX || '80', 10);
      const toProcess = [...priority, ...rest].slice(0, fallbackMax); // 700+ 확대 시 AWS_FALLBACK_MAX=731
      if (toProcess.length > 0) {
        console.log(`  [AWS10m] APIHUB 없음 → 공공 API 폴백 ${toProcess.length}개 관측소`);
        for (let i = 0; i < toProcess.length; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, 1500));
          const s = toProcess[i];
          try {
            const rn1 = await getAWSRealtime15min(s.stn_id, s.lat, s.lon);
            const { nx, ny } = convertToGrid(s.lat, s.lon);
            const prev = getPrevAwsGridRN1(`${nx},${ny}`);
            const rn15 = (prev != null && rn1 >= prev) ? +(rn1 - prev).toFixed(1) : 0;
            updateAwsGridRN1(`${nx},${ny}`, rn1);
            const hasRain = rn15 > 0 || rn1 > 0;
            const forecastHourly = hasRain ? await getVsrtForecastHourly(nx, ny) : 0;
            saveAwsRainfall(db, s.stn_id, s.name, s.lat, s.lon, rn15, forecastHourly, rn1);
            updated++;
          } catch (e) {
            console.warn(`  [AWS10m] 폴백 ${s.name} 오류:`, e.message);
          }
        }
      } else {
        console.log('  [AWS10m] 캐시 없음, 폴백 목록 없음 - DB 갱신 스킵');
        scheduleAwsRefresh(AWS_REFRESH_INTERVAL);
        return;
      }
    } else {
      for (const s of stations) {
        const rn15 = s.rn15 ?? getAwsRn15FromCache(s.stn_id, s.lat, s.lon);
        const rn60 = s.rn60 ?? null;
        const { nx, ny } = convertToGrid(s.lat, s.lon);
        const rn15Val = (rn15 !== null && rn15 !== undefined) ? rn15 : 0;
        const rn60Val = (rn60 !== null && rn60 !== undefined) ? rn60 : null;
        // 강수가 있는 관측소만 예측 API 호출: 비 없는 606개 전체 호출 → KMA 분당 한도 초과 방지
        // forecast45minCache가 동일 baseKey 내 중복 격자를 캐시하므로 실제 호출 수는 고유 격자 수
        const hasRain = rn15Val > 0 || (rn60Val !== null && rn60Val > 0);
        const forecastHourly = hasRain ? await getVsrtForecastHourly(nx, ny) : 0;
        saveAwsRainfall(db, s.stn_id, s.name, s.lat, s.lon, rn15Val, forecastHourly, rn60Val);
        updated++;
      }
      // APIHUB 파싱은 성공했으나 RN 컬럼 미발견(전부 null) → 공공 API 폴백
      if (updated === 0 && stations.length > 0) {
        const fallback = getAwsStationsForFallback();
        const priority = fallback.filter(s => FALLBACK_PRIORITY_STN_IDS.includes(String(s.stn_id)));
        const rest = fallback.filter(s => !FALLBACK_PRIORITY_STN_IDS.includes(String(s.stn_id)));
        const fallbackMax = parseInt(process.env.AWS_FALLBACK_MAX || '80', 10);
        const toProcess = [...priority, ...rest].slice(0, fallbackMax);
        if (toProcess.length > 0) {
          console.log(`  [AWS10m] APIHUB RN컬럼 없음 → 공공 API 폴백 ${toProcess.length}개`);
          for (let i = 0; i < toProcess.length; i++) {
            if (i > 0) await new Promise(r => setTimeout(r, 1500));
            const s = toProcess[i];
            try {
              const rn1 = await getAWSRealtime15min(s.stn_id, s.lat, s.lon);
              const { nx, ny } = convertToGrid(s.lat, s.lon);
              const prev = getPrevAwsGridRN1(`${nx},${ny}`);
              const rn15 = (prev != null && rn1 >= prev) ? +(rn1 - prev).toFixed(1) : 0;
              updateAwsGridRN1(`${nx},${ny}`, rn1);
              const hasRain = rn15 > 0 || rn1 > 0;
              const forecastHourly = hasRain ? await getVsrtForecastHourly(nx, ny) : 0;
              saveAwsRainfall(db, s.stn_id, s.name, s.lat, s.lon, rn15, forecastHourly, rn1);
              updated++;
            } catch (e) {
              console.warn(`  [AWS10m] 폴백 ${s.name} 오류:`, e.message);
            }
          }
        }
      }
    }

    console.log(`  [AWS10m] ${updated}개 AWS 관측소 갱신`);
    const synced = await syncAwsToRainfallRealtime();
    if (synced > 0) console.log(`  [AWS10m] → rainfall_realtime 동기화 ${synced}개`);
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
  // 서버 기동 직후 30초에 1회 즉시 실행 → 초기 화면에 수치 표시
  setTimeout(() => runAwsRefresh(), 30 * 1000);
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

// ─── AWS 관측소 기준 폴링 (관측소 이름 기준 알람) ───────────────────────────
async function processAwsStations(label) {
  clearForecastCache();
  // clearVsrtGridCache() 제거: prefetchVsrtForecastGrid() 내부의 tmfc/tmef 변경 감지 +
  // VSRT_MIN_REFRESH_MS 체크가 이미 담당. 매 폴링마다 강제 삭제하면 8분 쿨다운을
  // bypass하여 APIHUB 과호출 → VSRT 실패 → 공공 API 429 → forecast_hourly=0 반환.
  clearAwsCache();
  await fetchAllAwsData();
  await prefetchVsrtForecastGrid();

  // AWS 관측소 → emd/district/metro 매핑 (1회 로드, 알람 emit 시 사용)
  const emdMap = await buildAwsToEmdMap();

  const stations = isAwsCacheAvailable()
    ? getAwsStationsWithRainfall()
    : getAwsStationsForFallback();

  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] [${label}] Processing ${stations.length} AWS stations...`);

  const awsCacheOk = isAwsCacheAvailable();
  console.log(`  [${label}] AWS캐시: ${awsCacheOk ? '사용가능' : '없음(폴백제한)'}`);

  const alarms = [];
  let apiCalls = 0, forecastCalls = 0;

  // AWS 캐시 성공 시: rn15 사용, 공공 API 0회. 실패 시: 폴백 2초 간격 직렬
  const batchDelay = awsCacheOk ? 0 : 2000;
  if (!awsCacheOk) {
    const estMin = Math.round(stations.length * 2 / 60);
    console.log(`  [${label}] APIHUB 없음 → 공공 API 직렬 폴백 (${stations.length}관측소, 약 ${estMin}분 소요)`);
  }

  for (let i = 0; i < stations.length; i++) {
    if (i > 0 && batchDelay > 0) await new Promise(r => setTimeout(r, batchDelay));

    const awsStation = stations[i];
    const { nx, ny } = convertToGrid(awsStation.lat, awsStation.lon);
    const gridKey = `${nx},${ny}`;

    let realtime15min;
    let currentRN1ForDelta = null;

    if (awsCacheOk) {
      realtime15min = awsStation.rn15 ?? getAwsRn15FromCache(awsStation.stn_id, awsStation.lat, awsStation.lon) ?? 0;
    } else {
      currentRN1ForDelta = await getAWSRealtime15min(awsStation.stn_id, awsStation.lat, awsStation.lon);
      apiCalls++;
      const prevRN1 = getPrevAwsGridRN1(gridKey);
      realtime15min = (prevRN1 !== null && prevRN1 !== undefined && currentRN1ForDelta >= prevRN1)
        ? +(currentRN1ForDelta - prevRN1).toFixed(1)
        : 0;
    }

    try {
      const rn60 = awsCacheOk ? (awsStation.rn60 ?? null) : currentRN1ForDelta;
      const alarmResult = await checkAlarmConditionForAwsStation(
        awsStation,
        realtime15min,
        nx,
        ny,
        rn60
      );
      if (alarmResult.forecastCalled) forecastCalls++;

      if (alarmResult.alarm) {
        const emdInfo = findNearestEmd(awsStation.lat, awsStation.lon, emdMap);
        const alarm = {
          stationName: awsStation.name,
          stn_id: awsStation.stn_id,
          realtime15min: alarmResult.realtime15min,
          forecastHourly: alarmResult.forecastHourly,
          timestamp: new Date().toISOString(),
          metroId:    emdInfo?.metro_id    ?? null,
          districtId: emdInfo?.district_id ?? null,
          emdCode:    emdInfo?.emd_code    ?? null,
        };
        alarms.push(alarm);
        await logAwsAlarm(awsStation.stn_id, awsStation.name, alarmResult.realtime15min, alarmResult.forecastHourly);
        emitAlarm(alarm);
        console.log(`  [${label}] ALARM: ${awsStation.name} - 15min: ${alarmResult.realtime15min}mm, forecast: ${alarmResult.forecastHourly}mm`);
      }

      if (!awsCacheOk && currentRN1ForDelta !== null) {
        updateAwsGridRN1(gridKey, currentRN1ForDelta);
      }
    } catch (err) {
      console.error(`  [${label}] Station ${awsStation.name}(${awsStation.stn_id}) error:`, err.message);
    }
  }

  // AWS → rainfall_realtime 동기화 (기존 읍면동 맵 클라이언트용)
  try {
    const synced = await syncAwsToRainfallRealtime();
    if (synced > 0) {
      console.log(`  [${label}] Synced ${synced} weather_stations from AWS → rainfall_realtime`);
    }
  } catch (syncErr) {
    console.error(`  [${label}] Sync error:`, syncErr.message);
  }

  // 오래된 데이터 정리
  try {
    const db = await getDatabase();
    db.prepare("DELETE FROM aws_alarm_logs WHERE timestamp < datetime('now', '-1 hour')").run();
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
    await processAwsStations('Fast');
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
    await processAwsStations('Slow');
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
