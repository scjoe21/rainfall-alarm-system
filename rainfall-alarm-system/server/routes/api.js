import { Router } from 'express';
import { getDatabase } from '../config/database.js';
import alarmService from '../services/alarmService.js';
import { getCurrentAlertState } from '../services/weatherAlertService.js';
import { getApiUsage, isAwsCacheAvailable } from '../services/kmaAPI.js';
import { emitAlarm } from '../websocket.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();
const MAX_LIMIT = 100;

// API/연결 진단 (실측치 미표시 시 원인 파악용)
router.get('/status', async (req, res) => {
  const db = await getDatabase();
  const awsCount = db.prepare(
    "SELECT COUNT(*) as c FROM aws_rainfall WHERE updated_at >= datetime('now', '-60 minutes')"
  ).get()?.c ?? 0;
  const rrCount = db.prepare(
    "SELECT COUNT(*) as c FROM rainfall_realtime WHERE timestamp >= datetime('now', '-60 minutes')"
  ).get()?.c ?? 0;
  const wsCount = db.prepare('SELECT COUNT(*) as c FROM weather_stations').get()?.c ?? 0;

  const hasKmaKey = !!process.env.KMA_API_KEY && !process.env.KMA_API_KEY.startsWith('your_');
  const hasApihubKey = !!process.env.KMA_APIHUB_KEY && !process.env.KMA_APIHUB_KEY.startsWith('여기에');
  const hasWorkerUrl = !!process.env.CLOUDFLARE_WORKER_URL;
  const region = process.env.FLY_REGION || 'unknown';

  // 공공 API 실제 연결 테스트 (서울 격자 1회)
  let apiTest = null;
  if (hasKmaKey && req.query.test === '1') {
    try {
      const { getAWSRealtime15min } = await import('../services/kmaAPI.js');
      const rn1 = await getAWSRealtime15min('108', 37.571, 126.966);
      apiTest = { ok: true, rn1, message: '공공 API 연결 성공' };
    } catch (e) {
      apiTest = { ok: false, error: e.message, message: '공공 API 실패 - IP 제한 또는 키 오류 가능' };
    }
  }

  res.json({
    config: {
      KMA_API_KEY: hasKmaKey ? 'ok' : 'missing',
      KMA_APIHUB_KEY: hasApihubKey ? 'ok' : 'missing',
      CLOUDFLARE_WORKER_URL: hasWorkerUrl ? 'ok' : 'missing',
      FLY_REGION: region,
      MOCK_MODE: process.env.MOCK_MODE === 'true',
    },
    data: {
      aws_rainfall_1h: awsCount,
      rainfall_realtime_1h: rrCount,
      weather_stations: wsCount,
      aws_cache_available: isAwsCacheAvailable(),
    },
    apiTest,
    hint: !hasWorkerUrl
      ? 'CLOUDFLARE_WORKER_URL을 설정하여 기상청 API 프록시(한국 PoP 경유)를 사용하세요. worker/ 폴더에서 wrangler deploy 후 URL을 설정합니다.'
      : null,
  });
});

// 기상특보 상태 조회
router.get('/alert-status', (req, res) => {
  res.json(getCurrentAlertState());
});

// API 사용량 조회
router.get('/api-usage', (req, res) => {
  res.json(getApiUsage());
});

// 광역자치단체 목록 (알람 카운트 포함)
router.get('/metros', async (req, res) => {
  const db = await getDatabase();
  const metros = db.prepare(`
    SELECT m.*,
      (SELECT COUNT(al.id) FROM alarm_logs al
       JOIN emds e ON al.emd_id = e.id
       JOIN districts d ON e.district_id = d.id
       WHERE d.metro_id = m.id
         AND al.timestamp > datetime('now', '-1 hour')
      ) as alarm_count
    FROM metros m
    ORDER BY m.code
  `).all();
  res.json(metros);
});

// 기초자치단체 목록
router.get('/metros/:metroId/districts', async (req, res) => {
  const db = await getDatabase();
  const districts = db.prepare(
    'SELECT * FROM districts WHERE metro_id = ? ORDER BY name'
  ).all(Number(req.params.metroId));
  res.json(districts);
});

// 기초자치단체별 알람 카운트
router.get('/metros/:metroId/alarm-counts', async (req, res) => {
  const counts = await alarmService.getAlarmCountsByMetro(Number(req.params.metroId));
  res.json(counts);
});

// 광역 전체 읍면동 GeoJSON (세종 등 직접 지도 모드)
router.get('/geojson/metro/:metroId', async (req, res) => {
  const db = await getDatabase();
  const districts = db.prepare('SELECT id, code FROM districts WHERE metro_id = ?').all(Number(req.params.metroId));
  if (!districts.length) return res.status(404).json({ error: 'No districts found' });

  const allFeatures = [];
  for (const district of districts) {
    // GeoJSON 파일에서 Polygon 로드
    const geoPath = path.join(__dirname, '..', '..', 'data', 'geojson', `${district.code}.json`);
    if (fs.existsSync(geoPath)) {
      const geojson = JSON.parse(fs.readFileSync(geoPath, 'utf-8'));
      if (geojson.features) {
        allFeatures.push(...geojson.features);
      }
    } else {
      // 파일 없으면 DB fallback (Point)
      const emds = db.prepare('SELECT * FROM emds WHERE district_id = ?').all(district.id);
      for (const emd of emds) {
        const station = db.prepare('SELECT lat, lon FROM weather_stations WHERE emd_id = ?').get(emd.id);
        if (station) {
          allFeatures.push({
            type: 'Feature',
            properties: { EMD_CD: emd.code, EMD_NM: emd.name },
            geometry: { type: 'Point', coordinates: [station.lon, station.lat] },
          });
        }
      }
    }
  }
  res.json({ type: 'FeatureCollection', features: allFeatures });
});

// 광역 전체 강우량 (세종 등)
router.get('/rainfall/metro/:metroId', async (req, res) => {
  const db = await getDatabase();
  const districts = db.prepare('SELECT id FROM districts WHERE metro_id = ?').all(Number(req.params.metroId));
  const allData = [];
  for (const district of districts) {
    const data = await alarmService.getLatestRainfallByDistrict(district.id);
    allData.push(...data);
  }
  res.json(allData);
});

// 광역 전체 알람 이력 (세종 등)
router.get('/alarms/metro/:metroId', async (req, res) => {
  const db = await getDatabase();
  const limit = Math.min(parseInt(req.query.limit) || 20, MAX_LIMIT);
  const rows = db.prepare(`
    SELECT al.*, e.name as emd_name, e.code as emd_code
    FROM alarm_logs al
    JOIN emds e ON al.emd_id = e.id
    JOIN districts d ON e.district_id = d.id
    WHERE d.metro_id = ?
    ORDER BY al.timestamp DESC
    LIMIT ?
  `).all(Number(req.params.metroId), limit);
  res.json(rows);
});

// 읍면동 GeoJSON
router.get('/geojson/district/:districtId', async (req, res) => {
  const db = await getDatabase();
  const district = db.prepare('SELECT code FROM districts WHERE id = ?').get(Number(req.params.districtId));
  if (!district) return res.status(404).json({ error: 'District not found' });

  // Try to load from file
  const geoPath = path.join(__dirname, '..', '..', 'data', 'geojson', `${district.code}.json`);
  if (fs.existsSync(geoPath)) {
    const geojson = JSON.parse(fs.readFileSync(geoPath, 'utf-8'));
    return res.json(geojson);
  }

  // Generate from DB emds data
  const emds = db.prepare(
    'SELECT * FROM emds WHERE district_id = ?'
  ).all(Number(req.params.districtId));

  const features = emds.map(emd => {
    const station = db.prepare(
      'SELECT lat, lon FROM weather_stations WHERE emd_id = ?'
    ).get(emd.id);

    return {
      type: 'Feature',
      properties: {
        EMD_CD: emd.code,
        EMD_NM: emd.name,
      },
      geometry: station
        ? { type: 'Point', coordinates: [station.lon, station.lat] }
        : null,
    };
  }).filter(f => f.geometry);

  res.json({ type: 'FeatureCollection', features });
});

// 읍면동별 현재 강우량
router.get('/rainfall/district/:districtId', async (req, res) => {
  const data = await alarmService.getLatestRainfallByDistrict(Number(req.params.districtId));
  res.json(data);
});

// AWS 관측소별 현재 강우량 (관측소 이름 기준)
router.get('/rainfall/aws-stations', async (req, res) => {
  const data = await alarmService.getLatestRainfallByAwsStation();
  res.json(data);
});

// AWS 관측소 알람 이력
router.get('/alarms/aws', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_LIMIT);
  const rows = await alarmService.getAwsAlarmLogs(limit);
  res.json(rows);
});

// 알람 이력
router.get('/alarms/:districtId', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, MAX_LIMIT);
  const alarms = await alarmService.getAlarmsByDistrict(Number(req.params.districtId), limit);
  res.json(alarms);
});

// 읍면동 목록
router.get('/districts/:districtId/emds', async (req, res) => {
  const db = await getDatabase();
  const emds = db.prepare(
    'SELECT * FROM emds WHERE district_id = ? ORDER BY name'
  ).all(Number(req.params.districtId));
  res.json(emds);
});

// 개발용: 특정 읍면동에 강제 알람 트리거 (production에서 비활성화)
// POST /api/debug/trigger-alarm
// body: { emdCode, districtId, realtime?, forecast? }
router.post('/debug/trigger-alarm', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Forbidden in production' });
  }

  const { emdCode, districtId, realtime = 25, forecast = 60 } = req.body;
  if (!emdCode || !districtId) {
    return res.status(400).json({ error: 'emdCode and districtId are required' });
  }

  emitAlarm({
    emdCode,
    districtId: Number(districtId),
    realtime15min: realtime,
    forecastHourly: forecast,
  });

  res.json({ ok: true, triggered: { emdCode, districtId, realtime15min: realtime, forecastHourly: forecast } });
});

// 알람 로그 전체 초기화 (허위 알람 발생 시 수동 정리용)
// POST /api/debug/clear-alarms
router.post('/debug/clear-alarms', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Forbidden in production' });
  }
  const db = await getDatabase();
  db.prepare('DELETE FROM alarm_logs').run();
  console.log('[Debug] alarm_logs cleared by manual request');
  res.json({ ok: true, message: 'All alarm_logs cleared' });
});

export default router;
