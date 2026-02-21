/**
 * 세종시 읍면동 통합 스크립트
 * - 세종시는 단층제이므로 20개 "district"가 각각 1개 EMD
 * - district 경계를 무시하고 관측소 기준으로 EMD를 통합
 * - metro 모드에서 바로 지도 표시
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, getDatabase } from './config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const geoDir = path.join(__dirname, '..', 'data', 'geojson');

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
  console.log('=== 세종시 읍면동 통합 ===\n');

  await initDatabase();
  const db = await getDatabase();

  // 세종 metro_id = 8
  const sejongDistricts = db.prepare(
    'SELECT * FROM districts WHERE metro_id = 8 ORDER BY code'
  ).all();

  // 1. 모든 세종 EMD + geometry 로드
  const allEmds = [];
  const geometries = {};

  for (const dist of sejongDistricts) {
    const emds = db.prepare('SELECT * FROM emds WHERE district_id = ?').all(dist.id);
    for (const emd of emds) {
      allEmds.push({ ...emd, distCode: dist.code });
      const geoPath = path.join(geoDir, `${dist.code}.json`);
      if (fs.existsSync(geoPath)) {
        const geo = JSON.parse(fs.readFileSync(geoPath, 'utf-8'));
        const feature = geo.features.find(f => f.properties.EMD_CD === emd.code);
        if (feature) geometries[emd.code] = feature.geometry;
      }
    }
  }

  console.log(`세종 EMD: ${allEmds.length}개`);

  // 2. 관측소가 있는 EMD 그룹 찾기 (대표 관측소 기준)
  const stationGroups = {}; // stationId -> { station, emds: [] }

  for (const emd of allEmds) {
    const stations = db.prepare('SELECT * FROM weather_stations WHERE emd_id = ?').all(emd.id);
    if (stations.length > 0) {
      // 이 EMD에 관측소가 있음 - 대표 station 사용
      const station = stations[0];
      const key = String(station.id);
      if (!stationGroups[key]) stationGroups[key] = { station, emds: [] };
      stationGroups[key].emds.push(emd);
    }
  }

  console.log(`관측소 그룹: ${Object.keys(stationGroups).length}개`);
  for (const [key, group] of Object.entries(stationGroups)) {
    console.log(`  ${group.station.name} (${group.station.stn_id}): ${group.emds.map(e => e.name).join(', ')}`);
  }

  // 3. 관측소 없는 EMD → 가장 가까운 관측소에 배정
  const assignedEmds = new Set(
    Object.values(stationGroups).flatMap(g => g.emds.map(e => e.code))
  );

  for (const emd of allEmds) {
    if (assignedEmds.has(emd.code)) continue;

    const geom = geometries[emd.code];
    if (!geom) continue;

    const coords = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
    const [eLat, eLon] = centroid(coords);

    let minDist = Infinity;
    let bestKey = null;
    for (const [key, group] of Object.entries(stationGroups)) {
      const d = haversineDistance(eLat, eLon, group.station.lat, group.station.lon);
      if (d < minDist) {
        minDist = d;
        bestKey = key;
      }
    }

    if (bestKey) {
      stationGroups[bestKey].emds.push(emd);
    }
  }

  console.log('\n통합 후:');
  for (const [key, group] of Object.entries(stationGroups)) {
    console.log(`  ${group.station.name}: ${group.emds.map(e => e.name).join(', ')}`);
  }

  // 4. 각 그룹을 하나의 EMD로 통합
  // 대표 EMD = 첫 번째 (관측소가 있는) EMD
  // 대표 district = 대표 EMD의 district
  for (const [key, group] of Object.entries(stationGroups)) {
    const primaryEmd = group.emds[0];
    const mergedName = group.emds.map(e => e.name).join('·');

    // 대표 EMD 이름 업데이트
    db.prepare('UPDATE emds SET name = ? WHERE id = ?').run(mergedName, primaryEmd.id);

    // 나머지 EMD 제거 + station 재매핑
    for (let i = 1; i < group.emds.length; i++) {
      const removeEmd = group.emds[i];
      db.prepare('UPDATE weather_stations SET emd_id = ? WHERE emd_id = ?')
        .run(primaryEmd.id, removeEmd.id);
      db.prepare('DELETE FROM emds WHERE id = ?').run(removeEmd.id);
    }
  }

  // 5. GeoJSON 파일 재생성
  // 대표 district에 통합된 feature 저장, 빈 district는 빈 FeatureCollection
  for (const dist of sejongDistricts) {
    const emds = db.prepare('SELECT * FROM emds WHERE district_id = ?').all(dist.id);

    const features = [];
    for (const emd of emds) {
      // 이 EMD에 통합된 모든 원래 EMD의 geometry 합치기
      const group = Object.values(stationGroups).find(g => g.emds[0].id === emd.id);
      if (!group) continue;

      const allCoords = [];
      for (const srcEmd of group.emds) {
        const geom = geometries[srcEmd.code];
        if (!geom) continue;
        if (geom.type === 'MultiPolygon') {
          allCoords.push(...geom.coordinates);
        } else if (geom.type === 'Polygon') {
          allCoords.push(geom.coordinates);
        }
      }

      if (allCoords.length > 0) {
        features.push({
          type: 'Feature',
          properties: { EMD_CD: emd.code, EMD_NM: emd.name },
          geometry: { type: 'MultiPolygon', coordinates: allCoords },
        });
      }
    }

    fs.writeFileSync(
      path.join(geoDir, `${dist.code}.json`),
      JSON.stringify({ type: 'FeatureCollection', features })
    );
  }

  // 검증
  const finalEmds = db.prepare(
    'SELECT e.*, d.code as dc FROM emds e JOIN districts d ON e.district_id = d.id WHERE d.metro_id = 8'
  ).all();
  const stationCount = db.prepare(
    'SELECT COUNT(*) as c FROM weather_stations ws JOIN emds e ON ws.emd_id = e.id JOIN districts d ON e.district_id = d.id WHERE d.metro_id = 8'
  ).get();

  console.log(`\n최종: ${finalEmds.length}개 EMD, ${stationCount.c}개 관측소`);
  for (const e of finalEmds) {
    const sc = db.prepare('SELECT COUNT(*) as c FROM weather_stations WHERE emd_id = ?').get(e.id);
    console.log(`  ${e.dc} ${e.name} - stations: ${sc.c}`);
  }
}

main().catch(console.error);
