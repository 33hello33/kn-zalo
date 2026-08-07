import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import zaloRoutes from './routes/zaloRoutes';
import { initSocketServer } from './sockets/zaloSocket';
import { ZaloClientManager } from './services/ZaloClientManager';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve static uploaded files
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Routes
app.use('/api/zalo', zaloRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Zalo Node.js Backend Service' });
});

// Create HTTP Server & Initialize Socket.IO
const httpServer = http.createServer(app);
initSocketServer(httpServer);

// Start Server
httpServer.listen(PORT, async () => {
  console.log(`===================================================`);
  console.log(`🚀 Multi-Tenant Zalo Service running on port ${PORT}`);
  console.log(`📡 WebSocket ready with per-app room isolation`);
  console.log(`===================================================`);

  // Auto restore sessions for default instance on boot
  try {
    await ZaloClientManager.getInstance('default').autoRestoreSession();
  } catch (err: any) {
    console.error('[Server Boot] Auto-restore default session error:', err.message);
  }
});
