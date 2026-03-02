import { Server } from 'socket.io';

let io;

export function initWebSocket(httpServer) {
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:3000'];

  io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('subscribe_district', (districtId) => {
      // Leave previous rooms
      for (const room of socket.rooms) {
        if (room.startsWith('district_')) socket.leave(room);
      }
      socket.join(`district_${districtId}`);
      console.log(`${socket.id} subscribed to district ${districtId}`);
    });

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

export function getIO() {
  return io;
}

export function emitAlarm(alarm) {
  if (!io) return;
  // Emit to all clients
  io.emit('alarm', alarm);
  // AWS 관측소 기준: stationName, stn_id (districtId 없음) → 전체 구독자에게 rainfall_update
  // 기존 emd 기준: districtId 있으면 해당 구역 구독자에게만
  if (alarm.stationName) {
    io.emit('rainfall_update', {
      stationName: alarm.stationName,
      stn_id: alarm.stn_id,
      realtime_15min: alarm.realtime15min,
      forecast_hourly: alarm.forecastHourly,
    });
  } else if (alarm.districtId) {
    io.to(`district_${alarm.districtId}`).emit('rainfall_update', {
      emdCode: alarm.emdCode,
      realtime_15min: alarm.realtime15min,
      forecast_hourly: alarm.forecastHourly,
    });
  }
}

export function emitAlarmCounts(counts) {
  if (!io) return;
  io.emit('alarm_counts', counts);
}

export function emitAlertState(alertState) {
  if (!io) return;
  io.emit('alert_state', alertState);
}
