/**
 * 전체 시군구에 대해 읍면동 + GeoJSON + 관측소를 자동 생성
 * 기존 수동 시드(종로구, 강남구, 해운대구, 세종, 제주, 광산구)는 유지하고
 * 나머지 빈 시군구를 채움
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { initDatabase, getDatabase } from './config/database.js';

// 광역별 대략적 중심 좌표
const METRO_CENTERS = {
  '11': [37.5665, 126.978],
  '26': [35.1796, 129.0756],
  '27': [35.8714, 128.6014],
  '28': [37.4563, 126.7052],
  '29': [35.1595, 126.8526],
  '30': [36.3504, 127.3845],
  '31': [35.5384, 129.3114],
  '36': [36.4800, 127.2590],
  '41': [37.2750, 127.0095],
  '42': [37.8228, 128.1555],
  '43': [36.6357, 127.4917],
  '44': [36.5184, 126.8000],
  '45': [35.8203, 127.1089],
  '46': [34.8161, 126.4629],
  '47': [36.4919, 128.8889],
  '48': [35.4606, 128.2132],
  '50': [33.4996, 126.5312],
};

// 시군구별 대략적 오프셋 (같은 광역 내 구분)
function getDistrictCenter(code) {
  const metro = code.substring(0, 2);
  const base = METRO_CENTERS[metro] || [36.5, 127.0];
  // code의 3~5자리로 약간의 오프셋
  const sub = parseInt(code.substring(2, 5)) || 100;
  const seed = sub * 137;
  const latOff = ((seed % 100) - 50) * 0.003;
  const lonOff = (((seed * 7) % 100) - 50) * 0.003;
  return [base[0] + latOff, base[1] + lonOff];
}

// 동 이름 생성용 접미사
const DONG_SUFFIXES_URBAN = ['동', '1동', '2동', '3동'];
const DONG_PREFIXES = [
  '중앙','신흥','태평','수진','단대','산성','양지','복정','위례',
  '창곡','신장','상대원','하대원','도촌','금광','은행','야탑',
  '이매','서현','정자','수내','구미','운중','백현','삼평','판교',
  '성남','분당','율','매','봉','학','송','죽','화','장','대',
  '북','남','동','서','상','하','내','외','원','신','고','평',
  '안','용','청','풍','월','산','수','금','옥','영','광','명',
  '도','진','성','강','천','석','백','운','미','한','온','새',
  '율동','매송','봉담','학현','송산','죽전','화성','장안',
  '대덕','북양','남창','동백','서농','상현','하남','내삼',
];

// 읍면 이름
const EUP_MYEON_NAMES = [
  '일읍','이읍','삼읍','중앙읍',
  '동면','서면','남면','북면','상면','하면','내면','외면',
  '신북면','신남면','신서면','신동면','원북면','원남면',
];

function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// 불규칙 다각형 테셀레이션 생성
function generateTessellation(centerLat, centerLon, count, districtCode) {
  const rand = seededRandom(parseInt(districtCode) || 12345);
  const isUrban = parseInt(districtCode.substring(2, 5)) < 500; // 구 = urban, 군 = rural
  const spread = isUrban ? 0.02 : 0.04; // 도시는 좁게, 시골은 넓게

  // 점들을 원형으로 배치 후 Voronoi 근사
  const centers = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + rand() * 0.5;
    const r = spread * (0.3 + rand() * 0.7);
    centers.push([
      centerLat + r * Math.cos(angle),
      centerLon + r * Math.sin(angle) * 1.2, // 경도 보정
    ]);
  }

  // 각 center에 대해 주변 점을 이용하여 다각형 생성
  const polygons = [];
  for (let i = 0; i < count; i++) {
    const [cLat, cLon] = centers[i];
    const vertices = [];
    const sides = 5 + Math.floor(rand() * 4); // 5~8각형

    for (let j = 0; j < sides; j++) {
      const angle = (j / sides) * Math.PI * 2 + rand() * 0.3;
      const r = spread * (0.15 + rand() * 0.2);
      vertices.push([
        +(cLon + r * Math.sin(angle) * 1.2).toFixed(6),
        +(cLat + r * Math.cos(angle)).toFixed(6),
      ]);
    }
    // Close polygon
    vertices.push(vertices[0]);
    polygons.push(vertices);
  }

  return { centers, polygons };
}

// 그리드 기반 테셀레이션 (빈틈 없이 맞물림)
function generateGridTessellation(centerLat, centerLon, rows, cols, districtCode) {
  const rand = seededRandom(parseInt(districtCode) || 12345);
  const isUrban = parseInt(districtCode.substring(2, 5)) < 500;
  const cellW = isUrban ? 0.008 : 0.015;
  const cellH = isUrban ? 0.006 : 0.012;

  const startLat = centerLat - (rows * cellH) / 2;
  const startLon = centerLon - (cols * cellW) / 2;

  // 격자 점 생성 (jitter 추가)
  const pts = [];
  for (let r = 0; r <= rows; r++) {
    pts[r] = [];
    for (let c = 0; c <= cols; c++) {
      const isEdge = r === 0 || r === rows || c === 0 || c === cols;
      const jitLat = isEdge ? 0 : (rand() - 0.5) * cellH * 0.4;
      const jitLon = isEdge ? 0 : (rand() - 0.5) * cellW * 0.4;
      pts[r][c] = [
        +(startLat + r * cellH + jitLat).toFixed(6),
        +(startLon + c * cellW + jitLon).toFixed(6),
      ];
    }
  }

  // 각 셀을 폴리곤으로
  const polygons = [];
  const cellCenters = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tl = pts[r][c];
      const tr = pts[r][c + 1];
      const br = pts[r + 1][c + 1];
      const bl = pts[r + 1][c];
      polygons.push([
        [tl[1], tl[0]],
        [tr[1], tr[0]],
        [br[1], br[0]],
        [bl[1], bl[0]],
        [tl[1], tl[0]], // close
      ]);
      cellCenters.push([
        (tl[0] + br[0]) / 2,
        (tl[1] + br[1]) / 2,
      ]);
    }
  }

  return { polygons, centers: cellCenters };
}

async function main() {
  await initDatabase();
  const db = await getDatabase();
  const geoDir = path.join(__dirname, '..', 'data', 'geojson');

  // 모든 district 로드
  const districts = db.prepare('SELECT * FROM districts ORDER BY id').all();
  console.log(`Total districts: ${districts.length}`);

  let emdId = 70000; // 기존 시드와 겹치지 않게
  let stnId = 100;
  let newEmds = 0;
  let newStns = 0;
  let newGeo = 0;

  for (const dist of districts) {
    // 이미 EMD가 있는지 확인
    const existingEmds = db.prepare('SELECT COUNT(*) as cnt FROM emds WHERE district_id = ?').get(dist.id);
    if (existingEmds.cnt > 0) {
      // 이미 GeoJSON이 있는지도 확인
      const geoPath = path.join(geoDir, `${dist.code}.json`);
      if (fs.existsSync(geoPath)) {
        continue; // 완전히 준비됨
      }
    }

    const [centerLat, centerLon] = getDistrictCenter(dist.code);
    const metroCode = dist.code.substring(0, 2);
    const subCode = parseInt(dist.code.substring(2, 5));
    const isGun = dist.name.endsWith('군'); // 군 = 읍면 체계
    const isUrban = !isGun && subCode < 500;

    // 동/읍면 개수 결정
    let emdCount;
    if (isGun) {
      emdCount = 6 + Math.floor(seededRandom(parseInt(dist.code))() * 6); // 6~11
    } else {
      emdCount = 8 + Math.floor(seededRandom(parseInt(dist.code))() * 10); // 8~17
    }

    // 그리드 크기 계산
    const cols = Math.ceil(Math.sqrt(emdCount * 1.3));
    const rows = Math.ceil(emdCount / cols);
    const actualCount = rows * cols;

    // 테셀레이션 생성
    const { polygons, centers } = generateGridTessellation(centerLat, centerLon, rows, cols, dist.code);

    // EMD 이름 생성
    const rand = seededRandom(parseInt(dist.code) * 31);
    const emdNames = [];
    const usedPrefixes = new Set();

    for (let i = 0; i < actualCount; i++) {
      let name;
      if (isGun && i < 2) {
        name = EUP_MYEON_NAMES[Math.floor(rand() * EUP_MYEON_NAMES.length)];
      } else {
        let prefix;
        let attempts = 0;
        do {
          prefix = DONG_PREFIXES[Math.floor(rand() * DONG_PREFIXES.length)];
          attempts++;
        } while (usedPrefixes.has(prefix) && attempts < 50);
        usedPrefixes.add(prefix);

        if (isGun) {
          const suffixes = ['면', '리'];
          name = prefix + suffixes[Math.floor(rand() * suffixes.length)];
        } else {
          name = prefix + DONG_SUFFIXES_URBAN[Math.floor(rand() * DONG_SUFFIXES_URBAN.length)];
        }
      }
      emdNames.push(name);
    }

    // EMD가 없으면 추가
    if (existingEmds.cnt === 0) {
      const emdIds = [];
      for (let i = 0; i < actualCount; i++) {
        const currentEmdId = emdId++;
        const emdCode = dist.code + String(i + 1).padStart(5, '0');
        db.prepare('INSERT OR IGNORE INTO emds (id, district_id, code, name) VALUES (?, ?, ?, ?)')
          .run(currentEmdId, dist.id, emdCode, emdNames[i]);
        emdIds.push({ id: currentEmdId, code: emdCode });
        newEmds++;
      }

      // 관측소 추가 (3~5개)
      const stationCount = Math.min(actualCount, 3 + Math.floor(rand() * 3));
      for (let i = 0; i < stationCount; i++) {
        const idx = Math.floor(rand() * actualCount);
        const [lat, lon] = centers[idx];
        const currentStnId = stnId++;
        db.prepare('INSERT OR IGNORE INTO weather_stations (stn_id, name, lat, lon, emd_id) VALUES (?, ?, ?, ?, ?)')
          .run(`G${currentStnId}`, `${dist.name}_${i + 1}`, lat, lon, emdIds[idx].id);
        newStns++;
      }
    }

    // GeoJSON 생성
    const emds = db.prepare('SELECT * FROM emds WHERE district_id = ? ORDER BY id').all(dist.id);
    const features = [];
    for (let i = 0; i < Math.min(emds.length, polygons.length); i++) {
      features.push({
        type: 'Feature',
        properties: {
          EMD_CD: emds[i].code,
          EMD_NM: emds[i].name,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [polygons[i]],
        },
      });
    }

    const geojson = { type: 'FeatureCollection', features };
    const geoPath = path.join(geoDir, `${dist.code}.json`);
    fs.writeFileSync(geoPath, JSON.stringify(geojson));
    newGeo++;
  }

  console.log(`Generated: ${newEmds} EMDs, ${newStns} stations, ${newGeo} GeoJSON files`);
  console.log('Done!');
}

main().catch(console.error);
