#!/usr/bin/env node
/**
 * Step 1~3: AWS 관측소 700개+ 커버리지 확대
 * 1. nph-aws2_stn 좌표 확인
 * 2. aws-stations-fallback.json 731개로 확장
 * 3. 공공데이터 지점정보 API로 보강
 *
 * 실행: node scripts/sync-aws-fallback.js
 * .env: KMA_APIHUB_KEY, KMA_API_KEY, CLOUDFLARE_WORKER_URL, CLOUDFLARE_PROXY_TOKEN
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const APIHUB_BASE = process.env.CLOUDFLARE_WORKER_URL
  ? `${process.env.CLOUDFLARE_WORKER_URL}/kma-apihub`
  : 'https://apihub.kma.go.kr/api/typ01/cgi-bin/url';
const WETHR_BASIC_URL = 'https://apis.data.go.kr/1360000/WethrBasicInfoService';

const headers = process.env.CLOUDFLARE_PROXY_TOKEN
  ? { 'X-Proxy-Token': process.env.CLOUDFLARE_PROXY_TOKEN }
  : {};

function getUrl(base, op, params) {
  const q = new URLSearchParams({ ...params, authKey: process.env.KMA_APIHUB_KEY || '', serviceKey: process.env.KMA_API_KEY || '' });
  return `${base}/${op}?${q}`;
}

async function fetchNphAws2Min() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  let m = kst.getUTCMinutes() - 2;
  let h = kst.getUTCHours();
  if (m < 0) { m += 60; h = (h - 1 + 24) % 24; }
  const tm2 = kst.toISOString().slice(0, 10).replace(/-/g, '') + String(h).padStart(2, '0') + String(m).padStart(2, '0');

  const res = await axios.get(getUrl(APIHUB_BASE, 'nph-aws2_min', { tm2, stn: 0, help: 1, disp: 0 }), {
    timeout: 60000, responseType: 'text', headers,
  });
  return parseAwsText(res.data);
}

async function fetchNphAws2StnOnly() {
  const res = await axios.get(getUrl(APIHUB_BASE, 'nph-aws2_stn', { help: 1 }), {
    timeout: 30000, responseType: 'text', headers,
  });
  return parseAwsText(res.data);
}

/** APIHUB typ02 getAwsStnLstTbl (방재기상관측지점일람표) - nph-aws2_stn 404 시 대체 */
async function fetchAwsStnLstTbl() {
  const typ02Base = process.env.CLOUDFLARE_WORKER_URL
    ? `${process.env.CLOUDFLARE_WORKER_URL}/kma-apihub-typ02`
    : 'https://apihub.kma.go.kr/api/typ02/openApi/AwsYearlyInfoService';
  const url = `${typ02Base}/getAwsStnLstTbl?pageNo=1&numOfRows=1000&dataType=JSON&year=2024&month=03&authKey=${encodeURIComponent(process.env.KMA_APIHUB_KEY || '')}`;
  try {
    const res = await axios.get(url, { timeout: 15000, headers });
    const items = res.data?.response?.body?.items?.item;
    if (!items) return null;
    const itemArr = Array.isArray(items) ? items : [items];
    // 실제 구조: items.item[0].stn_aws.info[]
    const raw = itemArr[0]?.stn_aws?.info ?? itemArr;
    const stations = new Map();
    for (const r of raw) {
      const stnId = String(r.stn_id ?? r.stnId ?? r.station ?? r.STN ?? '').trim();
      if (!stnId || !/^\d+$/.test(stnId)) continue;
      const lat = parseFloat(r.lat ?? r.LAT ?? r.latitude);
      const lon = parseFloat(r.lon ?? r.LNG ?? r.longitude);
      if (isNaN(lat) || isNaN(lon)) continue;
      stations.set(stnId, { stn_id: stnId, name: r.stn_ko ?? r.stnNm ?? r.name ?? stnId, lat, lon });
    }
    return stations.size > 0 ? stations : null;
  } catch (e) {
    console.warn('  [sync] getAwsStnLstTbl 오류:', e.message);
    return null;
  }
}

function parseAwsText(text) {
  const lines = text.split('\n');
  let colStn = -1, colLat = -1, colLon = -1, colName = -1, colRn15 = -1, colRn60 = -1;
  for (const line of lines) {
    if (!line.trim().startsWith('#')) continue;
    const tokens = line.replace(/^#+\s*/, '').toUpperCase().split(/\s+/);
    const stnIdx = tokens.indexOf('STN');
    if (stnIdx < 0) continue;
    tokens.forEach((t, i) => {
      if (t === 'STN' || t === 'ID') colStn = i;
      else if (t === 'LAT') colLat = i;
      else if (t === 'LON' || t === 'LNG') colLon = i;
      else if (/STN_NM|NAME|NM/.test(t)) colName = i;
      else if (/RN[-_]?15|15M/.test(t)) colRn15 = i;
      else if (/RN[-_]?60|60M|RN1/.test(t)) colRn60 = i;
    });
    break;
  }
  if (colStn < 0) return null;
  const stations = new Map();
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const parts = line.trim().split(/\s+/);
    const stn = parts[colStn];
    if (!stn || !/^\d+$/.test(stn)) continue;
    const lat = colLat >= 0 ? parseFloat(parts[colLat]) : NaN;
    const lon = colLon >= 0 ? parseFloat(parts[colLon]) : NaN;
    const name = colName >= 0 ? (parts[colName] || stn) : stn;
    stations.set(stn, {
      stn_id: stn,
      name,
      lat: isNaN(lat) ? null : lat,
      lon: isNaN(lon) ? null : lon,
    });
  }
  return stations;
}

async function fetchPublicApiStations() {
  const key = process.env.KMA_API_KEY;
  if (!key || key.startsWith('your_')) return new Map();
  const base = process.env.CLOUDFLARE_WORKER_URL
    ? `${process.env.CLOUDFLARE_WORKER_URL}/kma-basicinfo`
    : WETHR_BASIC_URL;
  for (const op of ['getAwsObsvStnList', 'getStnList']) {
    try {
      const url = `${base}/${op}`;
      const res = await axios.get(url, {
        params: { serviceKey: key, pageNo: 1, numOfRows: 1000, dataType: 'JSON' },
        timeout: 15000,
        headers,
      });
    const items = res.data?.response?.body?.items?.item;
      if (!items) continue;
      const raw = Array.isArray(items) ? items : [items];
      const map = new Map();
      for (const r of raw) {
        const stnId = String(r.stnId ?? r.stn_id ?? r.STN ?? r.stationId ?? '').trim();
        if (!stnId || !/^\d+$/.test(stnId)) continue;
        const lat = parseFloat(r.lat ?? r.LAT ?? r.latitude ?? r.obsrLat);
        const lon = parseFloat(r.lon ?? r.LNG ?? r.longitude ?? r.obsrLon);
        if (isNaN(lat) || isNaN(lon)) continue;
        map.set(stnId, {
          stn_id: stnId,
          name: r.stnNm ?? r.stnName ?? r.name ?? stnId,
          lat, lon,
        });
      }
      if (map.size > 0) return map;
    } catch (e) {
      console.warn(`  [sync] 공공데이터 ${op} 오류:`, e.message);
    }
  }
  return new Map();
}

async function main() {
  console.log('=== AWS 관측소 fallback 700개+ 확장 ===\n');

  if (!process.env.KMA_APIHUB_KEY || process.env.KMA_APIHUB_KEY.startsWith('여기에')) {
    console.error('KMA_APIHUB_KEY가 .env에 설정되어 있어야 합니다.');
    process.exit(1);
  }

  const existingPath = path.join(__dirname, '..', 'data', 'aws-stations-fallback.json');
  let existing = [];
  if (fs.existsSync(existingPath)) {
    existing = JSON.parse(fs.readFileSync(existingPath, 'utf-8'));
    console.log(`기존 fallback: ${existing.length}개`);
  }

  const existingMap = new Map(existing.map(s => [String(s.stn_id), s]));

  // Step 1: typ02 getAwsStnLstTbl (승인 시 700+ 좌표) → nph-aws2_stn 폴백
  console.log('\n[Step 1] typ02 getAwsStnLstTbl 좌표 확인...');
  let stnCoords = null;
  try {
    stnCoords = await fetchAwsStnLstTbl();
    if (stnCoords) {
      const withCoords = [...stnCoords.values()].filter(s => s.lat != null && s.lon != null);
      console.log(`  typ02: ${stnCoords.size}개 (좌표 ${withCoords.length}개)`);
    }
  } catch (e) {
    console.warn('  getAwsStnLstTbl 오류:', e.message);
  }
  if (!stnCoords || stnCoords.size < 100) {
    console.log('  → nph-aws2_stn 폴백 시도...');
    try {
      const stn = await fetchNphAws2StnOnly();
      if (stn && stn.size > 0) {
        stnCoords = stn;
        const withCoords = [...stnCoords.values()].filter(s => s.lat != null && s.lon != null);
        console.log(`  nph-aws2_stn: ${stnCoords.size}개 (좌표 ${withCoords.length}개)`);
      }
    } catch (e) {
      console.warn('  nph-aws2_stn 오류:', e.message);
    }
  }

  // nph-aws2_min (731개 stn_id 목록)
  console.log('\n[Step 2] nph-aws2_min 관측소 목록...');
  let minStations = null;
  try {
    minStations = await fetchNphAws2Min();
    if (minStations) console.log(`  total: ${minStations.size}개`);
  } catch (e) {
    console.warn('  nph-aws2_min 오류:', e.message);
  }

  // Step 3: 공공데이터 API
  console.log('\n[Step 3] 공공데이터 지점정보 API...');
  let publicStations = new Map();
  try {
    publicStations = await fetchPublicApiStations();
    if (publicStations.size > 0) console.log(`  total: ${publicStations.size}개`);
  } catch (e) {
    console.warn('  공공데이터 API 오류:', e.message);
  }

  // Merge: min 목록 기준, 좌표는 stn > public > existing 순
  const stnIds = minStations ? [...minStations.keys()] : [...existingMap.keys(), ...publicStations.keys()];
  const uniqueIds = [...new Set(stnIds)];
  const merged = [];

  for (const stnId of uniqueIds) {
    let entry = stnCoords?.get(stnId) || publicStations.get(stnId) || existingMap.get(stnId);
    if (!entry) entry = { stn_id: stnId, name: `관측소${stnId}`, lat: null, lon: null };
    if (entry.lat != null && entry.lon != null) {
      merged.push({
        stn_id: String(entry.stn_id),
        name: entry.name || `관측소${stnId}`,
        lat: entry.lat,
        lon: entry.lon,
      });
    }
  }

  merged.sort((a, b) => parseInt(a.stn_id) - parseInt(b.stn_id));
  const outPath = path.join(__dirname, '..', 'data', 'aws-stations-fallback.json');
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf-8');

  console.log(`\n✅ 완료: ${merged.length}개 → ${outPath}`);
  if (merged.length >= 700) {
    console.log('✅ 700개 이상 커버리지 달성');
  } else {
    console.log(`⚠️ ${merged.length}개 (700개 미만). 공공데이터 API 활용 승인 또는 nph-aws2_stn 형식 확인 필요`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
