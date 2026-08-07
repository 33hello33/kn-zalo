import { supabase } from '../config/supabase';
import fs from 'fs';
import path from 'path';

export interface ZaloSessionData {
  app_id?: string;
  zalo_id: string;
  full_name?: string;
  avatar_url?: string;
  phone?: string;
  cookies: string; // JSON string of cookie jar
  imei: string;
  user_agent: string;
  is_active?: boolean;
}

const getLocalSessionFile = (appId: string) => {
  const safeAppId = (appId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(__dirname, `../../.session_fallback_${safeAppId}.json`);
};

export class ZaloSessionStore {
  /**
   * Save or update Zalo session in Supabase (and local fallback file)
   */
  public static async saveSession(session: ZaloSessionData, appId = 'default'): Promise<boolean> {
    const payload = {
      app_id: appId,
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

    // Save to local fallback file for offline resilience per appId
    try {
      const localFile = getLocalSessionFile(appId);
      fs.writeFileSync(localFile, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(`[SessionStore][${appId}] Local fallback write error:`, err.message);
    }

    if (!supabase) {
      console.log(`[SessionStore][${appId}] Supabase not connected. Session saved to local fallback file.`);
      return true;
    }

    try {
      // Upsert with app_id & zalo_id composite or app_id lookup
      const { error } = await supabase
        .from('zalo_sessions')
        .upsert(payload, { onConflict: 'app_id,zalo_id' });

      if (error) {
        // Fallback try upserting with zalo_id if app_id column not present in old schema
        const { error: err2 } = await supabase.from('zalo_sessions').upsert(payload, { onConflict: 'zalo_id' });
        if (err2) {
          console.error(`[SessionStore][${appId}] Supabase upsert error:`, err2.message);
          return false;
        }
      }
      console.log(`[SessionStore][${appId}] Session saved successfully to Supabase for Zalo ID: ${session.zalo_id}`);
      return true;
    } catch (err: any) {
      console.error(`[SessionStore][${appId}] Failed to save session to Supabase:`, err.message);
      return false;
    }
  }

  /**
   * Get the active session for specific appId from Supabase (or local fallback)
   */
  public static async getActiveSession(appId = 'default'): Promise<ZaloSessionData | null> {
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('zalo_sessions')
          .select('*')
          .eq('app_id', appId)
          .eq('is_active', true)
          .order('updated_at', { ascending: false })
          .limit(1)
          .single();

        if (!error && data) {
          console.log(`[SessionStore][${appId}] Loaded active session from Supabase for Zalo ID: ${data.zalo_id}`);
          return data as ZaloSessionData;
        }
      } catch (err: any) {
        console.warn(`[SessionStore][${appId}] Supabase query by app_id failed, checking local fallback:`, err.message);
      }
    }

    // Fallback to local session file for this appId
    const localFile = getLocalSessionFile(appId);
    if (fs.existsSync(localFile)) {
      try {
        const raw = fs.readFileSync(localFile, 'utf-8');
        const session = JSON.parse(raw) as ZaloSessionData;
        console.log(`[SessionStore][${appId}] Loaded active session from local fallback file for Zalo ID: ${session.zalo_id}`);
        return session;
      } catch (err: any) {
        console.error(`[SessionStore][${appId}] Failed reading local session file:`, err.message);
      }
    }

    return null;
  }

  /**
   * Deactivate a session for an appId
   */
  public static async deactivateSession(zaloId: string, appId = 'default'): Promise<void> {
    if (supabase) {
      try {
        await supabase
          .from('zalo_sessions')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('app_id', appId)
          .eq('zalo_id', zaloId);
      } catch (err: any) {
        console.error(`[SessionStore][${appId}] Failed to deactivate session in Supabase:`, err.message);
      }
    }

    const localFile = getLocalSessionFile(appId);
    if (fs.existsSync(localFile)) {
      try {
        fs.unlinkSync(localFile);
      } catch {}
    }
  }
}
