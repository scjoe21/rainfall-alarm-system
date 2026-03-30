#!/usr/bin/env node
/**
 * Step 1: nph-aws2_stn 좌표 제공 개수 확인
 * 실행: node scripts/verify-aws-coverage.js
 * .env의 KMA_APIHUB_KEY, CLOUDFLARE_WORKER_URL, CLOUDFLARE_PROXY_TOKEN 필요
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const APIHUB_BASE = process.env.CLOUDFLARE_WORKER_URL
  ? `${process.env.CLOUDFLARE_WORKER_URL}/kma-apihub`
  : 'https://apihub.kma.go.kr/api/typ01/cgi-bin/url';

function getUrl(operation, params) {
  const q = new URLSearchParams({ ...params, authKey: process.env.KMA_APIHUB_KEY || '' });
  return `${APIHUB_BASE}/${operation}?${q}`;
}

async function main() {
  console.log('=== Step 1: nph-aws2_stn 좌표 제공 개수 확인 ===\n');

  if (!process.env.KMA_APIHUB_KEY || process.env.KMA_APIHUB_KEY.startsWith('여기에')) {
    console.error('KMA_APIHUB_KEY가 .env에 설정되어 있어야 합니다.');
    process.exit(1);
  }

  const headers = process.env.CLOUDFLARE_PROXY_TOKEN
    ? { 'X-Proxy-Token': process.env.CLOUDFLARE_PROXY_TOKEN }
    : {};

  try {
    // nph-aws2_stn
    console.log('1. nph-aws2_stn fetch 중...');
    const stnRes = await axios.get(getUrl('nph-aws2_stn', { help: 1 }), {
      timeout: 30000,
      responseType: 'text',
      headers,
    });
    const stnLines = (stnRes.data || '').split('\n').filter(Boolean);
    const stnDataLines = stnLines.filter(l => !l.trim().startsWith('#'));
    const stnHeader = stnLines.find(l => l.includes('STN') && l.includes('#'));

    // 헤더에서 컬럼 인덱스 파악
    const headerTokens = (stnHeader || '').replace(/^#+\s*/, '').toUpperCase().split(/\s+/);
    const colStn = headerTokens.findIndex(t => t === 'STN' || t === 'ID');
    const colLat = headerTokens.findIndex(t => t === 'LAT');
    const colLon = headerTokens.findIndex(t => t === 'LON' || t === 'LNG');
    const colName = headerTokens.findIndex(t => /STN_NM|NAME|NM/.test(t));

    let withCoords = 0;
    const stations = new Map();
    for (const line of stnDataLines) {
      const parts = line.trim().split(/\s+/);
      const stnId = colStn >= 0 ? parts[colStn] : null;
      if (!stnId || !/^\d+$/.test(stnId)) continue;
      const lat = colLat >= 0 ? parseFloat(parts[colLat]) : NaN;
      const lon = colLon >= 0 ? parseFloat(parts[colLon]) : NaN;
      const name = colName >= 0 ? parts[colName] : stnId;
      if (!isNaN(lat) && !isNaN(lon)) {
        withCoords++;
        stations.set(stnId, { stn_id: stnId, name, lat, lon });
      }
    }

    console.log(`   totalStations: ${stations.size}`);
    console.log(`   withCoords: ${withCoords}`);
    console.log(`   header: ${(stnHeader || '').substring(0, 120)}...`);
    console.log(`   colStn=${colStn}, colLat=${colLat}, colLon=${colLon}`);

    if (withCoords >= 700) {
      console.log('\n✅ nph-aws2_stn: 700개 이상 좌표 제공 확인됨');
    } else {
      console.log(`\n⚠️ nph-aws2_stn: 좌표 ${withCoords}개 (700개 미만). aws-stations-fallback 확장 필요`);
    }

    // nph-aws2_min (참고)
    console.log('\n2. nph-aws2_min (참고) fetch 중...');
    const tm = new Date();
    const kst = new Date(tm.getTime() + 9 * 60 * 60 * 1000);
    let m = kst.getUTCMinutes() - 2;
    let h = kst.getUTCHours();
    if (m < 0) { m += 60; h = (h - 1 + 24) % 24; }
    const tm2 = kst.toISOString().slice(0, 10).replace(/-/g, '') + String(h).padStart(2, '0') + String(m).padStart(2, '0');

    const minRes = await axios.get(getUrl('nph-aws2_min', { tm2, stn: 0, help: 1, disp: 0 }), {
      timeout: 60000,
      responseType: 'text',
      headers,
    });
    const minParsed = parseAwsMin(minRes.data);
    console.log(`   nph-aws2_min totalStations: ${minParsed?.size ?? 0}`);

    // Step 1 결과를 JSON으로 출력 (Step 2에서 사용)
    const result = { nph_aws2_stn: { total: stations.size, withCoords }, nph_aws2_min: minParsed?.size ?? 0, stations: [...stations.values()] };
    const fs = await import('fs');
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'aws-stn-coords-verified.json'), JSON.stringify(result, null, 2), 'utf-8');
    console.log('\n결과 저장: data/aws-stn-coords-verified.json');

  } catch (err) {
    console.error('오류:', err.message);
    if (err.response) console.error('  status:', err.response.status);
    process.exit(1);
  }
}

function parseAwsMin(text) {
  const lines = text.split('\n');
  let colStn = -1;
  for (const line of lines) {
    if (!line.trim().startsWith('#')) continue;
    const tokens = line.replace(/^#+\s*/, '').toUpperCase().split(/\s+/);
    const idx = tokens.indexOf('STN');
    if (idx >= 0) { colStn = idx; break; }
  }
  if (colStn < 0) return null;
  const stations = new Map();
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const parts = line.trim().split(/\s+/);
    const stn = parts[colStn];
    if (stn && /^\d+$/.test(stn)) stations.set(stn, {});
  }
  return stations;
}

main();
