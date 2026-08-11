import { API, LoginQRCallbackEventType, Zalo } from 'zca-js';
import { ZaloSessionStore, ZaloSessionData } from './ZaloSessionStore';
import { ZaloMessageStore } from './ZaloMessageStore';
import { broadcastQRUpdate, broadcastStatusChange, broadcastNewMessage } from '../sockets/zaloSocket';
import fs from 'fs';
import path from 'path';
import { imageSize } from 'image-size';

export class ZaloClientManager {
  private static instances: Map<string, ZaloClientManager> = new Map();
  private appId: string;
  private api: API | null = null;
  private zaloId: string | null = null;
  private userProfile: { zaloId?: string; displayName?: string; avatar?: string } | null = null;
  private latestQRData: { qr: string; status: string } = { qr: '', status: 'idle' };

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

      this.api = api;
      this.zaloId = zaloId;
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
      return false;
    }
  }

  /**
   * Start listening for incoming Zalo messages
   */
  private startMessageListener(api: API) {
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

      api.listener.start();
      console.log(`[ZaloListener][${this.appId}] Started real-time message listener.`);
    } catch (err: any) {
      console.error(`[ZaloListener][${this.appId}] Error starting listener:`, err.message);
    }
  }

  /**
   * Send a text message to a thread (friend or group)
   */
  public async sendMessage(threadId: string, message: string | { msg: string; attachments?: any[]; quote?: any }, threadType?: number) {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo. Vui lòng quét mã QR trước.');
    }

    const payload = typeof message === 'string' ? { msg: message } : message;
    const result = await this.api.sendMessage(payload as any, threadId, threadType);

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
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo.');
    }

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

    try {
      ZaloMessageStore.saveMessage({
        app_id: this.appId,
        thread_id: threadId,
        sender_id: this.zaloId || 'me',
        sender_name: this.userProfile?.displayName || 'Me',
        thread_type: threadType === 1 ? 'group' : 'user',
        msg_type: 'image',
        content: caption || `[Hình ảnh] ${baseName}`,
        attachments: [{ filename: baseName, size: buffer.length }],
      }, this.appId);
    } catch (e: any) {
      console.error(`[ZaloClientManager][${this.appId}] Error saving sent image message:`, e.message);
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

    try {
      ZaloMessageStore.saveMessage({
        app_id: this.appId,
        thread_id: threadId,
        sender_id: this.zaloId || 'me',
        sender_name: this.userProfile?.displayName || 'Me',
        thread_type: threadType === 1 ? 'group' : 'user',
        msg_type: 'file',
        content: `[File] ${baseName}`,
        attachments: [{ filename: baseName }],
      }, this.appId);
    } catch (e: any) {
      console.error(`[ZaloClientManager][${this.appId}] Error saving sent file message:`, e.message);
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
  /**
   * Get list of friends merged with their real Aliases (Biệt danh/Tên gợi nhớ)
   */
  public async getFriends() {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo.');
    }
    const friends: any[] = await this.api.getAllFriends();
    
    // Tự động phân trang lấy toàn bộ Aliases từ Zalo API
    try {
      const aliasItems = await this.getAliases();
      const aliasMap: Record<string, string> = {};
      aliasItems.forEach((item: any) => {
        const uId = item.userId || item.uid;
        if (uId && item.alias) {
          aliasMap[String(uId)] = item.alias;
        }
      });

      return friends.map((f: any) => {
        const userId = String(f.userId || f.uid || f.id || '');
        const alias = aliasMap[userId] || f.alias || f.friendAlias || f.nickname || f.nickName || '';
        return {
          ...f,
          alias,
          friendAlias: alias,
          displayNameResolved: alias || f.displayName || f.zaloName || f.name || userId
        };
      });
    } catch {
      return friends;
    }
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
   * Search user/contact by phone number and resolve alias (tên gợi nhớ)
   */
  public async findUserByPhone(phone: string) {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo.');
    }

    const foundUser: any = await (this.api as any).findUser(phone);
    if (!foundUser) {
      return null;
    }

    const userId = foundUser.userId || foundUser.uid || foundUser.id;
    let displayName = foundUser.displayName || foundUser.name || foundUser.zaloName || '';
    let avatarUrl = foundUser.avatar || foundUser.avatarUrl || foundUser.avatar_url || '';
    let alias = foundUser.alias || '';

    try {
      const friends: any[] = await this.api.getAllFriends();
      const friend = friends.find((f: any) => (f.userId || f.uid || f.id || f.user_id || f.contact_id) === userId);
      if (friend) {
        if (friend.alias) alias = friend.alias;
        if (!displayName) displayName = friend.displayName || friend.name || friend.zaloName || '';
        if (!avatarUrl) avatarUrl = friend.avatar || friend.avatarUrl || '';
      }
    } catch {}

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
   * Get list of all aliases (tên gợi nhớ) with full pagination
   */
  public async getAliases() {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo.');
    }
    let page = 1;
    let allItems: any[] = [];
    const MAX_PAGES = 50;

    while (page <= MAX_PAGES) {
      try {
        const aliasRes: any = await (this.api as any).getAliasList({ count: 200, page });
        const items = aliasRes?.items || aliasRes?.data?.items || aliasRes?.aliases || aliasRes?.response?.items || [];
        if (!Array.isArray(items) || items.length === 0) break;
        allItems = allItems.concat(items);
        page++;
      } catch {
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
      throw new Error('Chưa đăng nhập Zalo.');
    }
    return await (this.api as any).changeFriendAlias(alias, userId);
  }

  /**
   * Send a sticker
   */
  public async sendSticker(threadId: string, stickerId: number, threadType?: number) {
    if (!this.api) {
      throw new Error('Chưa đăng nhập Zalo.');
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
      throw new Error('Chưa đăng nhập Zalo.');
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
