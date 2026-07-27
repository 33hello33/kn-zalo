-- SQL Script cho Supabase Database
-- Mở Supabase Dashboard -> SQL Editor -> Dán và Chạy (Run) script này

-- 1. Bảng lưu trữ Session đăng nhập Zalo
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

-- Index tối ưu truy vấn Session
CREATE INDEX IF NOT EXISTS idx_zalo_sessions_zalo_id ON public.zalo_sessions(zalo_id);
CREATE INDEX IF NOT EXISTS idx_zalo_sessions_is_active ON public.zalo_sessions(is_active);

-- 2. Bảng lưu trữ Lịch sử tin nhắn Zalo (Cho chat 1-1 và danh sách hội thoại)
CREATE TABLE IF NOT EXISTS public.zalo_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    msg_id TEXT UNIQUE,               -- Message ID từ Zalo
    thread_id TEXT NOT NULL,          -- Zalo ID người nhận hoặc ID nhóm
    sender_id TEXT NOT NULL,          -- Zalo ID người gửi
    sender_name TEXT,                 -- Tên người gửi
    thread_type TEXT DEFAULT 'user',  -- 'user' hoặc 'group'
    msg_type TEXT DEFAULT 'text',     -- 'text', 'image', 'file', 'sticker', v.v.
    content TEXT,                     -- Nội dung văn bản
    attachments JSONB,                -- Danh sách file/ảnh kèm theo
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index cho truy vấn danh sách hội thoại và lịch sử tin nhắn
CREATE INDEX IF NOT EXISTS idx_zalo_messages_thread_id ON public.zalo_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_zalo_messages_sender_id ON public.zalo_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_zalo_messages_created_at ON public.zalo_messages(created_at DESC);
