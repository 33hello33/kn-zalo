import { API, LoginQRCallbackEventType, Zalo } from 'zca-js';
import { ZaloSessionStore, ZaloSessionData } from './ZaloSessionStore';
import { ZaloMessageStore } from './ZaloMessageStore';
import { broadcastQRUpdate, broadcastStatusChange, broadcastNewMessage } from '../sockets/zaloSocket';
import fs from 'fs';
import path from 'path';
import { imageSize } from 'image-size';
import { uploadMediaFile } from './ZaloStorageService';

export const ZALO_SESSION_INVALID_CODE = 'ZALO_SESSION_INVALID';
export const ZALO_NOT_LOGGED_IN_MESSAGE = 'Chưa đăng nhập Zalo. Vui lòng quét mã QR đăng nhập.';
export const ZALO_SESSION_INVALID_MESSAGE =
  'Phiên đăng nhập Zalo đã hết hiệu lực (cookie zpw_sek không còn hợp lệ). Vui lòng quét mã QR đăng nhập lại.';

/**
 * Zalo trả về "zpw_sek bị thiếu hoặc không đúng" (hoặc lỗi tương tự) khi cookie phiên
 * đã bị Zalo vô hiệu hoá. Khi đó phải đăng nhập QR lại, retry bằng cookie cũ sẽ không bao giờ thành công.
 */
const SESSION_INVALID_PATTERN =
  /zpw_sek|zpw_ver|zpw_type|chưa đăng nhập|đăng nhập thất bại|hết hiệu lực|unauthor|invalid session|session expired|401|403/i;

export const isSessionInvalidError = (err: any): boolean =>
  SESSION_INVALID_PATTERN.test(String(err?.message || err || ''));

export class ZaloSessionInvalidError extends Error {
  public readonly code = ZALO_SESSION_INVALID_CODE;
  public readonly sessionExpired = true;

  constructor(message: string = ZALO_SESSION_INVALID_MESSAGE) {
    super(message);
    this.name = 'ZaloSessionInvalidError';
  }
}

const toMsgId = (value: any): number => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
};

/**
 * Zalo trả `msgId = 0` khi tin KHÔNG được gửi (dù request không ném lỗi).
 * Nếu chỉ dựa vào việc "không throw" thì hệ thống sẽ báo đã gửi dù thực tế chưa gửi.
 * Chỉ coi là lỗi khi có bằng chứng rõ ràng, tránh báo lỗi giả.
 */
export function assertZaloSendAccepted(result: any): any {
  if (!result) {
    throw new Error('Zalo không trả về kết quả gửi tin');
  }

  const messageId = toMsgId(result.message?.msgId);
  const attachments = Array.isArray(result.attachment) ? result.attachment : [];
  const attachmentIds = attachments.map((item: any) => toMsgId(item?.msgId)).filter((id: number) => id > 0);

  if (messageId > 0 || attachmentIds.length > 0) return result;

  const explicitFailure =
    (result.message && toMsgId(result.message.msgId) === 0) ||
    (attachments.length > 0 && attachmentIds.length === 0);

  if (explicitFailure) {
    throw new Error('Zalo không gửi được tin nhắn (msgId = 0)');
  }
  return result;
}

export class ZaloClientManager {
  private static instances: Map<string, ZaloClientManager> = new Map();
  private appId: string;
  private api: API | null = null;
  private zaloId: string | null = null;
  private userProfile: { zaloId?: string; displayName?: string; avatar?: string } | null = null;
  private latestQRData: { qr: string; status: string } = { qr: '', status: 'idle' };
  private listenerRestartCount = 0;
  private listenerRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private restorePromise: Promise<boolean> | null = null;
  private lastRestoreAttempt = 0;
  private lastVerifiedAt = 0;
  private static readonly RESTORE_COOLDOWN_MS = 30000;
  private static readonly VERIFY_INTERVAL_MS = 5 * 60 * 1000;

  private constructor(appId: string) {
    this.appId = appId;
  }

  public static getInstance(appId = 'default'): ZaloClientManager {
    if (!ZaloClientManager.instances.has(appId)) {
      ZaloClientManager.instances.set(appId, new ZaloClientManager(appId));
    }
    return ZaloClientManager.instances.get(appId)!;
  }

  public static getAllInstances(): Map<string, ZaloClientManager> {
    return ZaloClientManager.instances;
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
   * Start QR Login Process for this appId
   */
  public async generateQRLogin(): Promise<{ qr: string; status: string }> {
    if (this.api && this.zaloId) {
      return { qr: '', status: 'already_logged_in' };
    }

    const zalo = new Zalo(this.createZaloConfig());
    let accountInfo = { avatar: '', displayName: '' };

    try {
      this.latestQRData = { qr: '', status: 'waiting' };
      broadcastQRUpdate(this.appId, '', 'waiting');

      const api = await zalo.loginQR(
        {
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        },
        (res: any) => {
          console.log(`[ZaloClientManager][${this.appId}] QR Event: ${res.type}`);

          if (res.type === LoginQRCallbackEventType.QRCodeGenerated) {
            const raw: string = res.data?.image || res.data?.qrData || '';
            const qrDataUrl = raw
              ? raw.startsWith('data:')
                ? raw
                : `data:image/png;base64,${raw}`
              : '';

            this.latestQRData = { qr: qrDataUrl, status: 'waiting' };
            broadcastQRUpdate(this.appId, qrDataUrl, 'waiting');
          }

          if (res.type === LoginQRCallbackEventType.QRCodeExpired) {
            this.latestQRData = { qr: '', status: 'expired' };
            broadcastQRUpdate(this.appId, '', 'expired');
          }

          if (res.type === LoginQRCallbackEventType.QRCodeDeclined) {
            this.latestQRData = { qr: '', status: 'declined' };
            broadcastQRUpdate(this.appId, '', 'declined');
          }

          if (res.type === LoginQRCallbackEventType.QRCodeScanned) {
            accountInfo.avatar = res.data?.avatar || '';
            accountInfo.displayName = res.data?.display_name || '';
            this.latestQRData = { qr: '', status: 'scanned' };
            broadcastQRUpdate(this.appId, '', 'scanned');
          }
        }
      );

      const context = api.getContext();
      const zaloId = api.getOwnId();

      if (!zaloId || !context) {
        this.latestQRData = { qr: '', status: 'error' };
        broadcastQRUpdate(this.appId, '', 'error');
        throw new Error('Đăng nhập QR thất bại');
      }

      this.api = api;
      this.zaloId = zaloId;
      this.lastVerifiedAt = Date.now();
      this.lastRestoreAttempt = 0;
      this.userProfile = {
        zaloId,
        displayName: accountInfo.displayName,
        avatar: accountInfo.avatar,
      };

      const cookiesJson = JSON.stringify(context.cookie.serializeSync());
      const sessionData: ZaloSessionData = {
        app_id: this.appId,
        zalo_id: zaloId,
        full_name: accountInfo.displayName,
        avatar_url: accountInfo.avatar,
        cookies: cookiesJson,
        imei: context.imei,
        user_agent: context.userAgent,
        is_active: true,
      };

      await ZaloSessionStore.saveSession(sessionData, this.appId);

      this.latestQRData = { qr: '', status: 'success' };
      broadcastQRUpdate(this.appId, '', 'success');
      broadcastStatusChange(this.appId, true, this.userProfile);

      this.startMessageListener(api);

      return { qr: '', status: 'success' };
    } catch (error: any) {
      console.error(`[ZaloClientManager][${this.appId}] Error in QR Login:`, error.message);
      this.latestQRData = { qr: '', status: 'error' };
      broadcastQRUpdate(this.appId, '', 'error');
      return { qr: '', status: 'error' };
    }
  }

  /**
   * Đảm bảo phiên Zalo của appId này đã được khôi phục từ Supabase.
   * Server (Render) hay restart/spin-down nên bộ nhớ phiên bị mất; nếu chỉ khôi phục
   * 'default' thì mọi appId khác sẽ báo "Chưa đăng nhập Zalo." dù đã lưu session.
   * Có cooldown để không truy vấn DB liên tục khi thực sự chưa đăng nhập.
   */
  public async ensureSession(): Promise<boolean> {
    if (this.api && this.zaloId) {
      await this.verifySessionIfStale();
      return !!(this.api && this.zaloId);
    }
    if (this.restorePromise) return this.restorePromise;
    if (Date.now() - this.lastRestoreAttempt < ZaloClientManager.RESTORE_COOLDOWN_MS) return false;

    this.lastRestoreAttempt = Date.now();
    this.restorePromise = this.autoRestoreSession().finally(() => {
      this.restorePromise = null;
    });
    return this.restorePromise;
  }

  /**
   * Kiểm tra định kỳ phiên đang giữ trong bộ nhớ.
   * Zalo có thể vô hiệu hoá cookie (zpw_sek) bất cứ lúc nào (đăng nhập nơi khác, hết hạn...):
   * khi đó `api` vẫn tồn tại nên /status báo "đã đăng nhập" nhưng mọi API zpw đều lỗi.
   */
  private async verifySessionIfStale(): Promise<void> {
    if (!this.api) return;
    if (Date.now() - this.lastVerifiedAt < ZaloClientManager.VERIFY_INTERVAL_MS) return;

    const api = this.api;
    try {
      await api.fetchAccountInfo();
      this.lastVerifiedAt = Date.now();
    } catch (err: any) {
      if (isSessionInvalidError(err)) {
        await this.invalidateSession(`kiểm tra định kỳ: ${err?.message || err}`);
      } else {
        // Lỗi mạng tạm thời: giữ nguyên phiên, thử lại sau
        console.warn(`[ZaloClientManager][${this.appId}] Không kiểm tra được phiên Zalo: ${err?.message || err}`);
      }
    }
  }

  /**
   * Auto restore session from Supabase on server startup for this appId
   */
  public async autoRestoreSession(): Promise<boolean> {
    console.log(`[ZaloClientManager][${this.appId}] Attempting to auto-restore Zalo session...`);
    const session = await ZaloSessionStore.getActiveSession(this.appId);

    if (!session) {
      console.log(`[ZaloClientManager][${this.appId}] No active session found.`);
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
        console.warn(`[ZaloClientManager][${this.appId}] Session restore returned invalid Zalo ID. Expiring session...`);
        await ZaloSessionStore.deactivateSession(session.zalo_id, this.appId);
        return false;
      }

      // Cookie còn hạn hay không: session cũ vẫn trả zaloId nhưng gọi API sẽ lỗi zpw_sek.
      // Gọi thử 1 API nhẹ; nếu Zalo báo hết phiên thì xóa session để buộc đăng nhập QR lại.
      try {
        await api.fetchAccountInfo();
      } catch (verifyErr: any) {
        const message = String(verifyErr?.message || verifyErr || '');
        if (isSessionInvalidError(verifyErr)) {
          console.warn(`[ZaloClientManager][${this.appId}] Phiên Zalo đã hết hiệu lực (${message}). Cần đăng nhập lại.`);
          await ZaloSessionStore.deactivateSession(session.zalo_id, this.appId);
        } else {
          console.warn(`[ZaloClientManager][${this.appId}] Không kiểm tra được phiên Zalo: ${message}`);
        }
        return false;
      }

      this.api = api;
      this.zaloId = zaloId;
      this.lastVerifiedAt = Date.now();
      this.userProfile = {
        zaloId,
        displayName: session.full_name,
        avatar: session.avatar_url,
      };

      console.log(`[ZaloClientManager][${this.appId}] ✅ Auto-restored Zalo session successfully for Zalo ID: ${zaloId}`);
      broadcastStatusChange(this.appId, true, this.userProfile);

      this.startMessageListener(api);
      return true;
    } catch (err: any) {
      console.error(`[ZaloClientManager][${this.appId}] Failed to auto-restore session:`, err.message);
      // Cookie đã chết hẳn (login cũng thất bại) => đánh dấu phiên inactive để buộc đăng nhập QR lại
      if (isSessionInvalidError(err)) {
        await ZaloSessionStore.deactivateSession(session.zalo_id, this.appId);
      }
      return false;
    }
  }

  /**
   * Phiên đã bị Zalo vô hiệu hoá: xoá phiên trong bộ nhớ + đánh dấu inactive trong Supabase
   * để giao diện biết phải quét QR đăng nhập lại (thay vì báo lỗi zpw_sek khó hiểu).
   */
  private async invalidateSession(reason: string): Promise<void> {
    const zaloId = this.zaloId;
    console.warn(`[ZaloClientManager][${this.appId}] Phiên Zalo không còn hiệu lực (${reason}). Cần đăng nhập lại bằng QR.`);

    this.api = null;
    this.zaloId = null;
    this.userProfile = null;
    this.lastVerifiedAt = 0;
    this.latestQRData = { qr: '', status: 'expired' };
    broadcastStatusChange(this.appId, false, null);

    if (zaloId) {
      try {
        await ZaloSessionStore.deactivateSession(zaloId, this.appId);
      } catch (err: any) {
        console.error(`[ZaloClientManager][${this.appId}] Không cập nhật được trạng thái phiên:`, err?.message || err);
      }
    }
  }

  /**
   * Chạy một thao tác Zalo: nếu Zalo báo phiên hết hiệu lực (zpw_sek) thì
   * đánh dấu phiên chết, thử khôi phục lại từ Supabase và chạy lại 1 lần.
   */
  private async withSession<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (!this.api) {
      const restored = await this.ensureSession();
      if (!restored || !this.api) throw new ZaloSessionInvalidError(ZALO_NOT_LOGGED_IN_MESSAGE);
    }

    try {
      return await task();
    } catch (err: any) {
      if (!isSessionInvalidError(err)) throw err;

      await this.invalidateSession(`${label}: ${err?.message || err}`);
      this.lastRestoreAttempt = 0;

      const restored = await this.ensureSession();
      if (!restored || !this.api) throw new ZaloSessionInvalidError();

      try {
        return await task();
      } catch (retryErr: any) {
        if (!isSessionInvalidError(retryErr)) throw retryErr;
        await this.invalidateSession(`${label} (thử lại): ${retryErr?.message || retryErr}`);
        throw new ZaloSessionInvalidError();
      }
    }
  }

  /**
   * Start listening for incoming Zalo messages.
   * Includes error handling and auto-restart to prevent server crashes
   * when zca-js receives a null/malformed WebSocket frame.
   */
  private startMessageListener(api: API) {
    // Clear any pending restart timer
    if (this.listenerRestartTimer) {
      clearTimeout(this.listenerRestartTimer);
      this.listenerRestartTimer = null;
    }

    try {
      api.listener.on('message', (message: any) => {
        console.log(`[ZaloListener][${this.appId}] New Message:`, message);
        broadcastNewMessage(this.appId, { type: 'zalo_message', data: message });

        try {
          const threadId = message.threadId || message.toId || message.uidFrom;
          const senderId = message.uidFrom || message.senderId;
          if (threadId && senderId) {
            ZaloMessageStore.saveMessage({
              app_id: this.appId,
              msg_id: message.msgId ? String(message.msgId) : undefined,
              thread_id: String(threadId),
              sender_id: String(senderId),
              sender_name: message.dName || message.displayName || '',
              thread_type: message.isGroup ? 'group' : 'user',
              msg_type: message.msgType || 'text',
              content: typeof message.data?.content === 'string' ? message.data.content : (message.content || ''),
              attachments: message.data?.attachments || null,
            }, this.appId);
          }
        } catch (e: any) {
          console.error(`[ZaloListener][${this.appId}] Error saving incoming message:`, e.message);
        }
      });

      api.listener.on('group_event', (eventData: any) => {
        console.log(`[ZaloListener][${this.appId}] Group Event:`, eventData);
        broadcastNewMessage(this.appId, { type: 'group_event', data: eventData });
      });

      // ── Critical: handle errors emitted by the Listener (e.g. null WebSocket
      // frames that cause "Cannot use 'in' operator to search for 'params' in null").
      // Without this handler Node.js would crash the entire process.
      api.listener.on('error', (err: any) => {
        console.error(`[ZaloListener][${this.appId}] Listener error (non-fatal):`, err?.message || err);
        // Schedule a restart after a short delay so transient errors don't
        // spin-loop, but the listener recovers automatically.
        this._scheduleListenerRestart(api);
      });


      api.listener.start();
      this.listenerRestartCount = 0; // reset backoff counter on clean start
      console.log(`[ZaloListener][${this.appId}] Started real-time message listener.`);
    } catch (err: any) {
      console.error(`[ZaloListener][${this.appId}] Error starting listener:`, err.message);
      // Retry after a delay if initial start fails
      this._scheduleListenerRestart(api);
    }
  }

  /**
   * Schedule a listener restart with exponential backoff (max 60 s).
   * Prevents rapid-fire restarts when the connection is persistently broken.
   */
  private _scheduleListenerRestart(api: API) {
    if (this.listenerRestartTimer) return; // already scheduled

    const MAX_BACKOFF_MS = 60_000;
    const backoffMs = Math.min(3_000 * Math.pow(2, this.listenerRestartCount), MAX_BACKOFF_MS);
    this.listenerRestartCount++;

    console.log(`[ZaloListener][${this.appId}] Restart #${this.listenerRestartCount} in ${backoffMs / 1000}s...`);

    this.listenerRestartTimer = setTimeout(() => {
      this.listenerRestartTimer = null;
      if (!this.api) {
        console.warn(`[ZaloListener][${this.appId}] API no longer available — skipping restart.`);
        return;
      }
      console.log(`[ZaloListener][${this.appId}] Restarting listener now.`);
      try {
        api.listener.start();
        this.listenerRestartCount = 0;
        console.log(`[ZaloListener][${this.appId}] Listener restarted successfully.`);
      } catch (e: any) {
        console.error(`[ZaloListener][${this.appId}] Failed to restart listener:`, e.message);
        this._scheduleListenerRestart(api);
      }
    }, backoffMs);
  }

  /**
   * Send a text message to a thread (friend or group)
   */
  public async sendMessage(threadId: string, message: string | { msg: string; attachments?: any[]; quote?: any }, threadType?: number) {
    let payload: any = typeof message === 'string' ? { msg: message } : { ...message };

    // Chuẩn hóa cấu trúc quote nếu người dùng thực hiện reply tin nhắn
    if (payload.quote) {
      const quoteParsed = typeof payload.quote === 'string' ? JSON.parse(payload.quote) : payload.quote;
      const quoteData = quoteParsed.data || quoteParsed;
      const isGroup = (threadType === 1 || threadType === ('group' as any));

      let quoteContent = quoteData.content || quoteData.msg || quoteData.text || '';
      let quoteMsgType = quoteData.msgType || 'webchat';
      if (quoteMsgType === 'chat.recommended' || quoteMsgType === 'chat.link' || quoteMsgType === 'text') {
        quoteMsgType = 'webchat';
      }

      if (!isGroup && typeof quoteContent === 'object' && quoteContent !== null) {
        quoteContent = JSON.stringify(quoteContent);
      }

      payload.quote = {
        content: quoteContent,
        msgType: quoteMsgType,
        propertyExt: quoteData.propertyExt ?? undefined,
        uidFrom: String(quoteData.uidFrom || quoteData.senderUid || quoteData.sender_id || quoteData.ownerId || '0'),
        msgId: String(quoteData.msgId || quoteData.globalMsgId || '0'),
        cliMsgId: String(quoteData.cliMsgId || quoteData.msgId || '0'),
        ts: String(quoteData.ts || quoteData.timestamp || Date.now()),
        ttl: quoteData.ttl ?? 0,
      };
    }

    const result = await this.withSession('sendMessage', async () =>
      assertZaloSendAccepted(await this.api!.sendMessage(payload, threadId, threadType)));

    try {
      const msgContent = typeof message === 'string' ? message : message.msg;
      ZaloMessageStore.saveMessage({
        app_id: this.appId,
        thread_id: threadId,
        sender_id: this.zaloId || 'me',
        sender_name: this.userProfile?.displayName || 'Me',
        thread_type: threadType === 1 ? 'group' : 'user',
        msg_type: 'text',
        content: msgContent,
      }, this.appId);
    } catch (e: any) {
      console.error(`[ZaloClientManager][${this.appId}] Error saving sent message:`, e.message);
    }

    return result;
  }

  /**
   * Send an image file to a thread (friend or group)
   */
  public async sendImage(threadId: string, filePath: string, threadType?: number, caption?: string, originalName?: string) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File không tồn tại: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    const baseName = originalName || path.basename(filePath);
    let width = 0;
    let height = 0;

    try {
      const dim = imageSize(buffer);
      width = dim.width ?? 0;
      height = dim.height ?? 0;
    } catch {}

    // Upload to Supabase Storage bucket 'uploads/{appId}/...' with local fallback
    let publicUrl = '';
    try {
      publicUrl = await uploadMediaFile(this.appId, filePath, baseName);
    } catch (e) {
      console.warn(`[ZaloClientManager] Could not upload file:`, e);
    }

    const attachment: any = {
      data: buffer,
      filename: baseName,
      metadata: { totalSize: buffer.length, width, height },
    };

    const payload = {
      msg: caption || '',
      attachments: [attachment],
    };

    const result = await this.withSession('sendImage', async () =>
      assertZaloSendAccepted(await this.api!.sendMessage(payload, threadId, threadType)));

    try {
      ZaloMessageStore.saveMessage({
        app_id: this.appId,
        thread_id: threadId,
        sender_id: this.zaloId || 'me',
        sender_name: this.userProfile?.displayName || 'Me',
        thread_type: threadType === 1 ? 'group' : 'user',
        msg_type: 'image',
        content: caption || `[Hình ảnh] ${baseName}`,
        attachments: [{ filename: baseName, size: buffer.length, url: publicUrl, thumbUrl: publicUrl, hdUrl: publicUrl, href: publicUrl }],
      }, this.appId);
    } catch (e: any) {
      console.error(`[ZaloClientManager][${this.appId}] Error saving sent image message:`, e.message);
    }

    return {
      ...(typeof result === 'object' ? result : { result }),
      publicUrl,
      url: publicUrl,
      thumbUrl: publicUrl,
      href: publicUrl
    };
  }

  /**
   * Send a general file to a thread (friend or group)
   */
  public async sendFile(threadId: string, filePath: string, threadType?: number, originalName?: string) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File không tồn tại: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    const baseName = originalName || path.basename(filePath);

    // Upload to Supabase Storage bucket 'uploads/{appId}/...' with local fallback
    let publicUrl = '';
    try {
      publicUrl = await uploadMediaFile(this.appId, filePath, baseName);
    } catch (e) {
      console.warn(`[ZaloClientManager] Could not upload file:`, e);
    }

    const attachment: any = {
      data: buffer,
      filename: baseName,
      metadata: { totalSize: buffer.length },
    };

    const payload = {
      msg: '',
      attachments: [attachment],
    };

    const result = await this.withSession('sendFile', async () =>
      assertZaloSendAccepted(await this.api!.sendMessage(payload, threadId, threadType)));

    try {
      ZaloMessageStore.saveMessage({
        app_id: this.appId,
        thread_id: threadId,
        sender_id: this.zaloId || 'me',
        sender_name: this.userProfile?.displayName || 'Me',
        thread_type: threadType === 1 ? 'group' : 'user',
        msg_type: 'file',
        content: `[File] ${baseName}`,
        attachments: [{ filename: baseName, size: buffer.length, url: publicUrl, href: publicUrl }],
      }, this.appId);
    } catch (e: any) {
      console.error(`[ZaloClientManager][${this.appId}] Error saving sent file message:`, e.message);
    }

    return {
      ...(typeof result === 'object' ? result : { result }),
      publicUrl,
      url: publicUrl,
      href: publicUrl
    };
  }

  /**
   * Get group chat history (up to count messages, default 50)
   */
  public async getGroupChatHistory(groupId: string, count: number = 50) {
    if (!this.api) {
      throw new ZaloSessionInvalidError(ZALO_NOT_LOGGED_IN_MESSAGE);
    }

    const history = await this.api.getGroupChatHistory(groupId, count);
    return history;
  }

  /**
   * Get list of friends
   */
  /**
   * Get list of friends merged with Aliases & Phonebook Contact Names (Biệt danh/Tên từ danh bạ điện thoại)
   */
  public async getFriends() {
    return this.withSession('getFriends', () => this.getFriendsInternal());
  }

  private async getFriendsInternal() {
    const friends: any[] = await this.api!.getAllFriends();
    if (!Array.isArray(friends) || friends.length === 0) return [];

    // 1. Phân trang lấy tất cả Aliases từ Zalo Web API
    const aliasMap: Record<string, string> = {};
    try {
      const aliasItems = await this.getAliases();
      aliasItems.forEach((item: any) => {
        const uId = item.userId || item.uid;
        if (uId && item.alias) {
          aliasMap[String(uId)] = item.alias;
        }
      });
    } catch (aliasErr) {
      if (isSessionInvalidError(aliasErr)) throw aliasErr;
    }

    // 2. Batch fetch hồ sơ getUserInfo để lấy friendAlias/contactName trong danh bạ điện thoại
    const profileAliasMap: Record<string, string> = {};
    const BATCH_SIZE = 40;
    try {
      for (let i = 0; i < friends.length; i += BATCH_SIZE) {
        const batch = friends.slice(i, i + BATCH_SIZE);
        const userIds = batch.map((f: any) => String(f.userId || f.uid || f.id || '')).filter(Boolean);
        if (userIds.length === 0) continue;

        try {
          const uRes: any = await (this.api as any).getUserInfo(userIds);
          const profiles: Record<string, any> = uRes?.changed_profiles || uRes?.data || uRes?.profiles || {};
          for (const uid of userIds) {
            const prof = profiles[uid] || profiles[`${uid}_0`];
            if (prof) {
              const aliasName = prof.friendAlias || prof.alias || prof.contactName || prof.nickName || prof.globalAlias || '';
              if (aliasName) {
                profileAliasMap[uid] = aliasName;
              }
            }
          }
        } catch (batchErr) {
          if (isSessionInvalidError(batchErr)) throw batchErr;
          // Continue with next batch if any error occurs
        }
      }
    } catch (err) {
      if (isSessionInvalidError(err)) throw err;
    }

    // 3. Kết hợp thông tin ưu tiên theo đúng thứ tự: Tên Biệt Danh bạn đặt trong Zalo App (aliasMap) > Friend Alias > Zalo Name
    return friends.map((f: any) => {
      const userId = String(f.userId || f.uid || f.id || '');
      const finalAlias = aliasMap[userId] || profileAliasMap[userId] || f.alias || f.friendAlias || f.nickname || f.nickName || '';
      return {
        ...f,
        alias: finalAlias,
        friendAlias: finalAlias,
        displayNameResolved: finalAlias || f.displayName || f.zaloName || f.name || userId
      };
    });
  }

  /**
   * Get list of groups with full details (name, avatar, members count)
   */
  public async getGroups() {
    return this.withSession('getGroups', () => this.getGroupsInternal());
  }

  private async getGroupsInternal() {
    const res: any = await this.api!.getAllGroups();
    const gridVerMap = res?.gridVerMap || {};
    const groupIds = Object.keys(gridVerMap);

    if (groupIds.length === 0) {
      return [];
    }

    const BATCH_SIZE = 50;
    const groupList: any[] = [];

    for (let i = 0; i < groupIds.length; i += BATCH_SIZE) {
      const batchIds = groupIds.slice(i, i + BATCH_SIZE);
      try {
        const infoRes: any = await this.api!.getGroupInfo(batchIds);
        const gridInfoMap = infoRes?.gridInfoMap || {};
        for (const [gid, gInfo] of Object.entries(gridInfoMap) as [string, any][]) {
          groupList.push({
            groupId: gid,
            id: gid,
            name: gInfo?.name || gid,
            groupName: gInfo?.name || gid,
            avatar: gInfo?.avt || gInfo?.fullAvt || '',
            avatarUrl: gInfo?.avt || gInfo?.fullAvt || '',
            desc: gInfo?.desc || '',
            creatorId: gInfo?.creatorId || '',
            totalMember: gInfo?.totalMember || (gInfo?.memberIds ? gInfo?.memberIds.length : 0),
            memberIds: gInfo?.memberIds || [],
            adminIds: gInfo?.adminIds || []
          });
        }
      } catch (err: any) {
        if (isSessionInvalidError(err)) throw err;
        console.warn(`[ZaloClientManager][${this.appId}] Error fetching group info batch:`, err.message);
        for (const gid of batchIds) {
          if (!groupList.some(g => g.groupId === gid)) {
            groupList.push({
              groupId: gid,
              id: gid,
              name: gid,
              groupName: gid,
              avatar: '',
              avatarUrl: ''
            });
          }
        }
      }
    }

    return groupList;
  }

  /**
   * Get full info for a single group
   */
  public async getGroupInfo(groupId: string) {
    if (!this.api) {
      throw new ZaloSessionInvalidError(ZALO_NOT_LOGGED_IN_MESSAGE);
    }
    const infoRes: any = await this.api.getGroupInfo(groupId);
    const gridInfo = infoRes?.gridInfoMap?.[groupId] || infoRes?.gridInfo || infoRes;
    return {
      groupId,
      id: groupId,
      name: gridInfo?.name || groupId,
      groupName: gridInfo?.name || groupId,
      avatar: gridInfo?.avt || gridInfo?.fullAvt || '',
      avatarUrl: gridInfo?.avt || gridInfo?.fullAvt || '',
      desc: gridInfo?.desc || '',
      totalMember: gridInfo?.totalMember || (gridInfo?.memberIds ? gridInfo?.memberIds.length : 0),
      creatorId: gridInfo?.creatorId || '',
      adminIds: gridInfo?.adminIds || [],
      memberIds: gridInfo?.memberIds || []
    };
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
   * Search user/contact by phone number and resolve alias (tên gợi nhớ)
   */
  public async findUserByPhone(phone: string) {
    return this.withSession('findUserByPhone', () => this.findUserByPhoneInternal(phone));
  }

  private async findUserByPhoneInternal(phone: string) {
    const foundUser: any = await (this.api as any).findUser(phone);
    if (!foundUser) {
      return null;
    }

    const userId = foundUser.userId || foundUser.uid || foundUser.id;
    let displayName = foundUser.displayName || foundUser.name || foundUser.zaloName || '';
    let avatarUrl = foundUser.avatar || foundUser.avatarUrl || foundUser.avatar_url || '';
    let alias = foundUser.alias || '';

    try {
      const friends: any[] = await this.api!.getAllFriends();
      const friend = friends.find((f: any) => (f.userId || f.uid || f.id || f.user_id || f.contact_id) === userId);
      if (friend) {
        if (friend.alias) alias = friend.alias;
        if (!displayName) displayName = friend.displayName || friend.name || friend.zaloName || '';
        if (!avatarUrl) avatarUrl = friend.avatar || friend.avatarUrl || '';
      }
    } catch (friendErr) {
      if (isSessionInvalidError(friendErr)) throw friendErr;
    }

    const resolvedName = alias || displayName || phone;

    return {
      userId,
      phone,
      displayName,
      alias,
      resolvedName,
      avatarUrl,
      raw: foundUser,
    };
  }

  /**
   * Search user / friend by alias (tên gợi nhớ / mã học viên), lấy ra người đầu tiên
   */
  public async findUserByAlias(aliasQuery: string) {
    return this.withSession('findUserByAlias', () => this.findUserByAliasInternal(aliasQuery));
  }

  private async findUserByAliasInternal(aliasQuery: string) {
    const clean = String(aliasQuery || '').trim().toLowerCase();
    if (!clean) return null;

    // 1. Quét qua getAliases()
    try {
      const aliases = await this.getAliases();
      const matched = aliases.find((item: any) => {
        const text = String(item.alias || item.name || '').toLowerCase();
        return text.includes(clean);
      });
      if (matched) {
        const userId = String(matched.userId || matched.uid || matched.id || '');
        return {
          userId,
          displayName: matched.alias || matched.name || userId,
          alias: matched.alias || matched.name || '',
          resolvedName: matched.alias || matched.name || userId,
          matchedBy: 'alias',
          raw: matched,
        };
      }
    } catch (aliasErr) {
      if (isSessionInvalidError(aliasErr)) throw aliasErr;
    }

    // 2. Quét qua getFriends()
    try {
      const friends = await this.getFriends();
      const matched = friends.find((f: any) => {
        const text = String(f.alias || f.friendAlias || f.displayNameResolved || f.displayName || '').toLowerCase();
        return text.includes(clean);
      });
      if (matched) {
        const userId = String(matched.userId || matched.uid || matched.id || '');
        const alias = matched.alias || matched.friendAlias || '';
        const resolvedName = matched.displayNameResolved || alias || matched.displayName || userId;
        return {
          userId,
          displayName: matched.displayName || alias || userId,
          alias,
          resolvedName,
          avatarUrl: matched.avatar || matched.avatarUrl || '',
          matchedBy: 'alias',
          raw: matched,
        };
      }
    } catch (friendErr) {
      if (isSessionInvalidError(friendErr)) throw friendErr;
    }

    return null;
  }

  /**
   * Get list of all aliases (tên gợi nhớ bạn đã đặt trong Zalo app) with full pagination
   */
  public async getAliases() {
    if (!this.api) {
      throw new ZaloSessionInvalidError(ZALO_NOT_LOGGED_IN_MESSAGE);
    }
    let page = 1;
    let allItems: any[] = [];
    const MAX_PAGES = 50;

    while (page <= MAX_PAGES) {
      try {
        // zca-js API getAliasList signature: getAliasList(count: number, page: number)
        const aliasRes: any = await this.api.getAliasList(200, page);
        // zca-js trả về object có thuộc tính items hoặc data
        const items = aliasRes?.items || aliasRes?.data?.items || aliasRes?.aliases || (Array.isArray(aliasRes) ? aliasRes : []);
        if (!Array.isArray(items) || items.length === 0) break;
        allItems = allItems.concat(items);
        page++;
      } catch (err: any) {
        if (isSessionInvalidError(err)) throw err;
        console.warn(`[getAliases] Error on page ${page}:`, err.message);
        break;
      }
    }
    return allItems;
  }

  /**
   * Set alias (đặt biệt danh) for a user
   */
  public async setAlias(userId: string, alias: string) {
    if (!this.api) {
      throw new ZaloSessionInvalidError(ZALO_NOT_LOGGED_IN_MESSAGE);
    }
    return await (this.api as any).changeFriendAlias(alias, userId);
  }

  /**
   * Get detail of sticker(s) by ID
   */
  public async getStickersDetail(stickerId: number) {
    if (!this.api) {
      throw new ZaloSessionInvalidError(ZALO_NOT_LOGGED_IN_MESSAGE);
    }
    return await this.api.getStickersDetail(stickerId);
  }

  /**
   * Get stickers by category ID (cateId)
   */
  public async getStickerCategoryDetail(cateId: number) {
    if (!this.api) {
      throw new ZaloSessionInvalidError(ZALO_NOT_LOGGED_IN_MESSAGE);
    }
    return await (this.api as any).getStickerCategoryDetail(cateId);
  }

  /**
   * Send a sticker
   */
  public async sendSticker(threadId: string, stickerId: number, threadType?: number) {
    if (!this.api) {
      throw new ZaloSessionInvalidError(ZALO_NOT_LOGGED_IN_MESSAGE);
    }
    const stickersDetail: any = await this.api.getStickersDetail(stickerId);
    if (!stickersDetail || stickersDetail.length === 0) {
      throw new Error('Không tìm thấy thông tin Sticker.');
    }
    return await this.api.sendSticker(stickersDetail[0], threadId, threadType);
  }

  /**
   * Get members of a group with roles (trưởng nhóm, phó nhóm, thành viên)
   */
  public async getGroupMembers(groupId: string) {
    if (!this.api) {
      throw new ZaloSessionInvalidError(ZALO_NOT_LOGGED_IN_MESSAGE);
    }
    const groupInfo: any = await this.api.getGroupInfo(groupId);
    const gridInfo = groupInfo?.gridInfo || groupInfo;
    const memIds: string[] = gridInfo?.memIds || gridInfo?.memberIds || [];
    
    if (memIds.length === 0) return [];

    const memberIdsForApi = memIds.map(id => `${id}_0`);
    const res: any = await (this.api as any).getGroupMembersInfo(groupId, memberIdsForApi);
    const profiles = res?.profiles || res?.membersInfo || res?.data?.membersInfo || {};
    
    return Object.entries(profiles).map(([uid, info]: [string, any]) => {
      const memberId = uid.replace(/_0$/, '').trim();
      return {
        memberId,
        displayName: info.displayName || info.zaloName || info.name || memberId,
        avatar: info.avatar || info.avatarUrl || '',
        role: info.role ?? (gridInfo?.creatorId === memberId ? 2 : (gridInfo?.adminIds?.includes(memberId) ? 1 : 0))
      };
    });
  }

  /**
   * Logout current user
   */
  public async logout() {
    if (this.zaloId) {
      await ZaloSessionStore.deactivateSession(this.zaloId, this.appId);
    }
    this.api = null;
    this.zaloId = null;
    this.userProfile = null;
    this.latestQRData = { qr: '', status: 'idle' };

    broadcastStatusChange(this.appId, false);
    return true;
  }
}
