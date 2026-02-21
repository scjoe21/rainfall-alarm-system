import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

const ALARM_DURATION_MS = 4 * 60 * 1000 + 50 * 1000; // 4분 50초

function MetroSelector({ onSelect }) {
  const [metros, setMetros] = useState([]);
  const [loading, setLoading] = useState(true);
  // { [metroId]: Set<emdCode> } — 현재 경보 중인 읍면동 목록 (광역 단위)
  const [activeByMetro, setActiveByMetro] = useState({});

  useEffect(() => {
    fetch('/api/metros')
      .then(res => res.json())
      .then(data => {
        setMetros(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load metros:', err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const socket = io();
    // timerKey → timeoutId (중복 알람 방지)
    const timers = {};

    socket.on('alarm', alarm => {
      const metroId = alarm.metroId;
      const emdCode = alarm.emdCode ?? alarm.emd_code;
      if (!metroId || !emdCode) return;

      const timerKey = `${metroId}_${emdCode}`;
      // 이미 같은 읍면동의 경보 타이머가 실행 중이면 무시
      if (timers[timerKey]) return;

      setActiveByMetro(prev => {
        const next = { ...prev };
        next[metroId] = new Set(next[metroId] ?? []);
        next[metroId].add(emdCode);
        return next;
      });

      timers[timerKey] = setTimeout(() => {
        setActiveByMetro(prev => {
          const next = { ...prev };
          if (!next[metroId]) return next;
          const set = new Set(next[metroId]);
          set.delete(emdCode);
          if (set.size === 0) delete next[metroId];
          else next[metroId] = set;
          return next;
        });
        delete timers[timerKey];
      }, ALARM_DURATION_MS);
    });

    return () => {
      socket.disconnect();
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-20">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-700"></div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-6">광역자치단체 선택</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {metros.map(metro => {
          const alarmCount = activeByMetro[metro.id]?.size ?? 0;
          return (
            <button
              key={metro.id}
              onClick={() => onSelect(metro)}
              className="relative bg-white rounded-xl shadow-md hover:shadow-lg p-6 text-center transition-all hover:scale-105 hover:bg-blue-50 border border-gray-200"
            >
              <span className="text-lg font-semibold text-gray-700">{metro.name}</span>
              {alarmCount > 0 && (
                <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs font-bold rounded-full min-w-[1.25rem] h-5 flex items-center justify-center px-1 alarm-badge">
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

export default MetroSelector;
