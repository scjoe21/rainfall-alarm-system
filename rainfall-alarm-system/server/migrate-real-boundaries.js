/**
 * 실제 행정동 경계 마이그레이션 스크립트
 * - vuski/admdongkor GeoJSON에서 실제 행정동 경계 다운로드
 * - 269개 district별 GeoJSON 파일 생성
 * - DB emds 테이블 실제 데이터로 교체
 * - weather_stations emd_id 재매핑 (point-in-polygon)
 * - 동일 관측소를 공유하는 읍면동은 통합 표시
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { initDatabase, getDatabase } from './config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const geoDir = path.join(__dirname, '..', 'data', 'geojson');

const VUSKI_URL = 'https://raw.githubusercontent.com/vuski/admdongkor/master/ver20250101/HangJeongDong_ver20250101.geojson';

// ===== 우리 DB 코드 → vuski sgg 코드 매핑 =====
// 코드가 변경된 지역들
const CODE_MAP = {
  // 강원특별자치도: 42 → 51
  '42110': '51110', '42130': '51130', '42150': '51150', '42170': '51170',
  '42190': '51190', '42210': '51210', '42230': '51230', '42720': '51720',
  '42730': '51730', '42750': '51750', '42760': '51760', '42770': '51770',
  '42780': '51780', '42790': '51790', '42800': '51800', '42810': '51810',
  '42820': '51820', '42830': '51830',
  // 전북특별자치도: 45 → 52
  '45110': '52111', '45113': '52113', '45130': '52130', '45140': '52140',
  '45180': '52180', '45190': '52190', '45210': '52210', '45710': '52710',
  '45720': '52720', '45730': '52730', '45740': '52740', '45750': '52750',
  '45770': '52770', '45790': '52790', '45800': '52800',
  // 경기도 - 안양시
  '41170': '41171',
  // 경기도 - 부천시 (단일 → 3구 통합)
  '41190': ['41192', '41194', '41196'],
  // 경기도 - 안산시
  '41270': '41271',
  // 경기도 - 고양시
  '41280': '41281', '41281': '41285', '41285': '41287',
  // 경기도 - 용인시
  '41460': '41461', '41461': '41463', '41463': '41465',
  // 충북 - 청주시
  '43110': '43111', '43111': '43112', '43112': '43113', '43113': '43114',
  // 충남 - 천안시
  '44130': '44131', '44131': '44133',
  // 경북 - 포항시
  '47110': '47111', '47111': '47113',
  // 경북 - 군위군 (대구 편입)
  '47720': '27720',
  // 경남 - 창원시
  '48120': '48121', '48121': '48123', '48123': '48125', '48125': '48127', '48127': '48129',
};

// 세종시 vuski adm_cd2 앞5자리 → district code 매핑 (동적으로 생성)

// ===== Point-in-Polygon (Ray Casting) =====
function pointInPolygon(lat, lon, polygon) {
  const ring = polygon[0];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) &&
        lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInMultiPolygon(lat, lon, multiPolygon) {
  for (const polygon of multiPolygon) {
    if (pointInPolygon(lat, lon, polygon)) return true;
  }
  return false;
}

function centroid(multiPolygon) {
  let sumLon = 0, sumLat = 0, count = 0;
  for (const polygon of multiPolygon) {
    for (const [lon, lat] of polygon[0]) {
      sumLon += lon; sumLat += lat; count++;
    }
  }
  return [sumLat / count, sumLon / count];
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function main() {
  console.log('=== 실제 행정동 경계 마이그레이션 ===\n');

  // 1. vuski GeoJSON 다운로드
  console.log('1. vuski GeoJSON 다운로드 중...');
  const response = await axios.get(VUSKI_URL, { timeout: 60000 });
  const vuskiData = response.data;
  console.log(`   다운로드 완료: ${vuskiData.features.length}개 행정동\n`);

  // 2. features를 sgg(시군구 코드)로 그룹핑
  console.log('2. 시군구별 그룹핑...');
  const bySgg = {};
  for (const feature of vuskiData.features) {
    const sgg = feature.properties.sgg;
    if (!bySgg[sgg]) bySgg[sgg] = [];
    bySgg[sgg].push(feature);
  }
  console.log(`   ${Object.keys(bySgg).length}개 시군구 그룹\n`);

  // 세종 features를 이름으로 인덱싱
  const sejongByName = {};
  const sejongFeatures = bySgg['36110'] || [];
  for (const f of sejongFeatures) {
    const name = f.properties.adm_nm.split(' ').pop();
    sejongByName[name] = f;
  }
  console.log(`   세종시 features: ${sejongFeatures.length}개\n`);

  // 3. DB 초기화
  console.log('3. DB 연결...');
  await initDatabase();
  const db = await getDatabase();

  const districts = db.prepare(
    'SELECT d.*, m.code as metro_code FROM districts d JOIN metros m ON d.metro_id = m.id ORDER BY d.code'
  ).all();
  console.log(`   ${districts.length}개 district\n`);

  // 세종시: vuski에 있는데 DB에 없는 district 자동 생성
  const sejongMetro = db.prepare('SELECT id FROM metros WHERE code = ?').get('36');
  const sejongDistrictsInDb = districts.filter(d => d.metro_code === '36');
  const sejongNameToDistrict = {};
  for (const d of sejongDistrictsInDb) sejongNameToDistrict[d.name] = d;

  let nextDistId = Math.max(...districts.map(d => d.id)) + 1;
  let nextDistCode = Math.max(...sejongDistrictsInDb.map(d => parseInt(d.code))) + 10;

  for (const f of sejongFeatures) {
    const name = f.properties.adm_nm.split(' ').pop();
    if (!sejongNameToDistrict[name]) {
      const code = String(nextDistCode);
      db.prepare('INSERT INTO districts (id, metro_id, code, name) VALUES (?, ?, ?, ?)')
        .run(nextDistId, sejongMetro.id, code, name);
      const newDist = { id: nextDistId, metro_id: sejongMetro.id, code, name, metro_code: '36' };
      districts.push(newDist);
      sejongNameToDistrict[name] = newDist;
      console.log(`   세종 district 추가: ${code} ${name}`);
      nextDistId++;
      nextDistCode += 10;
    }
  }

  const sejongDistrictCodes = new Set(
    districts.filter(d => d.metro_code === '36').map(d => d.code)
  );

  // 4. emds 테이블 교체
  console.log('4. EMD 데이터 재생성...');
  db.exec('DELETE FROM alarm_logs');
  db.exec('DELETE FROM rainfall_forecast');
  db.exec('DELETE FROM rainfall_realtime');
  db.exec('DELETE FROM emds');

  let emdId = 1;
  const emdMap = {}; // emd_code -> emd_id
  let geoCreated = 0;
  let geoSkipped = 0;

  // 5. 각 district별 GeoJSON 생성 + EMD 삽입
  console.log('5. GeoJSON 파일 생성 및 EMD 삽입...\n');

  for (const district of districts) {
    let features = [];

    if (sejongDistrictCodes.has(district.code)) {
      // 세종시: 이름으로 매칭
      const f = sejongByName[district.name];
      if (f) {
        features = [f];
      } else {
        console.log(`   세종 이름 미매칭: ${district.code} ${district.name}`);
      }
    } else {
      // vuski sgg 코드로 매칭 (코드 매핑 적용)
      const mappedCode = CODE_MAP[district.code];

      if (Array.isArray(mappedCode)) {
        // 여러 vuski sgg → 하나의 district (예: 부천시)
        for (const code of mappedCode) {
          features.push(...(bySgg[code] || []));
        }
      } else if (mappedCode) {
        features = bySgg[mappedCode] || [];
      } else {
        features = bySgg[district.code] || [];
      }
    }

    if (features.length === 0) {
      console.log(`   SKIP: ${district.code} ${district.name} - vuski 매칭 없음`);
      geoSkipped++;
      continue;
    }

    // EMD 삽입 + GeoJSON feature 생성
    const geoFeatures = [];
    for (const f of features) {
      const emdCode = f.properties.adm_cd2;
      const emdName = f.properties.adm_nm.split(' ').pop();

      db.prepare('INSERT INTO emds (id, district_id, code, name) VALUES (?, ?, ?, ?)')
        .run(emdId, district.id, emdCode, emdName);
      emdMap[emdCode] = emdId;
      emdId++;

      geoFeatures.push({
        type: 'Feature',
        properties: { EMD_CD: emdCode, EMD_NM: emdName },
        geometry: f.geometry,
      });
    }

    const geojson = { type: 'FeatureCollection', features: geoFeatures };
    fs.writeFileSync(
      path.join(geoDir, `${district.code}.json`),
      JSON.stringify(geojson)
    );
    geoCreated++;
  }

  console.log(`\n   GeoJSON 생성: ${geoCreated}개, 스킵: ${geoSkipped}개`);
  console.log(`   EMD 삽입: ${emdId - 1}개\n`);

  // 6. 관측소 재매핑 (point-in-polygon)
  console.log('6. 관측소 emd_id 재매핑...');

  const stations = db.prepare('SELECT * FROM weather_stations').all();

  // EMD별 geometry 로드
  const emdGeometries = {};
  for (const district of districts) {
    const geoPath = path.join(geoDir, `${district.code}.json`);
    if (!fs.existsSync(geoPath)) continue;
    const geo = JSON.parse(fs.readFileSync(geoPath, 'utf-8'));
    for (const f of geo.features) {
      emdGeometries[f.properties.EMD_CD] = f.geometry;
    }
  }

  // EMD centroid 캐시
  const emdCentroids = {};
  for (const [code, geom] of Object.entries(emdGeometries)) {
    const coords = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
    emdCentroids[code] = centroid(coords);
  }

  let pipMatched = 0;
  let fallbackMatched = 0;

  for (const station of stations) {
    let matchedEmdCode = null;

    // Point-in-polygon
    for (const [emdCode, geom] of Object.entries(emdGeometries)) {
      const coords = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
      if (pointInMultiPolygon(station.lat, station.lon, coords)) {
        matchedEmdCode = emdCode;
        break;
      }
    }

    if (matchedEmdCode) {
      pipMatched++;
    } else {
      // Fallback: 가장 가까운 EMD centroid
      let minDist = Infinity;
      for (const [code, [cLat, cLon]] of Object.entries(emdCentroids)) {
        const d = haversineDistance(station.lat, station.lon, cLat, cLon);
        if (d < minDist) {
          minDist = d;
          matchedEmdCode = code;
        }
      }
      fallbackMatched++;
    }

    const newEmdId = emdMap[matchedEmdCode];
    if (newEmdId) {
      db.prepare('UPDATE weather_stations SET emd_id = ? WHERE id = ?').run(newEmdId, station.id);
    }
  }

  console.log(`   PIP 매칭: ${pipMatched}, Fallback: ${fallbackMatched}\n`);

  // 7. 동일 관측소를 공유하는 EMD 통합
  console.log('7. 관측소 공유 읍면동 통합...');
  mergeSharedStationEmds(db, emdMap, emdGeometries);

  // 8. 세종시: 개별 읍면동 + 실제 관측소 매핑 (단층제)
  console.log('\n8. 세종시 실제 관측소 매핑...');
  fixSejongStations(db, emdGeometries);

  // 검증
  const finalEmdCount = db.prepare('SELECT COUNT(*) as cnt FROM emds').get();
  const finalStationCount = db.prepare('SELECT COUNT(*) as cnt FROM weather_stations').get();
  const orphanStations = db.prepare(
    'SELECT COUNT(*) as cnt FROM weather_stations ws WHERE NOT EXISTS (SELECT 1 FROM emds e WHERE e.id = ws.emd_id)'
  ).get();

  console.log(`\n=== 마이그레이션 완료 ===`);
  console.log(`  Districts: ${districts.length}`);
  console.log(`  EMDs: ${finalEmdCount.cnt}`);
  console.log(`  Stations: ${finalStationCount.cnt}`);
  console.log(`  Orphan stations: ${orphanStations.cnt}`);
}

/**
 * 동일 관측소를 공유하는 EMD들을 통합
 */
function mergeSharedStationEmds(db, emdMap, emdGeometries) {
  const districts = db.prepare('SELECT * FROM districts ORDER BY code').all();

  let totalMerged = 0;
  let totalRemoved = 0;

  for (const district of districts) {
    const geoPath = path.join(geoDir, `${district.code}.json`);
    if (!fs.existsSync(geoPath)) continue;

    const emds = db.prepare('SELECT * FROM emds WHERE district_id = ? ORDER BY code').all(district.id);
    if (emds.length === 0) continue;

    // station별 EMD 그룹핑 (여러 station이 같은 EMD에 있으면 station 기준)
    const stationToEmds = {};
    const emdToStation = {};

    for (const emd of emds) {
      // 이 EMD에 매핑된 station들 찾기
      const stationsForEmd = db.prepare('SELECT * FROM weather_stations WHERE emd_id = ?').all(emd.id);
      if (stationsForEmd.length > 0) {
        // 첫 번째 station을 대표로
        const station = stationsForEmd[0];
        const key = String(station.id);
        if (!stationToEmds[key]) stationToEmds[key] = { station, emds: [] };
        stationToEmds[key].emds.push(emd);
        emdToStation[emd.code] = key;
      }
    }

    // 관측소 없는 EMD들: 같은 district 내 가장 가까운 관측소에 합류
    const emdsWithoutStation = emds.filter(e => !emdToStation[e.code]);
    if (emdsWithoutStation.length > 0 && Object.keys(stationToEmds).length > 0) {
      for (const emd of emdsWithoutStation) {
        const geom = emdGeometries[emd.code];
        if (!geom) continue;
        const coords = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
        const [eLat, eLon] = centroid(coords);

        let minDist = Infinity;
        let bestKey = null;
        for (const [key, group] of Object.entries(stationToEmds)) {
          const d = haversineDistance(eLat, eLon, group.station.lat, group.station.lon);
          if (d < minDist) {
            minDist = d;
            bestKey = key;
          }
        }

        if (bestKey) {
          stationToEmds[bestKey].emds.push(emd);
          emdToStation[emd.code] = bestKey;
        }
      }
    }

    // GeoJSON 재구성
    const geo = JSON.parse(fs.readFileSync(geoPath, 'utf-8'));
    const featureByCode = {};
    for (const f of geo.features) {
      featureByCode[f.properties.EMD_CD] = f;
    }

    const newFeatures = [];
    const processedCodes = new Set();

    for (const [stationKey, group] of Object.entries(stationToEmds)) {
      if (group.emds.length === 1) {
        const emd = group.emds[0];
        processedCodes.add(emd.code);
        const feature = featureByCode[emd.code];
        if (feature) newFeatures.push(feature);
        continue;
      }

      // 여러 EMD 통합
      totalMerged++;
      const primaryEmd = group.emds[0];
      const mergedName = group.emds.map(e => e.name).join('·');

      const allCoords = [];
      for (const emd of group.emds) {
        processedCodes.add(emd.code);
        const feature = featureByCode[emd.code];
        if (!feature) continue;

        if (feature.geometry.type === 'MultiPolygon') {
          allCoords.push(...feature.geometry.coordinates);
        } else if (feature.geometry.type === 'Polygon') {
          allCoords.push(feature.geometry.coordinates);
        }
      }

      if (allCoords.length === 0) continue;

      db.prepare('UPDATE emds SET name = ? WHERE id = ?').run(mergedName, primaryEmd.id);

      for (let i = 1; i < group.emds.length; i++) {
        const removeEmd = group.emds[i];
        db.prepare('UPDATE weather_stations SET emd_id = ? WHERE emd_id = ?')
          .run(primaryEmd.id, removeEmd.id);
        db.prepare('DELETE FROM emds WHERE id = ?').run(removeEmd.id);
        totalRemoved++;
      }

      newFeatures.push({
        type: 'Feature',
        properties: { EMD_CD: primaryEmd.code, EMD_NM: mergedName },
        geometry: { type: 'MultiPolygon', coordinates: allCoords },
      });
    }

    // 미처리 EMD (관측소도 없고 매핑도 안 된) 그대로 유지
    for (const f of geo.features) {
      if (!processedCodes.has(f.properties.EMD_CD)) {
        newFeatures.push(f);
      }
    }

    fs.writeFileSync(geoPath, JSON.stringify({ type: 'FeatureCollection', features: newFeatures }));
  }

  console.log(`   통합 그룹: ${totalMerged}개, 제거된 EMD: ${totalRemoved}개`);
}

/**
 * 세종시 실제 관측소 매핑
 * - 20개 읍면동 개별 표시 (통합 안 함)
 * - 이름 매칭 우선 (조치원읍→861, 연기면→862, 부강면→863, 금남면→864)
 * - 나머지는 폴리곤 경계까지 최소 거리 기반 매핑
 * - 가짜(G-시리즈) 관측소 제거, 실제 관측소 복제하여 1:1 매핑
 */
function fixSejongStations(db, emdGeometries) {
  // 실제 KMA 세종 관측소
  const REAL_SEJONG_STATIONS = [
    { stn_id: '360', name: '세종',  lat: 36.4800, lon: 127.2590 },
    { stn_id: '861', name: '조치원', lat: 36.6010, lon: 127.0010 },
    { stn_id: '862', name: '연기',  lat: 36.5560, lon: 127.0340 },
    { stn_id: '863', name: '부강',  lat: 36.5270, lon: 127.1440 },
    { stn_id: '864', name: '금남',  lat: 36.4700, lon: 127.0800 },
  ];

  // 이름 기반 우선 매핑 (읍면동 이름 → station stn_id)
  const NAME_TO_STATION = {
    '조치원읍': '861',
    '연기면': '862',
    '부강면': '863',
    '금남면': '864',
  };

  const stationByStnId = {};
  for (const st of REAL_SEJONG_STATIONS) stationByStnId[st.stn_id] = st;

  const sejongDistricts = db.prepare(
    'SELECT * FROM districts WHERE metro_id = 8 ORDER BY code'
  ).all();

  // 모든 세종 EMD 수집
  const allEmds = [];
  for (const dist of sejongDistricts) {
    const emds = db.prepare('SELECT * FROM emds WHERE district_id = ?').all(dist.id);
    for (const emd of emds) {
      allEmds.push({ ...emd, distCode: dist.code });
    }
  }

  if (allEmds.length === 0) return;

  // 1. 세종 내 기존 관측소 전부 제거 (가짜 + 잘못 매핑된 것)
  for (const emd of allEmds) {
    db.prepare('DELETE FROM weather_stations WHERE emd_id = ?').run(emd.id);
  }

  // 실제 관측소도 세종 밖 EMD에 매핑된 경우 제거 (나중에 재생성)
  for (const st of REAL_SEJONG_STATIONS) {
    db.prepare('DELETE FROM weather_stations WHERE stn_id = ?').run(st.stn_id);
  }

  // stn_id UNIQUE 제약 제거 (weather_stations 테이블 재생성)
  db.exec(`
    CREATE TABLE IF NOT EXISTS weather_stations_new (
      id INTEGER PRIMARY KEY,
      stn_id VARCHAR(10),
      name VARCHAR(50),
      lat REAL,
      lon REAL,
      emd_id INTEGER,
      FOREIGN KEY (emd_id) REFERENCES emds(id)
    );
    INSERT INTO weather_stations_new SELECT * FROM weather_stations;
    DROP TABLE weather_stations;
    ALTER TABLE weather_stations_new RENAME TO weather_stations;
  `);

  // 폴리곤 경계까지 최소 거리 계산 (centroid 대신 boundary vertex 사용)
  function minDistToPolygon(stLat, stLon, multiPoly) {
    let min = Infinity;
    for (const poly of multiPoly) {
      for (const [lon, lat] of poly[0]) {
        const d = haversineDistance(stLat, stLon, lat, lon);
        if (d < min) min = d;
      }
    }
    return min;
  }

  // 2. 각 읍면동에 관측소 매핑: 이름 우선, 그 다음 최소 경계 거리
  let nextStationId = (db.prepare('SELECT MAX(id) as m FROM weather_stations').get().m || 0) + 1;

  for (const emd of allEmds) {
    let bestStn = null;
    let method = '';
    let dist = 0;

    // 이름 매칭 우선
    const nameStnId = NAME_TO_STATION[emd.name];
    if (nameStnId) {
      bestStn = stationByStnId[nameStnId];
      method = 'name';
    }

    // 이름 매칭 안 되면 경계 최소 거리 사용
    if (!bestStn) {
      const geom = emdGeometries[emd.code];
      if (!geom) continue;
      const coords = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];

      let minDist = Infinity;
      for (const st of REAL_SEJONG_STATIONS) {
        const d = minDistToPolygon(st.lat, st.lon, coords);
        if (d < minDist) { minDist = d; bestStn = st; }
      }
      dist = minDist;
      method = 'boundary';
    }

    if (!bestStn) continue;

    db.prepare('INSERT INTO weather_stations (id, stn_id, name, lat, lon, emd_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nextStationId++, bestStn.stn_id, bestStn.name, bestStn.lat, bestStn.lon, emd.id);

    const distStr = method === 'name' ? '' : ` ${dist.toFixed(1)}km`;
    console.log(`   ${emd.name} → ${bestStn.name}(${bestStn.stn_id}) [${method}]${distStr}`);
  }

  const finalCount = db.prepare(
    'SELECT COUNT(*) as c FROM emds e JOIN districts d ON e.district_id = d.id WHERE d.metro_id = 8'
  ).get();
  const stationCount = db.prepare(
    'SELECT COUNT(*) as c FROM weather_stations ws JOIN emds e ON ws.emd_id = e.id JOIN districts d ON e.district_id = d.id WHERE d.metro_id = 8'
  ).get();
  console.log(`   세종 최종: ${finalCount.c}개 EMD, ${stationCount.c}개 관측소`);
}

main().catch(err => {
  console.error('마이그레이션 실패:', err);
  process.exit(1);
});
