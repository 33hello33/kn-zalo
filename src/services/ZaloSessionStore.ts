import { supabase } from '../config/supabase';
import fs from 'fs';
import path from 'path';

export interface ZaloSessionData {
  zalo_id: string;
  full_name?: string;
  avatar_url?: string;
  phone?: string;
  cookies: string; // JSON string of cookie jar
  imei: string;
  user_agent: string;
  is_active?: boolean;
}

const LOCAL_SESSION_FILE = path.join(__dirname, '../../.session_fallback.json');

export class ZaloSessionStore {
  /**
   * Save or update Zalo session in Supabase (and local fallback file)
   */
  public static async saveSession(session: ZaloSessionData): Promise<boolean> {
    const payload = {
      zalo_id: session.zalo_id,
      full_name: session.full_name || '',
      avatar_url: session.avatar_url || '',
      phone: session.phone || '',
      cookies: session.cookies,
      imei: session.imei,
      user_agent: session.user_agent,
      is_active: true,
      updated_at: new Date().toISOString()
    };

    // Save to local fallback file for offline resilience
    try {
      fs.writeFileSync(LOCAL_SESSION_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err: any) {
      console.error('[SessionStore] Local fallback write error:', err.message);
    }

    if (!supabase) {
      console.log('[SessionStore] Supabase not connected. Session saved to local fallback file.');
      return true;
    }

    try {
      const { error } = await supabase
        .from('zalo_sessions')
        .upsert(payload, { onConflict: 'zalo_id' });

      if (error) {
        console.error('[SessionStore] Supabase upsert error:', error.message);
        return false;
      }
      console.log(`[SessionStore] Session saved successfully to Supabase for Zalo ID: ${session.zalo_id}`);
      return true;
    } catch (err: any) {
      console.error('[SessionStore] Failed to save session to Supabase:', err.message);
      return false;
    }
  }

  /**
   * Get the active session from Supabase (or local fallback)
   */
  public static async getActiveSession(): Promise<ZaloSessionData | null> {
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('zalo_sessions')
          .select('*')
          .eq('is_active', true)
          .order('updated_at', { ascending: false })
          .limit(1)
          .single();

        if (!error && data) {
          console.log(`[SessionStore] Loaded active session from Supabase for Zalo ID: ${data.zalo_id}`);
          return data as ZaloSessionData;
        }
      } catch (err: any) {
        console.warn('[SessionStore] Supabase query failed, checking local fallback:', err.message);
      }
    }

    // Fallback to local session file
    if (fs.existsSync(LOCAL_SESSION_FILE)) {
      try {
        const raw = fs.readFileSync(LOCAL_SESSION_FILE, 'utf-8');
        const session = JSON.parse(raw) as ZaloSessionData;
        console.log(`[SessionStore] Loaded active session from local fallback file for Zalo ID: ${session.zalo_id}`);
        return session;
      } catch (err: any) {
        console.error('[SessionStore] Failed reading local session file:', err.message);
      }
    }

    return null;
  }

  /**
   * Deactivate a session
   */
  public static async deactivateSession(zaloId: string): Promise<void> {
    if (supabase) {
      try {
        await supabase
          .from('zalo_sessions')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('zalo_id', zaloId);
      } catch (err: any) {
        console.error('[SessionStore] Failed to deactivate session in Supabase:', err.message);
      }
    }

    if (fs.existsSync(LOCAL_SESSION_FILE)) {
      try {
        fs.unlinkSync(LOCAL_SESSION_FILE);
      } catch {}
    }
  }
}
