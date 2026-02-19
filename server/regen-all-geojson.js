/**
 * 모든 시군구 GeoJSON을 실제 지리 좌표 기반 직사각형 격자로 재생성
 * - district-coords.js의 실제 좌표 사용
 * - 세종시: 20개 읍면동을 하나의 통합 격자로 생성
 * - 기타: 시군구별 읍면동 직사각형 격자 테셀레이션
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, getDatabase } from './config/database.js';
import DISTRICT_COORDS from './district-coords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const geoDir = path.join(__dirname, '..', 'data', 'geojson');

function seededRandom(seed) {
  let s = Math.abs(seed) || 1;
  return function () {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateRectGrid(centerLat, centerLon, rows, cols, cellW, cellH, seed) {
  const rand = seededRandom(seed);
  const startLon = centerLon - (cols * cellW) / 2;
  const startLat = centerLat + (rows * cellH) / 2;

  const pts = [];
  for (let r = 0; r <= rows; r++) {
    pts[r] = [];
    for (let c = 0; c <= cols; c++) {
      const isEdge = r === 0 || r === rows || c === 0 || c === cols;
      const jLat = isEdge ? 0 : (rand() - 0.5) * cellH * 0.22;
      const jLon = isEdge ? 0 : (rand() - 0.5) * cellW * 0.22;
      pts[r][c] = [
        +(startLon + c * cellW + jLon).toFixed(6),
        +(startLat - r * cellH + jLat).toFixed(6),
      ];
    }
  }

  const polygons = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tl = pts[r][c];
      const tr = pts[r][c + 1];
      const br = pts[r + 1][c + 1];
      const bl = pts[r + 1][c];
      polygons.push([tl, tr, br, bl, tl]);
    }
  }
  return polygons;
}

// ====== 세종시 실제 좌표 ======
const SEJONG_REAL = {
  '36110': { name: '조치원읍', lat: 36.601, lon: 127.001 },
  '36120': { name: '연기면',  lat: 36.556, lon: 127.034 },
  '36130': { name: '연동면',  lat: 36.560, lon: 126.945 },
  '36140': { name: '부강면',  lat: 36.527, lon: 127.144 },
  '36150': { name: '금남면',  lat: 36.470, lon: 127.080 },
  '36160': { name: '장군면',  lat: 36.420, lon: 127.050 },
  '36170': { name: '연서면',  lat: 36.482, lon: 126.955 },
  '36180': { name: '전의면',  lat: 36.530, lon: 126.920 },
  '36190': { name: '전동면',  lat: 36.450, lon: 127.010 },
  '36200': { name: '소정면',  lat: 36.600, lon: 126.940 },
  '36310': { name: '한솔동',  lat: 36.510, lon: 127.060 },
  '36320': { name: '새롬동',  lat: 36.498, lon: 127.048 },
  '36330': { name: '도담동',  lat: 36.508, lon: 127.078 },
  '36340': { name: '아름동',  lat: 36.490, lon: 127.062 },
  '36350': { name: '종촌동',  lat: 36.515, lon: 127.045 },
  '36360': { name: '고운동',  lat: 36.485, lon: 127.082 },
  '36370': { name: '보람동',  lat: 36.478, lon: 127.055 },
  '36380': { name: '대평동',  lat: 36.520, lon: 127.038 },
  '36390': { name: '소담동',  lat: 36.502, lon: 127.070 },
  '36400': { name: '반곡동',  lat: 36.468, lon: 127.068 },
};

function generateSejong(db) {
  const ROWS = 4, COLS = 5;
  const codes = Object.keys(SEJONG_REAL);
  const sorted = codes
    .map(code => ({ code, ...SEJONG_REAL[code] }))
    .sort((a, b) => b.lat - a.lat);

  const rowGroups = [];
  for (let i = 0; i < ROWS; i++) {
    const group = sorted.slice(i * COLS, (i + 1) * COLS);
    group.sort((a, b) => a.lon - b.lon);
    rowGroups.push(group);
  }

  const allLats = codes.map(c => SEJONG_REAL[c].lat);
  const allLons = codes.map(c => SEJONG_REAL[c].lon);
  const pad = 0.035;
  const minLat = Math.min(...allLats) - pad;
  const maxLat = Math.max(...allLats) + pad;
  const minLon = Math.min(...allLons) - pad;
  const maxLon = Math.max(...allLons) + pad;

  const cellW = (maxLon - minLon) / COLS;
  const cellH = (maxLat - minLat) / ROWS;
  const rand = seededRandom(36000);

  const pts = [];
  for (let r = 0; r <= ROWS; r++) {
    pts[r] = [];
    for (let c = 0; c <= COLS; c++) {
      const isEdge = r === 0 || r === ROWS || c === 0 || c === COLS;
      const jLat = isEdge ? 0 : (rand() - 0.5) * cellH * 0.18;
      const jLon = isEdge ? 0 : (rand() - 0.5) * cellW * 0.18;
      pts[r][c] = [
        +(minLon + c * cellW + jLon).toFixed(6),
        +(maxLat - r * cellH + jLat).toFixed(6),
      ];
    }
  }

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const area = rowGroups[r][c];
      if (!area) continue;

      const tl = pts[r][c];
      const tr = pts[r][c + 1];
      const br = pts[r + 1][c + 1];
      const bl = pts[r + 1][c];

      const dist = db.prepare('SELECT id FROM districts WHERE code = ?').get(area.code);
      const emd = db.prepare('SELECT code, name FROM emds WHERE district_id = ? LIMIT 1').get(dist.id);

      const geojson = {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { EMD_CD: emd.code, EMD_NM: emd.name },
          geometry: { type: 'Polygon', coordinates: [[tl, tr, br, bl, tl]] },
        }],
      };

      fs.writeFileSync(path.join(geoDir, `${area.code}.json`), JSON.stringify(geojson));
    }
  }

  console.log(`세종시: ${ROWS}x${COLS} 통합 격자 (${cellW.toFixed(3)} x ${cellH.toFixed(3)}/셀)`);
  for (let r = 0; r < ROWS; r++) {
    console.log(`  행${r}: ${rowGroups[r].map(a => a.name.padEnd(5)).join(' | ')}`);
  }
}

async function main() {
  await initDatabase();
  const db = await getDatabase();

  const districts = db.prepare(
    'SELECT d.*, m.code as metro_code FROM districts d JOIN metros m ON d.metro_id = m.id ORDER BY d.code'
  ).all();
  console.log(`Processing ${districts.length} districts...`);

  // 1. 세종시 통합 격자
  console.log('\n=== 세종시 ===');
  generateSejong(db);

  // 2. 나머지 시군구
  const sejongCodes = new Set(Object.keys(SEJONG_REAL));
  let updated = 0;
  let missing = 0;

  for (const dist of districts) {
    if (sejongCodes.has(dist.code)) continue;

    const emds = db.prepare('SELECT * FROM emds WHERE district_id = ? ORDER BY code').all(dist.id);
    if (emds.length === 0) continue;

    const coords = DISTRICT_COORDS[dist.code];
    if (!coords) {
      console.warn(`  좌표 없음: ${dist.code} ${dist.name}`);
      missing++;
      continue;
    }

    const [centerLat, centerLon] = coords;

    // 셀 크기 결정
    const isGun = dist.name.endsWith('군');
    const subCode = parseInt(dist.code.substring(2, 5));
    const isEup = !isGun && subCode >= 700; // 시 소속 읍면 지역
    const isUrban = !isGun && !isEup;

    const cellW = isUrban ? 0.010 : 0.016;
    const cellH = isUrban ? 0.008 : 0.013;

    const count = emds.length;
    const cols = Math.ceil(Math.sqrt(count * 1.3));
    const rows = Math.ceil(count / cols);

    const polygons = generateRectGrid(centerLat, centerLon, rows, cols, cellW, cellH, parseInt(dist.code));

    const features = [];
    for (let i = 0; i < emds.length && i < polygons.length; i++) {
      features.push({
        type: 'Feature',
        properties: { EMD_CD: emds[i].code, EMD_NM: emds[i].name },
        geometry: { type: 'Polygon', coordinates: [polygons[i]] },
      });
    }

    fs.writeFileSync(
      path.join(geoDir, `${dist.code}.json`),
      JSON.stringify({ type: 'FeatureCollection', features })
    );
    updated++;
  }

  console.log(`\n일반 시군구: ${updated}개 갱신, ${missing}개 좌표 누락`);

  // 검증
  const VERIFY = {
    '서울 종로구':   [37.573, 126.979, '11110'],
    '서울 강남구':   [37.517, 127.047, '11680'],
    '부산 해운대구':  [35.163, 129.164, '26350'],
    '인천 남동구':   [37.449, 126.731, '28200'],
    '대전 유성구':   [36.362, 127.356, '30200'],
    '광주 광산구':   [35.160, 126.793, '29200'],
    '대구 수성구':   [35.858, 128.632, '27260'],
    '경기 수원 장안구':[37.300, 127.008, '41111'],
    '제주 제주시':   [33.500, 126.531, '50110'],
  };

  console.log('\n=== 좌표 검증 ===');
  for (const [label, [realLat, realLon, code]] of Object.entries(VERIFY)) {
    const geoPath = path.join(geoDir, `${code}.json`);
    if (!fs.existsSync(geoPath)) { console.log(`NG ${label} - no file`); continue; }
    const geo = JSON.parse(fs.readFileSync(geoPath, 'utf-8'));
    const allCoords = geo.features.flatMap(f => f.geometry.coordinates[0]);
    const lons = allCoords.map(c => c[0]);
    const lats = allCoords.map(c => c[1]);
    const geoLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const geoLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const dLat = Math.abs(geoLat - realLat);
    const dLon = Math.abs(geoLon - realLon);
    const ok = dLat < 0.05 && dLon < 0.05;
    console.log(
      `${ok ? 'OK' : 'NG'} ${label.padEnd(16)}`,
      `real: ${realLat.toFixed(3)},${realLon.toFixed(3)}`,
      `geo: ${geoLat.toFixed(3)},${geoLon.toFixed(3)}`,
      `diff: ${dLat.toFixed(3)},${dLon.toFixed(3)}`
    );
  }
}

main().catch(console.error);
