import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';

let supabase: SupabaseClient | null = null;

if (supabaseUrl && supabaseKey && !supabaseUrl.includes('your-supabase-project')) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('[Supabase] Initialized Supabase client successfully.');
} else {
  console.warn('[Supabase] SUPABASE_URL or SUPABASE_KEY not configured in .env. Operating in fallback mode.');
}

export { supabase };
