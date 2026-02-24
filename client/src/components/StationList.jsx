import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const ALARM_DURATION_MS = 4 * 60 * 1000 + 50 * 1000; // 4분 50초
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5분

function StationList({ districtId, metroId, districtName }) {
  const [stations, setStations] = useState([]);
  const [alarmMap, setAlarmMap] = useState({}); // { emdCode: alarm }
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const alarmTimersRef = useRef({});

  const apiUrl = metroId
    ? `/api/rainfall/metro/${metroId}`
    : `/api/rainfall/district/${districtId}`;

  const fetchData = () => {
    fetch(apiUrl)
      .then(r => r.json())
      .then(data => {
        setStations(data.filter(d => d.station_name));
        setLastUpdated(new Date());
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    setAlarmMap({});
    alarmTimersRef.current = {};

    fetchData();
    const pollTimer = setInterval(fetchData, POLL_INTERVAL_MS);

    const socket = io();

    socket.on('alarm', alarm => {
      const emdCode = alarm.emdCode ?? alarm.emd_code;
      if (!emdCode) return;
      if (alarmTimersRef.current[emdCode]) return;

      setAlarmMap(prev => ({ ...prev, [emdCode]: alarm }));

      alarmTimersRef.current[emdCode] = setTimeout(() => {
        setAlarmMap(prev => {
          const next = { ...prev };
          delete next[emdCode];
          return next;
        });
        delete alarmTimersRef.current[emdCode];
      }, ALARM_DURATION_MS);
    });

    return () => {
      socket.disconnect();
      clearInterval(pollTimer);
      Object.values(alarmTimersRef.current).forEach(clearTimeout);
      alarmTimersRef.current = {};
    };
  }, [districtId, metroId]);

  const formatTime = d =>
    d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';

  if (loading) {
    return (
      <div className="flex justify-center items-center py-20">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-700" />
      </div>
    );
  }

  const alarmCount = Object.keys(alarmMap).length;

  return (
    <div className="bg-white rounded-xl shadow-lg overflow-hidden">
      {/* 헤더 */}
      <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-gray-800">{districtName} 관측소 현황</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            관측소 {stations.length}개
            {alarmCount > 0 && (
              <span className="ml-2 text-red-500 font-semibold">
                ⚠ 알람 {alarmCount}곳
              </span>
            )}
          </p>
        </div>
        {lastUpdated && (
          <span className="text-xs text-gray-400">갱신 {formatTime(lastUpdated)}</span>
        )}
      </div>

      {/* 관측소 카드 그리드 */}
      <div className="p-4 max-h-[calc(100vh-220px)] overflow-y-auto">
        {stations.length === 0 ? (
          <div className="text-center py-12 text-gray-400">관측소 데이터 없음</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {stations.map(station => {
              const isAlarming = !!alarmMap[station.emd_code];
              const rain15 = station.realtime_15min ?? 0;
              const forecast = station.forecast_hourly ?? 0;

              return (
                <div
                  key={station.emd_code}
                  className={`rounded-lg border-2 p-3 transition-all ${
                    isAlarming
                      ? 'border-red-500 bg-red-50 animate-pulse shadow-md'
                      : 'border-gray-200 bg-gray-50'
                  }`}
                >
                  {/* 관측소 이름 + 알람 표시 */}
                  <div className="flex items-center gap-1.5 mb-2">
                    {isAlarming && (
                      <span className="flex-shrink-0 w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
                    )}
                    <span className={`font-semibold text-sm truncate ${isAlarming ? 'text-red-700' : 'text-gray-800'}`}>
                      {station.station_name}
                    </span>
                  </div>

                  {/* 강우량 값 */}
                  <div className="text-xs space-y-0.5">
                    <div className="flex justify-between">
                      <span className="text-gray-500">15분</span>
                      <span className={`font-semibold ${rain15 > 0 ? 'text-blue-600' : 'text-gray-500'}`}>
                        {rain15.toFixed(1)}mm
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">예보</span>
                      <span className={`font-semibold ${forecast > 0 ? 'text-orange-600' : 'text-gray-500'}`}>
                        {forecast.toFixed(1)}mm/hr
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default StationList;
