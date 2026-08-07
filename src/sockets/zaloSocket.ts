import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';

let io: SocketIOServer | null = null;

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket: Socket) => {
    const appId = (socket.handshake.query.appId as string) || 'default';
    socket.join(`app_${appId}`);
    console.log(`[Socket.IO] Client connected: ${socket.id} -> Room: app_${appId}`);

    socket.on('disconnect', () => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
    });
  });

  console.log('[Socket.IO] Server initialized.');
  return io;
}

export function getSocketIO(): SocketIOServer | null {
  return io;
}

export function broadcastQRUpdate(appId: string, qrDataUrl: string, status: 'waiting' | 'scanned' | 'success' | 'expired' | 'declined' | 'error') {
  if (io) {
    io.to(`app_${appId}`).emit('zalo-qr-update', { qr: qrDataUrl, status });
  }
}

export function broadcastStatusChange(appId: string, isLoggedIn: boolean, user?: any) {
  if (io) {
    io.to(`app_${appId}`).emit('zalo-status-change', { isLoggedIn, user });
  }
}

export function broadcastNewMessage(appId: string, messageData: any) {
  if (io) {
    io.to(`app_${appId}`).emit('zalo-message-received', messageData);
  }
}
