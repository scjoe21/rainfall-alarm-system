import { useState } from 'react';
import MetroSelector from './components/MetroSelector';
import DistrictSelector from './components/DistrictSelector';
import StationList from './components/StationList';
import AlarmList from './components/AlarmList';

// 세종시는 기초자치단체 없이 바로 지도 표시
const DIRECT_MAP_METROS = { '36': true }; // 세종

function App() {
  const [selectedMetro, setSelectedMetro] = useState(null);
  const [selectedDistrict, setSelectedDistrict] = useState(null);
  const [directMapMode, setDirectMapMode] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState(null);

  const handleMetroSelect = (metro) => {
    setSelectedMetro(metro);
    if (DIRECT_MAP_METROS[metro.code]) {
      // 세종처럼 바로 지도 모드 → district 선택 건너뜀
      setDirectMapMode(true);
      setSelectedDistrict(null);
    } else {
      setDirectMapMode(false);
    }
  };

  const handleLocate = () => {
    if (!navigator.geolocation) {
      setLocateError('이 브라우저는 위치 서비스를 지원하지 않습니다.');
      return;
    }
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const res = await fetch(`/api/locate?lat=${coords.latitude}&lon=${coords.longitude}`);
          if (!res.ok) throw new Error('위치 조회 실패');
          const data = await res.json();
          setSelectedMetro(data.metro);
          if (DIRECT_MAP_METROS[data.metro.code]) {
            setDirectMapMode(true);
            setSelectedDistrict(null);
          } else {
            setDirectMapMode(false);
            setSelectedDistrict(data.district);
          }
        } catch {
          setLocateError('위치 기반 지역 조회에 실패했습니다.');
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocateError('위치 정보를 가져올 수 없습니다.');
        setLocating(false);
      },
      { timeout: 10000 }
    );
  };

  const handleBack = () => {
    if (selectedDistrict) {
      setSelectedDistrict(null);
    } else if (selectedMetro) {
      setSelectedMetro(null);
      setDirectMapMode(false);
    }
  };

  // 지도 표시 조건: district 선택됨 OR directMapMode
  const showMap = selectedDistrict || directMapMode;

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-blue-700 text-white shadow-lg">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-bold">
            실시간 강우량 알람 시스템
          </h1>
          <div className="flex items-center gap-2">
            <button
              onClick={handleLocate}
              disabled={locating}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded-lg text-sm transition-colors flex items-center gap-1.5"
            >
              {locating ? (
                <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <span>📍</span>
              )}
              현재 위치
            </button>
            {selectedMetro && (
              <button
                onClick={handleBack}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm transition-colors"
              >
                뒤로가기
              </button>
            )}
          </div>
        </div>
        {locateError && (
          <div className="max-w-7xl mx-auto px-4 pb-2">
            <p className="text-red-300 text-xs">{locateError}</p>
          </div>
        )}
        {/* Breadcrumb */}
        {selectedMetro && (
          <div className="max-w-7xl mx-auto px-4 pb-3 text-blue-200 text-sm">
            <span
              className="cursor-pointer hover:text-white"
              onClick={() => { setSelectedMetro(null); setSelectedDistrict(null); setDirectMapMode(false); }}
            >
              전체
            </span>
            <span className="mx-2">&gt;</span>
            <span
              className={selectedDistrict ? 'cursor-pointer hover:text-white' : 'text-white'}
              onClick={() => {
                if (selectedDistrict) setSelectedDistrict(null);
                if (directMapMode) { setSelectedMetro(null); setDirectMapMode(false); }
              }}
            >
              {selectedMetro.name}
            </span>
            {selectedDistrict && (
              <>
                <span className="mx-2">&gt;</span>
                <span className="text-white">{selectedDistrict.name}</span>
              </>
            )}
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {!selectedMetro ? (
          <MetroSelector onSelect={handleMetroSelect} />
        ) : showMap ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              {directMapMode ? (
                <StationList
                  metroId={selectedMetro.id}
                  districtName={selectedMetro.name}
                />
              ) : (
                <StationList
                  districtId={selectedDistrict.id}
                  districtName={selectedDistrict.name}
                />
              )}
            </div>
            <div className="lg:col-span-1">
              {directMapMode ? (
                <AlarmList metroId={selectedMetro.id} />
              ) : (
                <AlarmList districtId={selectedDistrict.id} />
              )}
            </div>
          </div>
        ) : (
          <DistrictSelector
            metroId={selectedMetro.id}
            metroName={selectedMetro.name}
            onSelect={setSelectedDistrict}
          />
        )}
      </main>
    </div>
  );
}

export default App;
