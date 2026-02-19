import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import express from 'express';
import cors from 'cors';
import http from 'http';
import { initDatabase } from './config/database.js';
import { initWebSocket } from './websocket.js';
import { startScheduler } from './scheduler.js';
import apiRouter from './routes/api.js';

const PORT = process.env.PORT || 3000;

async function main() {
  // 환경 변수 검증
  const isMock = process.env.MOCK_MODE === 'true';
  if (!isMock && !process.env.KMA_API_KEY) {
    console.error('ERROR: KMA_API_KEY is not set. Set it in .env or enable MOCK_MODE=true');
    process.exit(1);
  }
  if (isMock) {
    console.warn('========================================');
    console.warn('  WARNING: MOCK_MODE is ON');
    console.warn('  Using fake weather data!');
    console.warn('  Set MOCK_MODE=false for production.');
    console.warn('========================================');
  }

  // Initialize database
  await initDatabase();

  const app = express();
  const server = http.createServer(app);

  // Middleware
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : ['http://localhost:5173'];
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json());

  // API routes
  app.use('/api', apiRouter);

  // Serve static client build in production
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
      res.sendFile(path.join(clientDist, 'index.html'));
    }
  });

  // WebSocket
  initWebSocket(server);

  // Start scheduler
  startScheduler();

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Mock mode: ${process.env.MOCK_MODE === 'true' ? 'ON' : 'OFF'}`);
  });
}

main().catch(console.error);
