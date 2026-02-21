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
  // Emit to specific district room
  if (alarm.districtId) {
    io.to(`district_${alarm.districtId}`).emit('rainfall_update', {
      emdCode: alarm.emdCode,
      realtime_15min: alarm.realtime15min,
      forecast_45min: alarm.forecast45min,
      total_60min: alarm.total60min,
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
