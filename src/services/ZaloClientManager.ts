import { API, LoginQRCallbackEventType, Zalo } from 'zca-js';
import { ZaloSessionStore, ZaloSessionData } from './ZaloSessionStore';
import { broadcastQRUpdate, broadcastStatusChange, broadcastNewMessage } from '../sockets/zaloSocket';
import fs from 'fs';
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
      selfListen: true,
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

      const api = await zalo.loginCookie({
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
        console.log('[ZaloListener] New Direct Message:', message);
        broadcastNewMessage({ type: 'user_message', data: message });
      });

      api.listener.on('group_message', (message: any) => {
        console.log('[ZaloListener] New Group Message:', message);
        broadcastNewMessage({ type: 'group_message', data: message });
      });

      api.listener.start();
      console.log('[ZaloListener] Started real-time message listener.');
    } catch (err: any) {
      console.error('[ZaloListener] Error starting listener:', err.message);
    }
  }

  /**
   * Send a message to a thread (friend or group)
   */
  public async sendMessage(threadId: string, message: string | { msg: string; attachments?: any[] }, threadType?: number) {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo. Vui lòng quét mã QR trước.');
    }

    const payload = typeof message === 'string' ? { msg: message } : message;
    const result = await this.api.sendMessage(payload, threadId, threadType);
    return result;
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
