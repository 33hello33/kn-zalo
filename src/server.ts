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
  console.log(`🚀 Zalo Node.js Service running on port ${PORT}`);
  console.log(`📡 WebSocket ready for React Frontend connections`);
  console.log(`===================================================`);

  // Auto restore session from Supabase on startup
  try {
    await ZaloClientManager.getInstance().autoRestoreSession();
  } catch (err: any) {
    console.error('[Server Boot] Auto-restore session error:', err.message);
  }
});
