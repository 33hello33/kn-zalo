import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import zaloRoutes from './routes/zaloRoutes';
import { initSocketServer } from './sockets/zaloSocket';
import { ZaloClientManager } from './services/ZaloClientManager';

dotenv.config();

// ── Global safety net ──────────────────────────────────────────────────────────
// Catches any unhandled error that was not caught by a more specific handler
// (e.g. a missing EventEmitter 'error' listener in a third-party library).
// Without these, Node.js would kill the entire process on the first unhandled
// error — which is what caused the "Cannot use 'in' operator" zca-js crash.
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception (server kept alive):', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Promise Rejection (server kept alive):', reason);
});

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
