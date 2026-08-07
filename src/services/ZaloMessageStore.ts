import { supabase } from '../config/supabase';
import fs from 'fs';
import path from 'path';

export interface ZaloMessageData {
  app_id?: string;
  msg_id?: string;
  thread_id: string;
  sender_id: string;
  sender_name?: string;
  thread_type?: 'user' | 'group';
  msg_type?: string;
  content: string;
  attachments?: any;
  created_at?: string;
}

const getLocalMessagesFile = (appId: string) => {
  const safeAppId = (appId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(__dirname, `../../.messages_fallback_${safeAppId}.json`);
};

export class ZaloMessageStore {
  private static readLocalMessages(appId = 'default'): ZaloMessageData[] {
    const file = getLocalMessagesFile(appId);
    if (!fs.existsSync(file)) return [];
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      return JSON.parse(raw) as ZaloMessageData[];
    } catch {
      return [];
    }
  }

  private static appendLocalMessage(msg: ZaloMessageData, appId = 'default'): void {
    try {
      const file = getLocalMessagesFile(appId);
      const list = this.readLocalMessages(appId);
      list.push(msg);
      const trimmed = list.slice(-1000);
      fs.writeFileSync(file, JSON.stringify(trimmed, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(`[ZaloMessageStore][${appId}] Failed writing local messages fallback:`, err.message);
    }
  }

  /**
   * Lưu tin nhắn (đến hoặc đi) vào Supabase và Local fallback
   */
  public static async saveMessage(msg: ZaloMessageData, appId = 'default'): Promise<boolean> {
    const payload = {
      app_id: appId,
      msg_id: msg.msg_id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      thread_id: msg.thread_id,
      sender_id: msg.sender_id,
      sender_name: msg.sender_name || '',
      thread_type: msg.thread_type || 'user',
      msg_type: msg.msg_type || 'text',
      content: msg.content || '',
      attachments: msg.attachments || null,
      created_at: msg.created_at || new Date().toISOString(),
    };

    // Save to local fallback per appId
    this.appendLocalMessage(payload, appId);

    if (!supabase) {
      return true;
    }

    try {
      const { error } = await supabase.from('zalo_messages').upsert(payload, { onConflict: 'msg_id' });
      if (error) {
        console.error(`[ZaloMessageStore][${appId}] Supabase save error:`, error.message);
        return false;
      }
      return true;
    } catch (err: any) {
      console.error(`[ZaloMessageStore][${appId}] Error saving message to Supabase:`, err.message);
      return false;
    }
  }

  /**
   * Lấy lịch sử tin nhắn với 1 bạn bè hoặc nhóm từ Supabase
   */
  public static async getMessagesByThread(threadId: string, limit = 50, appId = 'default'): Promise<ZaloMessageData[]> {
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('zalo_messages')
          .select('*')
          .eq('app_id', appId)
          .eq('thread_id', threadId)
          .order('created_at', { ascending: false })
          .limit(limit);

        if (!error && data) {
          return (data as ZaloMessageData[]).reverse();
        }
      } catch (err: any) {
        console.warn(`[ZaloMessageStore][${appId}] Supabase fetch failed, fallback local:`, err.message);
      }
    }

    // Fallback to local file
    const localMsgs = this.readLocalMessages(appId);
    const filtered = localMsgs.filter((m) => m.thread_id === threadId);
    return filtered.slice(-limit);
  }

  /**
   * Lấy danh sách các cuộc hội thoại vừa chat gần đây
   */
  public static async getRecentConversations(limit = 20, appId = 'default'): Promise<any[]> {
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('zalo_messages')
          .select('thread_id, sender_id, sender_name, thread_type, content, created_at')
          .eq('app_id', appId)
          .order('created_at', { ascending: false })
          .limit(200);

        if (!error && data) {
          const map = new Map<string, any>();
          for (const item of data) {
            if (!map.has(item.thread_id)) {
              map.set(item.thread_id, item);
            }
          }
          return Array.from(map.values()).slice(0, limit);
        }
      } catch (err: any) {
        console.warn(`[ZaloMessageStore][${appId}] Fetch recent conversations failed:`, err.message);
      }
    }

    // Fallback local
    const localMsgs = this.readLocalMessages(appId);
    const map = new Map<string, any>();
    for (let i = localMsgs.length - 1; i >= 0; i--) {
      const m = localMsgs[i];
      if (!map.has(m.thread_id)) {
        map.set(m.thread_id, m);
      }
    }
    return Array.from(map.values()).slice(0, limit);
  }
}
