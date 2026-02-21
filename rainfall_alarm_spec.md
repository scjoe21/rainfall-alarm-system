# 실시간 강우량 알람 시스템 구현 명세서

## 프로젝트 개요
기상청 기상자료개방포털 API의 AWS 분 단위 자료를 활용하여, 읍면동 단위로 실시간 강우량을 모니터링하고 지도에서 시각적 알람을 제공하는 반응형 웹사이트

## 핵심 요구사항

### 알람 발동 조건
1. **15분 실시간 강우량 > 20mm**
2. **(15분 실시간 + 45분 예측) > 55mm**
3. 조건 충족 시 해당 읍면동이 지도에서 깜빡임

### 사용자 플로우
```
접속 → 광역자치단체 선택 → 기초자치단체 선택 → 읍면동 지도 표시
```

## 기술 스택

### 백엔드
- Node.js + Express
- SQLite/PostgreSQL
- WebSocket (Socket.io)
- node-cron (15분 단위 스케줄링)

### 프론트엔드
- React.js + Vite
- Tailwind CSS
- Leaflet.js (지도)
- Socket.io-client

### 데이터 소스
- 기상청 기상자료개방포털 (data.kma.go.kr)
- AWS 실시간 관측자료 API (분 단위)
- 초단기예보 API (45분 예측)
- 행정구역 GeoJSON (읍면동 경계)

## 데이터베이스 스키마

```sql
-- 광역자치단체
CREATE TABLE metros (
  id INTEGER PRIMARY KEY,
  code VARCHAR(2),
  name VARCHAR(50)
);

-- 기초자치단체
CREATE TABLE districts (
  id INTEGER PRIMARY KEY,
  metro_id INTEGER,
  code VARCHAR(5),
  name VARCHAR(50),
  geojson TEXT,
  FOREIGN KEY (metro_id) REFERENCES metros(id)
);

-- 읍면동
CREATE TABLE emds (
  id INTEGER PRIMARY KEY,
  district_id INTEGER,
  code VARCHAR(10),
  name VARCHAR(50),
  geojson TEXT,
  FOREIGN KEY (district_id) REFERENCES districts(id)
);

-- 관측소
CREATE TABLE weather_stations (
  id INTEGER PRIMARY KEY,
  stn_id VARCHAR(10) UNIQUE,
  name VARCHAR(50),
  lat DECIMAL(10, 6),
  lon DECIMAL(10, 6),
  emd_id INTEGER,
  FOREIGN KEY (emd_id) REFERENCES emds(id)
);

-- 15분 실시간 강우량
CREATE TABLE rainfall_realtime (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER,
  timestamp DATETIME,
  rainfall_15min DECIMAL(5, 1),
  FOREIGN KEY (station_id) REFERENCES weather_stations(id),
  INDEX idx_timestamp (timestamp)
);

-- 45분 예측 강우량
CREATE TABLE rainfall_forecast (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER,
  base_time DATETIME,
  forecast_time DATETIME,
  rainfall_forecast DECIMAL(5, 1),
  FOREIGN KEY (station_id) REFERENCES weather_stations(id)
);

-- 알람 설정
CREATE TABLE alarm_settings (
  id INTEGER PRIMARY KEY,
  district_id INTEGER,
  realtime_threshold DECIMAL(5, 1) DEFAULT 20.0,
  total_threshold DECIMAL(5, 1) DEFAULT 55.0,
  is_active BOOLEAN DEFAULT 1,
  FOREIGN KEY (district_id) REFERENCES districts(id)
);

-- 알람 이력
CREATE TABLE alarm_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emd_id INTEGER,
  station_id INTEGER,
  realtime_15min DECIMAL(5, 1),
  forecast_45min DECIMAL(5, 1),
  total_60min DECIMAL(5, 1),
  timestamp DATETIME,
  FOREIGN KEY (emd_id) REFERENCES emds(id)
);
```

## 백엔드 핵심 로직

### 1. KMA API Service (server/services/kmaAPI.js)

```javascript
// AWS 분 단위 데이터로 15분 강우량 계산
async getAWSRealtime15min(stnId) {
  // 현재부터 15분 전까지의 분 단위 데이터 합산
  // API: /1360000/AwsServiceInfoService/getAwsRealTimeInfo
}

// 초단기예보로 45분 예측 강우량 계산
async getForecast45min(nx, ny) {
  // 현재부터 45분 후까지의 예보 합산
  // API: /1360000/VilageFcstInfoService_2.0/getUltraSrtFcst
}

// 위경도 → 격자좌표 변환
convertToGrid(lat, lon) {
  // 기상청 제공 변환식 사용
}
```

### 2. Alarm Service (server/services/alarmService.js)

```javascript
async checkAlarmCondition(station) {
  // 1. AWS로 15분 실시간 강우량 조회
  const realtime15min = await kma.getAWSRealtime15min(station.stn_id);
  
  // 조건 1 체크
  if (realtime15min <= 20) return null;
  
  // 2. 격자 좌표 변환
  const { nx, ny } = kma.convertToGrid(station.lat, station.lon);
  
  // 3. 45분 예측 강우량 조회
  const forecast45min = await kma.getForecast45min(nx, ny);
  
  // 4. 총 강우량 계산
  const total60min = realtime15min + forecast45min;
  
  // 조건 2 체크
  if (total60min > 55) {
    // 알람 발동
    await saveAlarmLog({...});
    return { realtime15min, forecast45min, total60min, ... };
  }
  
  return null;
}
```

### 3. Scheduler (server/scheduler.js)

```javascript
// 15분마다 실행 (0, 15, 30, 45분)
cron.schedule('*/15 * * * *', async () => {
  const stations = await db.all('SELECT * FROM weather_stations');
  
  for (const station of stations) {
    const alarm = await alarmService.checkAlarmCondition(station);
    
    if (alarm) {
      // WebSocket으로 클라이언트에 전송
      io.emit('alarm', {
        emdCode: station.emd_code,
        emdName: station.emd_name,
        ...alarm
      });
    }
  }
});
```

## 프론트엔드 핵심 컴포넌트

### 1. App.jsx - 메인 네비게이션

```javascript
function App() {
  const [selectedMetro, setSelectedMetro] = useState(null);
  const [selectedDistrict, setSelectedDistrict] = useState(null);
  
  return (
    <div>
      {!selectedMetro ? (
        <MetroSelector onSelect={setSelectedMetro} />
      ) : !selectedDistrict ? (
        <DistrictSelector metroId={selectedMetro.id} onSelect={setSelectedDistrict} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <EmdMap districtId={selectedDistrict.id} />
          </div>
          <div className="lg:col-span-1">
            <AlarmList districtId={selectedDistrict.id} />
          </div>
        </div>
      )}
    </div>
  );
}
```

### 2. MetroSelector.jsx - 광역 선택

```javascript
function MetroSelector({ onSelect }) {
  const [metros, setMetros] = useState([]);
  
  useEffect(() => {
    fetch('/api/metros').then(res => res.json()).then(setMetros);
  }, []);
  
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {metros.map(metro => (
        <button key={metro.id} onClick={() => onSelect(metro)}>
          {metro.name}
        </button>
      ))}
    </div>
  );
}
```

### 3. DistrictSelector.jsx - 기초자치단체 선택

```javascript
function DistrictSelector({ metroId, onSelect }) {
  const [districts, setDistricts] = useState([]);
  const [alarmCounts, setAlarmCounts] = useState({});
  
  useEffect(() => {
    fetch(`/api/metros/${metroId}/districts`).then(res => res.json()).then(setDistricts);
    fetch(`/api/metros/${metroId}/alarm-counts`).then(res => res.json()).then(setAlarmCounts);
    
    // WebSocket으로 실시간 알람 카운트 업데이트
    const socket = io();
    socket.on('alarm_counts', setAlarmCounts);
    return () => socket.disconnect();
  }, [metroId]);
  
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
      {districts.map(district => {
        const alarmCount = alarmCounts[district.id] || 0;
        return (
          <button 
            key={district.id} 
            onClick={() => onSelect(district)}
            className={alarmCount > 0 ? 'ring-2 ring-red-500 animate-pulse' : ''}
          >
            {district.name}
            {alarmCount > 0 && <span className="badge">{alarmCount}</span>}
          </button>
        );
      })}
    </div>
  );
}
```

### 4. EmdMap.jsx - 읍면동 지도 (핵심)

```javascript
function EmdMap({ districtId }) {
  const [emdGeoJSON, setEmdGeoJSON] = useState(null);
  const [rainfallData, setRainfallData] = useState({});
  const [alarmEmds, setAlarmEmds] = useState(new Set());
  
  useEffect(() => {
    // GeoJSON 로드
    fetch(`/api/geojson/district/${districtId}`)
      .then(res => res.json())
      .then(setEmdGeoJSON);
    
    // 강우량 데이터 로드
    fetch(`/api/rainfall/district/${districtId}`)
      .then(res => res.json())
      .then(data => {
        const map = {};
        data.forEach(item => {
          map[item.emd_code] = {
            realtime_15min: item.realtime_15min,
            forecast_45min: item.forecast_45min,
            total_60min: item.total_60min
          };
        });
        setRainfallData(map);
      });
    
    // WebSocket 연결
    const socket = io();
    socket.emit('subscribe_district', districtId);
    
    // 실시간 업데이트
    socket.on('rainfall_update', update => {
      setRainfallData(prev => ({
        ...prev,
        [update.emdCode]: update
      }));
    });
    
    // 알람 수신
    socket.on('alarm', alarm => {
      setAlarmEmds(prev => new Set([...prev, alarm.emdCode]));
      setTimeout(() => {
        setAlarmEmds(prev => {
          const newSet = new Set(prev);
          newSet.delete(alarm.emdCode);
          return newSet;
        });
      }, 10000); // 10초 깜빡임
    });
    
    return () => socket.disconnect();
  }, [districtId]);
  
  const getEmdStyle = (feature) => {
    const emdCode = feature.properties.EMD_CD;
    const data = rainfallData[emdCode];
    const isAlarming = alarmEmds.has(emdCode);
    
    let fillColor = '#ffffff';
    if (data) {
      const total = data.total_60min;
      if (total >= 55) fillColor = '#dc2626';      // 빨강
      else if (total >= 40) fillColor = '#f97316'; // 주황
      else if (total >= 20) fillColor = '#fbbf24'; // 노랑
      else if (total > 0) fillColor = '#60a5fa';   // 파랑
    }
    
    return {
      fillColor,
      weight: isAlarming ? 4 : 2,
      color: isAlarming ? '#dc2626' : '#334155',
      fillOpacity: 0.6,
      className: isAlarming ? 'blinking-border' : ''
    };
  };
  
  const onEachEmd = (feature, layer) => {
    const emdCode = feature.properties.EMD_CD;
    const emdName = feature.properties.EMD_NM;
    const data = rainfallData[emdCode];
    
    if (data) {
      layer.bindTooltip(`
        <div><strong>${emdName}</strong></div>
        <div>15분 실시간: ${data.realtime_15min.toFixed(1)}mm</div>
        <div>45분 예측: ${data.forecast_45min.toFixed(1)}mm</div>
        <div>60분 총계: ${data.total_60min.toFixed(1)}mm</div>
      `);
    }
  };
  
  return (
    <MapContainer center={[37.5665, 126.9780]} zoom={11}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      {emdGeoJSON && (
        <GeoJSON data={emdGeoJSON} style={getEmdStyle} onEachFeature={onEachEmd} />
      )}
    </MapContainer>
  );
}
```

### 5. AlarmList.jsx - 알람 목록

```javascript
function AlarmList({ districtId }) {
  const [alarms, setAlarms] = useState([]);
  
  useEffect(() => {
    fetch(`/api/alarms/${districtId}?limit=20`)
      .then(res => res.json())
      .then(setAlarms);
    
    const socket = io();
    socket.on('alarm', alarm => {
      setAlarms(prev => [alarm, ...prev]);
    });
    
    return () => socket.disconnect();
  }, [districtId]);
  
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-bold mb-4">🔴 경보 발생 지역</h3>
      {alarms.map((alarm, idx) => (
        <div key={idx} className="border-l-4 border-red-500 pl-4 py-3 mb-3">
          <div className="font-bold">{alarm.emd_name}</div>
          <div className="text-sm">
            실시간: {alarm.realtime_15min.toFixed(1)}mm | 
            예측: {alarm.forecast_45min.toFixed(1)}mm | 
            총계: {alarm.total_60min.toFixed(1)}mm
          </div>
          <div className="text-xs text-gray-500">
            {new Date(alarm.timestamp).toLocaleString('ko-KR')}
          </div>
        </div>
      ))}
    </div>
  );
}
```

## CSS 애니메이션

```css
/* 깜빡이는 테두리 */
@keyframes blink-border {
  0%, 100% { stroke-width: 4px; stroke-opacity: 1; }
  50% { stroke-width: 6px; stroke-opacity: 0.5; }
}

.blinking-border {
  animation: blink-border 1s ease-in-out infinite;
}
```

## API 엔드포인트

```
GET  /api/metros                           - 광역자치단체 목록
GET  /api/metros/:metroId/districts        - 기초자치단체 목록
GET  /api/metros/:metroId/alarm-counts     - 기초자치단체별 알람 카운트
GET  /api/geojson/district/:districtId     - 읍면동 GeoJSON
GET  /api/rainfall/district/:districtId    - 읍면동별 현재 강우량
GET  /api/alarms/:districtId               - 알람 이력
```

## WebSocket 이벤트

```javascript
// 클라이언트 → 서버
socket.emit('subscribe_district', districtId);

// 서버 → 클라이언트
socket.on('rainfall_update', { emdCode, realtime_15min, forecast_45min, total_60min });
socket.on('alarm', { emdCode, emdName, realtime_15min, forecast_45min, total_60min });
socket.on('alarm_counts', { [districtId]: count });
```

## 프로젝트 구조

```
rainfall-alarm-system/
├── server/
│   ├── config/
│   │   └── database.js
│   ├── services/
│   │   ├── kmaAPI.js
│   │   └── alarmService.js
│   ├── routes/
│   │   └── api.js
│   ├── scheduler.js
│   ├── websocket.js
│   └── server.js
├── client/
│   ├── src/
│   │   ├── components/
│   │   │   ├── MetroSelector.jsx
│   │   │   ├── DistrictSelector.jsx
│   │   │   ├── EmdMap.jsx
│   │   │   └── AlarmList.jsx
│   │   ├── styles/
│   │   │   └── map.css
│   │   ├── App.jsx
│   │   └── main.jsx
│   └── package.json
└── data/
    ├── geojson/
    └── stations.json
```

## 환경 변수

```env
KMA_API_KEY=your_api_key_here
PORT=3000
DATABASE_URL=sqlite:./rainfall.db
```

## 주요 NPM 패키지

### 백엔드
```json
{
  "express": "^4.18.0",
  "socket.io": "^4.6.0",
  "node-cron": "^3.0.0",
  "axios": "^1.6.0",
  "sqlite3": "^5.1.0"
}
```

### 프론트엔드
```json
{
  "react": "^18.2.0",
  "react-leaflet": "^4.2.0",
  "leaflet": "^1.9.0",
  "socket.io-client": "^4.6.0",
  "tailwindcss": "^3.4.0"
}
```

## 개발 순서

1. **환경 설정**
   - 기상청 API 키 발급
   - 프로젝트 초기화
   - DB 스키마 생성

2. **데이터 준비**
   - 행정구역 GeoJSON 수집
   - 관측소-읍면동 매핑

3. **백엔드 개발**
   - KMA API 연동
   - 알람 로직 구현
   - 스케줄러 구현
   - WebSocket 서버

4. **프론트엔드 개발**
   - 컴포넌트 구조
   - 지도 시각화
   - 실시간 업데이트

5. **통합 및 테스트**
   - 엔드투엔드 테스트
   - 성능 최적화
   - 반응형 디자인

## 중요 고려사항

1. **API 호출 최적화**: 캐싱으로 불필요한 호출 방지
2. **15분 강우량 정확도**: AWS 분 단위 데이터 합산
3. **관측소 커버리지**: 관측소 없는 지역 처리
4. **GeoJSON 용량**: TopoJSON 변환으로 용량 절감
5. **실시간 성능**: WebSocket + DB 인덱싱 최적화
