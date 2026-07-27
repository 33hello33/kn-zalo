import { API, LoginQRCallbackEventType, Zalo } from 'zca-js';
import { ZaloSessionStore, ZaloSessionData } from './ZaloSessionStore';
import { ZaloMessageStore } from './ZaloMessageStore';
import { broadcastQRUpdate, broadcastStatusChange, broadcastNewMessage } from '../sockets/zaloSocket';
import fs from 'fs';
import path from 'path';
import { imageSize } from 'image-size';

export class ZaloClientManager {
  private static instance: ZaloClientManager;
  private api: API | null = null;
  private zaloId: string | null = null;
  private userProfile: { zaloId?: string; displayName?: string; avatar?: string } | null = null;
  private latestQRData: { qr: string; status: string } = { qr: '', status: 'idle' };

  private constructor() {}

  public static getInstance(): ZaloClientManager {
    if (!ZaloClientManager.instance) {
      ZaloClientManager.instance = new ZaloClientManager();
    }
    return ZaloClientManager.instance;
  }

  private createZaloConfig() {
    return {
      selfListen: false,
      checkUpdate: false,
      logging: false,
      imageMetadataGetter: async (filePath: string) => {
        try {
          const stat = fs.statSync(filePath);
          const buf = fs.readFileSync(filePath);
          const dim = imageSize(buf);
          return {
            width: dim.width ?? 0,
            height: dim.height ?? 0,
            size: stat.size,
          };
        } catch {
          return null;
        }
      },
    };
  }

  /**
   * Start QR Login Process
   */
  public async generateQRLogin(): Promise<{ qr: string; status: string }> {
    if (this.api && this.zaloId) {
      return { qr: '', status: 'already_logged_in' };
    }

    const zalo = new Zalo(this.createZaloConfig());
    let accountInfo = { avatar: '', displayName: '' };

    try {
      this.latestQRData = { qr: '', status: 'waiting' };
      broadcastQRUpdate('', 'waiting');

      const api = await zalo.loginQR(
        {
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        },
        (res: any) => {
          console.log(`[ZaloClientManager] QR Event: ${res.type}`);

          if (res.type === LoginQRCallbackEventType.QRCodeGenerated) {
            const raw: string = res.data?.image || res.data?.qrData || '';
            const qrDataUrl = raw
              ? raw.startsWith('data:')
                ? raw
                : `data:image/png;base64,${raw}`
              : '';

            this.latestQRData = { qr: qrDataUrl, status: 'waiting' };
            broadcastQRUpdate(qrDataUrl, 'waiting');
          }

          if (res.type === LoginQRCallbackEventType.QRCodeExpired) {
            this.latestQRData = { qr: '', status: 'expired' };
            broadcastQRUpdate('', 'expired');
          }

          if (res.type === LoginQRCallbackEventType.QRCodeDeclined) {
            this.latestQRData = { qr: '', status: 'declined' };
            broadcastQRUpdate('', 'declined');
          }

          if (res.type === LoginQRCallbackEventType.QRCodeScanned) {
            accountInfo.avatar = res.data?.avatar || '';
            accountInfo.displayName = res.data?.display_name || '';
            this.latestQRData = { qr: '', status: 'scanned' };
            broadcastQRUpdate('', 'scanned');
          }
        }
      );

      const context = api.getContext();
      const zaloId = api.getOwnId();

      if (!zaloId || !context) {
        this.latestQRData = { qr: '', status: 'error' };
        broadcastQRUpdate('', 'error');
        throw new Error('Đăng nhập QR thất bại');
      }

      this.api = api;
      this.zaloId = zaloId;
      this.userProfile = {
        zaloId,
        displayName: accountInfo.displayName,
        avatar: accountInfo.avatar,
      };

      const cookiesJson = JSON.stringify(context.cookie.serializeSync());
      const sessionData: ZaloSessionData = {
        zalo_id: zaloId,
        full_name: accountInfo.displayName,
        avatar_url: accountInfo.avatar,
        cookies: cookiesJson,
        imei: context.imei,
        user_agent: context.userAgent,
        is_active: true,
      };

      await ZaloSessionStore.saveSession(sessionData);

      this.latestQRData = { qr: '', status: 'success' };
      broadcastQRUpdate('', 'success');
      broadcastStatusChange(true, this.userProfile);

      this.startMessageListener(api);

      return { qr: '', status: 'success' };
    } catch (error: any) {
      console.error('[ZaloClientManager] Error in QR Login:', error.message);
      this.latestQRData = { qr: '', status: 'error' };
      broadcastQRUpdate('', 'error');
      return { qr: '', status: 'error' };
    }
  }

  /**
   * Auto restore session from Supabase on server startup
   */
  public async autoRestoreSession(): Promise<boolean> {
    console.log('[ZaloClientManager] Attempting to auto-restore Zalo session from Supabase...');
    const session = await ZaloSessionStore.getActiveSession();

    if (!session) {
      console.log('[ZaloClientManager] No active session found in Supabase.');
      return false;
    }

    try {
      const zalo = new Zalo(this.createZaloConfig());
      const parsedCookies = JSON.parse(session.cookies);

      const api = await zalo.login({
        cookie: parsedCookies,
        imei: session.imei,
        userAgent: session.user_agent,
      });

      const zaloId = api.getOwnId();
      if (!zaloId) {
        console.warn('[ZaloClientManager] Session restore returned invalid Zalo ID. Expiring session...');
        await ZaloSessionStore.deactivateSession(session.zalo_id);
        return false;
      }

      this.api = api;
      this.zaloId = zaloId;
      this.userProfile = {
        zaloId,
        displayName: session.full_name,
        avatar: session.avatar_url,
      };

      console.log(`[ZaloClientManager] ✅ Auto-restored Zalo session successfully for Zalo ID: ${zaloId}`);
      broadcastStatusChange(true, this.userProfile);

      this.startMessageListener(api);
      return true;
    } catch (err: any) {
      console.error('[ZaloClientManager] Failed to auto-restore session:', err.message);
      return false;
    }
  }

  /**
   * Start listening for incoming Zalo messages
   */
  private startMessageListener(api: API) {
    try {
      api.listener.on('message', (message: any) => {
        console.log('[ZaloListener] New Message:', message);
        broadcastNewMessage({ type: 'zalo_message', data: message });

        // Save incoming message to Supabase
        try {
          const threadId = message.threadId || message.toId || message.uidFrom;
          const senderId = message.uidFrom || message.senderId;
          if (threadId && senderId) {
            ZaloMessageStore.saveMessage({
              msg_id: message.msgId ? String(message.msgId) : undefined,
              thread_id: String(threadId),
              sender_id: String(senderId),
              sender_name: message.dName || message.displayName || '',
              thread_type: message.isGroup ? 'group' : 'user',
              msg_type: message.msgType || 'text',
              content: typeof message.data?.content === 'string' ? message.data.content : (message.content || ''),
              attachments: message.data?.attachments || null,
            });
          }
        } catch (e: any) {
          console.error('[ZaloListener] Error saving incoming message:', e.message);
        }
      });

      api.listener.on('group_event', (eventData: any) => {
        console.log('[ZaloListener] Group Event:', eventData);
        broadcastNewMessage({ type: 'group_event', data: eventData });
      });

      api.listener.start();
      console.log('[ZaloListener] Started real-time message listener.');
    } catch (err: any) {
      console.error('[ZaloListener] Error starting listener:', err.message);
    }
  }

  /**
   * Send a text message to a thread (friend or group)
   */
  public async sendMessage(threadId: string, message: string | { msg: string; attachments?: any[] }, threadType?: number) {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo. Vui lòng quét mã QR trước.');
    }

    const payload = typeof message === 'string' ? { msg: message } : message;
    const result = await this.api.sendMessage(payload, threadId, threadType);

    // Save outgoing message to Supabase
    try {
      const msgContent = typeof message === 'string' ? message : message.msg;
      ZaloMessageStore.saveMessage({
        thread_id: threadId,
        sender_id: this.zaloId || 'me',
        sender_name: this.userProfile?.displayName || 'Me',
        thread_type: threadType === 1 ? 'group' : 'user',
        msg_type: 'text',
        content: msgContent,
      });
    } catch (e: any) {
      console.error('[ZaloClientManager] Error saving sent message:', e.message);
    }

    return result;
  }

  /**
   * Send an image file to a thread (friend or group)
   */
  public async sendImage(threadId: string, filePath: string, threadType?: number, caption?: string, originalName?: string) {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo.');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File không tồn tại: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    // Ưu tiên dùng tên gốc (có đuôi .png/.jpg) thay vì tên file tạm của multer
    const baseName = originalName || path.basename(filePath);
    let width = 0;
    let height = 0;

    try {
      const dim = imageSize(buffer);
      width = dim.width ?? 0;
      height = dim.height ?? 0;
    } catch {}

    const attachment: any = {
      data: buffer,
      filename: baseName,
      metadata: { totalSize: buffer.length, width, height },
    };

    const payload = {
      msg: caption || '',
      attachments: [attachment],
    };

    const result = await this.api.sendMessage(payload, threadId, threadType);

    // Save outgoing image message
    try {
      ZaloMessageStore.saveMessage({
        thread_id: threadId,
        sender_id: this.zaloId || 'me',
        sender_name: this.userProfile?.displayName || 'Me',
        thread_type: threadType === 1 ? 'group' : 'user',
        msg_type: 'image',
        content: caption || `[Hình ảnh] ${baseName}`,
        attachments: [{ filename: baseName, size: buffer.length }],
      });
    } catch (e: any) {
      console.error('[ZaloClientManager] Error saving sent image message:', e.message);
    }

    return result;
  }

  /**
   * Send a general file to a thread (friend or group)
   */
  public async sendFile(threadId: string, filePath: string, threadType?: number) {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo.');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File không tồn tại: ${filePath}`);
    }

    const baseName = path.basename(filePath);
    const payload = {
      msg: '',
      attachments: [filePath],
    };

    const result = await this.api.sendMessage(payload, threadId, threadType);

    // Save outgoing file message
    try {
      ZaloMessageStore.saveMessage({
        thread_id: threadId,
        sender_id: this.zaloId || 'me',
        sender_name: this.userProfile?.displayName || 'Me',
        thread_type: threadType === 1 ? 'group' : 'user',
        msg_type: 'file',
        content: `[File] ${baseName}`,
        attachments: [{ filename: baseName }],
      });
    } catch (e: any) {
      console.error('[ZaloClientManager] Error saving sent file message:', e.message);
    }

    return result;
  }

  /**
   * Get group chat history (up to count messages, default 50)
   */
  public async getGroupChatHistory(groupId: string, count: number = 50) {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo.');
    }

    const history = await this.api.getGroupChatHistory(groupId, count);
    return history;
  }

  /**
   * Get list of friends
   */
  public async getFriends() {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo.');
    }
    const friends = await this.api.getAllFriends();
    return friends;
  }

  /**
   * Get list of groups
   */
  public async getGroups() {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo.');
    }
    const groups = await this.api.getAllGroups();
    return groups;
  }

  /**
   * Get status & current logged in user
   */
  public getStatus() {
    return {
      isLoggedIn: !!(this.api && this.zaloId),
      user: this.userProfile,
      latestQR: this.latestQRData,
    };
  }

  /**
   * Logout current user
   */
  public async logout() {
    if (this.zaloId) {
      await ZaloSessionStore.deactivateSession(this.zaloId);
    }
    this.api = null;
    this.zaloId = null;
    this.userProfile = null;
    this.latestQRData = { qr: '', status: 'idle' };

    broadcastStatusChange(false);
    return true;
  }
}
