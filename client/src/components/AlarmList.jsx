import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

function AlarmList({ districtId, metroId }) {
  const [alarms, setAlarms] = useState([]);
  const [loading, setLoading] = useState(true);

  const apiUrl = metroId
    ? `/api/alarms/metro/${metroId}?limit=20`
    : `/api/alarms/${districtId}?limit=20`;

  useEffect(() => {
    fetch(apiUrl)
      .then(res => res.json())
      .then(data => {
        setAlarms(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load alarms:', err);
        setLoading(false);
      });

    const socket = io();
    socket.on('alarm', alarm => {
      setAlarms(prev => [alarm, ...prev].slice(0, 50));
    });

    return () => socket.disconnect();
  }, [apiUrl]);

  return (
    <div className="bg-white rounded-xl shadow-lg overflow-hidden">
      <div className="p-4 border-b bg-red-50">
        <h3 className="text-lg font-bold text-red-700">
          경보 발생 지역
        </h3>
        <p className="text-sm text-red-500 mt-1">
          15분 실시간 &gt; 20mm 이면서 60분 총계 &gt; 55mm
        </p>
      </div>

      <div className="p-4 max-h-[500px] overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-500"></div>
          </div>
        ) : alarms.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            <p className="text-4xl mb-2">---</p>
            <p>현재 경보가 없습니다</p>
          </div>
        ) : (
          <div className="space-y-3">
            {alarms.map((alarm, idx) => (
              <div
                key={alarm.id || idx}
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
                    예측 45분:{' '}
                    <span className="font-semibold text-yellow-600">
                      {(alarm.forecast_45min ?? alarm.forecast45min)?.toFixed?.(1) ?? '-'}mm
                    </span>
                  </div>
                  <div>
                    총계 60분:{' '}
                    <span className="font-bold text-red-600">
                      {(alarm.total_60min ?? alarm.total60min)?.toFixed?.(1) ?? '-'}mm
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
