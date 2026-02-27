import { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, GeoJSON, TileLayer, useMap } from 'react-leaflet';
import { io } from 'socket.io-client';
import L from 'leaflet';

// 광역시도 코드 앞 2자리 → 대략적 중심좌표
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

function getDistrictCenter(districtCode) {
  const metroPrefix = districtCode?.substring(0, 2);
  return METRO_CENTERS[metroPrefix] || [36.5, 127.5];
}

// GeoJSON 로드 후 맵 범위 맞춤
function FitBounds({ geojson, fallbackCenter }) {
  const map = useMap();
  useEffect(() => {
    if (geojson?.features?.length > 0) {
      const geoLayer = L.geoJSON(geojson);
      const bounds = geoLayer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [30, 30] });
        return;
      }
    }
    if (fallbackCenter) {
      map.setView(fallbackCenter, 12);
    }
  }, [geojson, fallbackCenter, map]);
  return null;
}

function EmdMap({ districtId, metroId, districtName, districtCode, isMetroMode }) {
  const [emdGeoJSON, setEmdGeoJSON] = useState(null);
  const [rainfallData, setRainfallData] = useState({});
  const [alarmEmds, setAlarmEmds] = useState(new Set());
  const [blinkOn, setBlinkOn] = useState(true);
  const [loading, setLoading] = useState(true);
  const [noData, setNoData] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const geoJsonRef = useRef(null);
  const layerMapRef = useRef({});
  const timeoutIdsRef = useRef([]);
  // 지역별 알람 타이머 관리: 이미 깜빡이는 중인 emd는 타이머를 재설정하지 않음
  const alarmTimersRef = useRef({});

  const fallbackCenter = getDistrictCenter(districtCode);

  // 깜빡임 타이머: alarmEmds가 있으면 500ms 간격으로 blinkOn 토글
  useEffect(() => {
    if (alarmEmds.size === 0) return;
    const timer = setInterval(() => {
      setBlinkOn(prev => !prev);
    }, 500);
    return () => clearInterval(timer);
  }, [alarmEmds.size]);

  // 깜빡임 상태 변경 시 알람 영역 스타일 업데이트
  useEffect(() => {
    for (const emdCode of alarmEmds) {
      const layer = layerMapRef.current[emdCode];
      if (!layer) continue;
      if (blinkOn) {
        layer.setStyle({ fillColor: '#dc2626', fillOpacity: 0.8, weight: 3, color: '#991b1b' });
      } else {
        layer.setStyle({ fillColor: '#fef2f2', fillOpacity: 0.3, weight: 2, color: '#dc2626' });
      }
    }
  }, [blinkOn, alarmEmds]);

  // 데이터 로드
  useEffect(() => {
    setLoading(true);
    setNoData(false);
    setAlarmEmds(new Set());
    layerMapRef.current = {};

    const geoUrl = isMetroMode
      ? `/api/geojson/metro/${metroId}`
      : `/api/geojson/district/${districtId}`;
    const rainUrl = isMetroMode
      ? `/api/rainfall/metro/${metroId}`
      : `/api/rainfall/district/${districtId}`;

    Promise.all([
      fetch(geoUrl).then(r => r.json()),
      fetch(rainUrl).then(r => r.json()),
    ])
      .then(([geojson, rainfall]) => {
        setEmdGeoJSON(geojson);
        if (!geojson?.features?.length) setNoData(true);
        const map = {};
        rainfall.forEach(item => {
          map[item.emd_code] = {
            realtime_15min: item.realtime_15min,
            forecast_hourly: item.forecast_hourly,
            station_name: item.station_name || null,
          };
        });
        setRainfallData(map);
        setLastUpdated(new Date());
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load map data:', err);
        setNoData(true);
        setLoading(false);
      });

    // WebSocket
    const socket = io();
    if (districtId != null) {
      socket.emit('subscribe_district', districtId);
    }

    socket.on('rainfall_update', update => {
      setRainfallData(prev => ({
        ...prev,
        [update.emdCode]: update,
      }));
      setLastUpdated(new Date());
    });

    socket.on('alarm', alarm => {
      const emdCode = alarm.emdCode;

      // 기존 타이머가 있으면 제거 후 재설정 (조건 지속 중 끊김 방지)
      if (alarmTimersRef.current[emdCode]) {
        clearTimeout(alarmTimersRef.current[emdCode]);
      }

      setAlarmEmds(prev => new Set([...prev, emdCode]));

      const tid = setTimeout(() => {
        setAlarmEmds(prev => {
          const next = new Set(prev);
          next.delete(emdCode);
          return next;
        });
        delete alarmTimersRef.current[emdCode];
      }, 5 * 60 * 1000 + 30 * 1000); // 5분 30초 (폴링 5분 + 실행 여유 30초)

      alarmTimersRef.current[emdCode] = tid;
      timeoutIdsRef.current.push(tid);
    });

    return () => {
      socket.disconnect();
      timeoutIdsRef.current.forEach(clearTimeout);
      timeoutIdsRef.current = [];
      alarmTimersRef.current = {};
    };
  }, [districtId, metroId, isMetroMode]);

  const getEmdStyle = useCallback((feature) => {
    const emdCode = feature.properties.EMD_CD;
    const data = rainfallData[emdCode];
    const isAlarming = alarmEmds.has(emdCode);

    if (isAlarming) {
      return {
        fillColor: '#dc2626',
        fillOpacity: 0.8,
        weight: 3,
        color: '#991b1b',
      };
    }

    // 관측소 없는 EMD: 점선 테두리 + 연한 회색
    if (!data || !data.station_name) {
      return {
        fillColor: '#f1f5f9',
        fillOpacity: 0.4,
        weight: 1.5,
        color: '#94a3b8',
        dashArray: '4 4',
      };
    }

    // 알람 기준 미달 지역: 단일 기본색 (강수 단계 구분 없음)
    return {
      fillColor: '#e2e8f0',
      fillOpacity: 0.65,
      weight: 1.5,
      color: '#475569',
    };
  }, [rainfallData, alarmEmds]);

  const onEachEmd = useCallback((feature, layer) => {
    const emdCode = feature.properties.EMD_CD;
    const emdName = feature.properties.EMD_NM;
    const data = rainfallData[emdCode];

    // layer 참조 저장 (깜빡임용)
    layerMapRef.current[emdCode] = layer;

    // 툴팁
    let tooltipContent;
    if (data && data.station_name) {
      tooltipContent = `<div style="font-size:13px;line-height:1.5">
          <strong>${emdName}</strong><br/>
          관측소: ${data.station_name}<br/>
          실시간 15분: ${data.realtime_15min.toFixed(1)}mm<br/>
          시간당 예보: <b>${data.forecast_hourly.toFixed(1)}mm/hr</b>
        </div>`;
    } else if (data) {
      tooltipContent = `<div style="font-size:13px;line-height:1.5">
          <strong>${emdName}</strong><br/>
          실시간 15분: ${data.realtime_15min.toFixed(1)}mm<br/>
          시간당 예보: <b>${data.forecast_hourly.toFixed(1)}mm/hr</b>
        </div>`;
    } else {
      tooltipContent = `<div style="font-size:13px;line-height:1.5">
          <strong>${emdName}</strong><br/>
          <span style="color:#94a3b8">관측소 없음</span>
        </div>`;
    }

    layer.bindTooltip(tooltipContent, { sticky: true });

    // 중앙 라벨
    layer.on('add', () => {
      const center = layer.getBounds().getCenter();
      const label = L.marker(center, {
        icon: L.divIcon({
          className: 'emd-label',
          html: `<span>${emdName}</span>`,
          iconSize: [80, 20],
          iconAnchor: [40, 10],
        }),
        interactive: false,
      });
      label.addTo(layer._map);
      layer._label = label;
    });
    layer.on('remove', () => {
      if (layer._label) layer._label.remove();
    });
  }, [rainfallData]);

  const formatTime = (date) => {
    if (!date) return '';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="bg-white rounded-xl shadow-lg overflow-hidden">
      <div className="p-4 border-b bg-gray-50">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-800">{districtName} 읍면동 지도</h3>
          {lastUpdated && (
            <span className="text-xs text-gray-400">
              마지막 갱신: {formatTime(lastUpdated)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-4 mt-2">
          <div className="legend-item"><div className="legend-color blink-demo" style={{ background: '#dc2626' }}></div>15분↑20mm &amp; 예보↑55mm/hr 알람</div>
          <div className="legend-item"><div className="legend-color legend-no-station"></div>관측소 없음</div>
        </div>
      </div>
      <div style={{ height: 'min(calc(100vh - 220px), 700px)', minHeight: '350px' }} className="relative">
        {loading ? (
          <div className="flex justify-center items-center h-full bg-slate-50">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-700"></div>
          </div>
        ) : (
          <>
            <MapContainer
              center={fallbackCenter}
              zoom={12}
              style={{ height: '100%', width: '100%', background: '#f8fafc' }}
              zoomControl={true}
              attributionControl={false}
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                opacity={0.4}
              />
              <FitBounds geojson={emdGeoJSON} fallbackCenter={fallbackCenter} />
              {emdGeoJSON?.features?.length > 0 && (
                <GeoJSON
                  key={(districtId || metroId) + JSON.stringify(rainfallData)}
                  ref={geoJsonRef}
                  data={emdGeoJSON}
                  style={getEmdStyle}
                  onEachFeature={onEachEmd}
                />
              )}
            </MapContainer>
            {noData && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="bg-white/90 rounded-lg px-6 py-4 shadow-lg text-center pointer-events-auto">
                  <p className="text-gray-600 font-semibold">
                    {districtName} 읍면동 경계 데이터 준비중
                  </p>
                  <p className="text-gray-400 text-sm mt-1">
                    GeoJSON 데이터가 추가되면 지도에 표시됩니다
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default EmdMap;
