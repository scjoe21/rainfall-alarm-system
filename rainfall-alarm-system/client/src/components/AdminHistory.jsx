import { useState, useEffect } from 'react';

function AdminHistory({ onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/alarms/aws?limit=500')
      .then(r => r.json())
      .then(data => { setLogs(data); setLoading(false); })
      .catch(() => { setError('데이터를 불러오지 못했습니다.'); setLoading(false); });
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b bg-gray-800 rounded-t-xl">
          <div>
            <h2 className="text-lg font-bold text-white">운영자 모드</h2>
            <p className="text-xs text-gray-400 mt-0.5">알람 발생 이력 (최근 90일)</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-2xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {loading && (
            <div className="text-center py-16 text-gray-400">불러오는 중...</div>
          )}
          {error && (
            <div className="text-center py-16 text-red-500">{error}</div>
          )}
          {!loading && !error && logs.length === 0 && (
            <div className="text-center py-16 text-gray-400">이력이 없습니다.</div>
          )}
          {!loading && !error && logs.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-gray-100 sticky top-0">
                <tr>
                  <th className="text-left px-4 py-3 text-gray-600 font-semibold">날짜 / 시각</th>
                  <th className="text-left px-4 py-3 text-gray-600 font-semibold">관측소</th>
                  <th className="text-right px-4 py-3 text-gray-600 font-semibold">15분 실측</th>
                  <th className="text-right px-4 py-3 text-gray-600 font-semibold">1시간 예보</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, i) => (
                  <tr key={log.id ?? i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString('ko-KR', {
                        year: 'numeric', month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit'
                      })}
                    </td>
                    <td className="px-4 py-2.5 text-gray-800 font-medium">{log.station_name}</td>
                    <td className="px-4 py-2.5 text-right text-orange-600 font-semibold">
                      {log.realtime_15min?.toFixed(1)}mm
                    </td>
                    <td className="px-4 py-2.5 text-right text-red-600 font-semibold">
                      {log.forecast_hourly?.toFixed(1)}mm/hr
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-6 py-3 border-t text-xs text-gray-400 bg-gray-50 rounded-b-xl">
          총 {logs.length}건
        </div>
      </div>
    </div>
  );
}

export default AdminHistory;
