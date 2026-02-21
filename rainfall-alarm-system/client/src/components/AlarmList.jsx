import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

const ALARM_DURATION_MS = 4 * 60 * 1000 + 50 * 1000; // 4분 50초

function AlarmList({ districtId, metroId }) {
  const [alarms, setAlarms] = useState([]);

  useEffect(() => {
    // 구독 지역이 바뀌면 목록 초기화
    setAlarms([]);

    const socket = io();
    const timers = [];

    socket.on('alarm', alarm => {
      const alarmId = `${alarm.emdCode ?? alarm.emd_code}_${Date.now()}`;

      setAlarms(prev => [{ ...alarm, _id: alarmId }, ...prev].slice(0, 20));

      // 4분 50초 후 자동 만료
      const tid = setTimeout(() => {
        setAlarms(prev => prev.filter(a => a._id !== alarmId));
      }, ALARM_DURATION_MS);

      timers.push(tid);
    });

    return () => {
      socket.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [districtId, metroId]);

  return (
    <div className="bg-white rounded-xl shadow-lg overflow-hidden">
      <div className="p-4 border-b bg-red-50">
        <h3 className="text-lg font-bold text-red-700">
          경보 발생 지역
        </h3>
        <p className="text-sm text-red-500 mt-1">
          15분 실시간 &gt; 20mm 이면서 시간당 예보 ≥ 55mm
        </p>
      </div>

      <div className="p-4 max-h-[500px] overflow-y-auto">
        {alarms.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            <p className="text-4xl mb-2">---</p>
            <p>현재 경보가 없습니다</p>
          </div>
        ) : (
          <div className="space-y-3">
            {alarms.map((alarm) => (
              <div
                key={alarm._id}
                className="border-l-4 border-red-500 pl-4 py-3 bg-red-50 rounded-r-lg"
              >
                <div className="font-bold text-gray-800">
                  {alarm.emd_name || alarm.emdName}
                </div>
                <div className="text-sm text-gray-600 mt-1 space-y-0.5">
                  <div>
                    실시간 15분:{' '}
                    <span className="font-semibold text-orange-600">
                      {(alarm.realtime_15min ?? alarm.realtime15min)?.toFixed?.(1) ?? '-'}mm
                    </span>
                  </div>
                  <div>
                    시간당 예보:{' '}
                    <span className="font-bold text-red-600">
                      {(alarm.forecast_hourly ?? alarm.forecastHourly)?.toFixed?.(1) ?? '-'}mm/hr
                    </span>
                  </div>
                </div>
                <div className="text-xs text-gray-400 mt-2">
                  {new Date(alarm.timestamp).toLocaleString('ko-KR')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default AlarmList;
