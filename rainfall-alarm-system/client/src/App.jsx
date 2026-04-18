import { useState, useEffect, useRef } from 'react';
import MetroSelector from './components/MetroSelector';
import DistrictSelector from './components/DistrictSelector';
import EmdMap from './components/EmdMap';
import AlarmList from './components/AlarmList';
import AdminHistory from './components/AdminHistory';

// 세종시는 기초자치단체 없이 바로 지도 표시
const DIRECT_MAP_METROS = { '36': true }; // 세종

function App() {
  const [selectedMetro, setSelectedMetro] = useState(null);
  const [selectedDistrict, setSelectedDistrict] = useState(null);
  const [directMapMode, setDirectMapMode] = useState(false);

  // 운영자 모드
  const titleClickCount = useRef(0);
  const titleClickTimer = useRef(null);
  const [showPwModal, setShowPwModal] = useState(false);
  const [pwInput, setPwInput] = useState('');
  const [pwError, setPwError] = useState(false);
  const [showAdmin, setShowAdmin] = useState(
    () => sessionStorage.getItem('adminAuth') === '1'
  );

  const handleTitleClick = () => {
    titleClickCount.current += 1;
    clearTimeout(titleClickTimer.current);
    if (titleClickCount.current >= 3) {
      titleClickCount.current = 0;
      setShowPwModal(true);
      setPwInput('');
      setPwError(false);
    } else {
      titleClickTimer.current = setTimeout(() => { titleClickCount.current = 0; }, 800);
    }
  };

  const handlePwSubmit = (e) => {
    e.preventDefault();
    if (pwInput === '2100') {
      sessionStorage.setItem('adminAuth', '1');
      setShowAdmin(true);
      setShowPwModal(false);
    } else {
      setPwError(true);
    }
  };

  const handleAdminClose = () => {
    setShowAdmin(false);
    sessionStorage.removeItem('adminAuth');
  };

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
      {/* 비밀번호 모달 */}
      {showPwModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center">
          <form
            onSubmit={handlePwSubmit}
            className="bg-white rounded-xl shadow-2xl p-8 flex flex-col gap-4 w-72"
          >
            <h2 className="text-base font-bold text-gray-800 text-center">운영자 인증</h2>
            <input
              autoFocus
              type="password"
              value={pwInput}
              onChange={e => { setPwInput(e.target.value); setPwError(false); }}
              placeholder="비밀번호"
              className="border rounded-lg px-4 py-2 text-center text-lg tracking-widest outline-none focus:border-blue-500"
            />
            {pwError && <p className="text-red-500 text-sm text-center">비밀번호가 틀렸습니다.</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowPwModal(false)}
                className="flex-1 py-2 rounded-lg border text-gray-500 hover:bg-gray-50"
              >취소</button>
              <button
                type="submit"
                className="flex-1 py-2 rounded-lg bg-blue-700 text-white hover:bg-blue-600"
              >확인</button>
            </div>
          </form>
        </div>
      )}
      {/* 운영자 이력 오버레이 */}
      {showAdmin && <AdminHistory onClose={handleAdminClose} />}
      {/* Header */}
      <header className="bg-blue-700 text-white shadow-lg">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <h1
            className="text-xl font-bold whitespace-nowrap cursor-default select-none"
            onClick={handleTitleClick}
          >
            주민대피 알람
          </h1>
          {!selectedMetro ? (
            /* 초기 화면: 측정 주기 안내 배지 */
            <span className="text-right text-xs text-blue-200 leading-snug">
              호우특보지역 <span className="text-white font-semibold">5분</span> 단위 측정
            </span>
          ) : (
            <button
              onClick={handleBack}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm transition-colors whitespace-nowrap"
            >
              뒤로가기
            </button>
          )}
        </div>
        {/* Breadcrumb */}
        {selectedMetro && (
          <div className="max-w-7xl mx-auto px-4 pb-3 text-blue-200 text-sm break-keep">
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
                <EmdMap
                  metroId={selectedMetro.id}
                  districtName={selectedMetro.name}
                  districtCode={selectedMetro.code}
                  isMetroMode={true}
                />
              ) : (
                <EmdMap
                  districtId={selectedDistrict.id}
                  districtName={selectedDistrict.name}
                  districtCode={selectedDistrict.code}
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
