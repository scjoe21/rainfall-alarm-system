import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

const ALARM_DURATION_MS = 4 * 60 * 1000 + 50 * 1000; // 4분 50초

function DistrictSelector({ metroId, metroName, onSelect }) {
  const [districts, setDistricts] = useState([]);
  const [loading, setLoading] = useState(true);
  // { [districtId]: Set<emdCode> } — 현재 경보 중인 읍면동 목록 (기초 단위)
  const [activeByDistrict, setActiveByDistrict] = useState({});

  useEffect(() => {
    fetch(`/api/metros/${metroId}/districts`)
      .then(r => r.json())
      .then(dists => {
        setDistricts(dists);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load districts:', err);
        setLoading(false);
      });
  }, [metroId]);

  useEffect(() => {
    setActiveByDistrict({});
    const socket = io();
    const timers = {};

    socket.on('alarm', alarm => {
      const districtId = alarm.districtId;
      const emdCode = alarm.emdCode ?? alarm.emd_code;
      if (!districtId || !emdCode) return;

      const timerKey = `${districtId}_${emdCode}`;
      if (timers[timerKey]) return;

      setActiveByDistrict(prev => {
        const next = { ...prev };
        next[districtId] = new Set(next[districtId] ?? []);
        next[districtId].add(emdCode);
        return next;
      });

      timers[timerKey] = setTimeout(() => {
        setActiveByDistrict(prev => {
          const next = { ...prev };
          if (!next[districtId]) return next;
          const set = new Set(next[districtId]);
          set.delete(emdCode);
          if (set.size === 0) delete next[districtId];
          else next[districtId] = set;
          return next;
        });
        delete timers[timerKey];
      }, ALARM_DURATION_MS);
    });

    return () => {
      socket.disconnect();
      Object.values(timers).forEach(clearTimeout);
    };
  }, [metroId]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-20">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-700"></div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">
        {metroName} - 기초자치단체 선택
      </h2>
      <p className="text-gray-500 mb-6">모니터링할 지역을 선택하세요</p>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {districts.map(district => {
          const alarmCount = activeByDistrict[district.id]?.size ?? 0;
          return (
            <button
              key={district.id}
              onClick={() => onSelect(district)}
              className={`
                bg-white rounded-xl shadow-md hover:shadow-lg p-4 text-center
                transition-all hover:scale-105 border-2 relative
                ${alarmCount > 0
                  ? 'border-red-400 bg-red-50 hover:bg-red-100 animate-pulse'
                  : 'border-gray-200 hover:bg-blue-50'
                }
              `}
            >
              <span className="text-base font-semibold text-gray-700">
                {district.name}
              </span>
              {alarmCount > 0 && (
                <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center alarm-badge">
                  {alarmCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default DistrictSelector;
