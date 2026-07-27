-- SQL Script cho Supabase Database
-- Mở Supabase Dashboard -> SQL Editor -> Dán và Chạy (Run) script này

CREATE TABLE IF NOT EXISTS public.zalo_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zalo_id TEXT UNIQUE NOT NULL,
    full_name TEXT,
    avatar_url TEXT,
    phone TEXT,
    cookies TEXT NOT NULL,       -- JSON string chứa Cookie Jar
    imei TEXT NOT NULL,          -- IMEI của client
    user_agent TEXT NOT NULL,    -- User Agent
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index tối ưu truy vấn
CREATE INDEX IF NOT EXISTS idx_zalo_sessions_zalo_id ON public.zalo_sessions(zalo_id);
CREATE INDEX IF NOT EXISTS idx_zalo_sessions_is_active ON public.zalo_sessions(is_active);
