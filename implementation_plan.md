# Kế Hoạch Chi Tiết & Hướng Dẫn Cấu Hình: Zalo Backend API & Supabase

Tài liệu này chứa toàn bộ thiết kế kiến trúc, SQL Schema cho Supabase, cấu hình REST APIs và hướng dẫn triển khai cho Node.js Backend Service.

---

## 1. SQL Schema cho Supabase (Bảng `zalo_sessions`)

Hãy truy cập vào **Supabase Dashboard** -> chọn dự án của bạn -> chọn **SQL Editor** -> chạy câu lệnh SQL sau để tạo bảng lưu trữ Session Zalo:

```sql
-- Tạo bảng lưu trữ Session Zalo
CREATE TABLE IF NOT EXISTS public.zalo_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zalo_id TEXT UNIQUE NOT NULL,
    full_name TEXT,
    avatar_url TEXT,
    phone TEXT,
    cookies TEXT NOT NULL,       -- JSON string của Zalo Cookie Jar
    imei TEXT NOT NULL,          -- Client IMEI
    user_agent TEXT NOT NULL,    -- User Agent string
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tạo chỉ mục để truy vấn nhanh theo zalo_id và is_active
CREATE INDEX IF NOT EXISTS idx_zalo_sessions_zalo_id ON public.zalo_sessions(zalo_id);
CREATE INDEX IF NOT EXISTS idx_zalo_sessions_is_active ON public.zalo_sessions(is_active);
```

---

## 2. Danh Sách REST APIs

| Method | Endpoint | Mô tả | Payload yêu cầu | Response |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/zalo/qr` | Lấy dữ liệu ảnh QR đăng nhập | None | `{ success: true, qr: "data:image/png;base64,...", status: "waiting" }` |
| `GET` | `/api/zalo/status` | Kiểm tra trạng thái đăng nhập | None | `{ success: true, isLoggedIn: true, user: { zaloId, displayName, avatar } }` |
| `GET` | `/api/zalo/friends` | Lấy danh bạ bạn bè | None | `{ success: true, friends: [...] }` |
| `GET` | `/api/zalo/groups` | Lấy danh sách nhóm | None | `{ success: true, groups: [...] }` |
| `POST` | `/api/zalo/send-message` | Gửi tin nhắn đến Friend/Group | `{ "threadId": "...", "message": "..." }` | `{ success: true, result: {...} }` |
| `POST` | `/api/zalo/logout` | Đăng xuất tài khoản | None | `{ success: true, message: "..." }` |

---

## 3. WebSockets Events (Realtime)

*   `zalo-qr-update`: Nhận dữ liệu QR và trạng thái quét QR (`waiting`, `scanned`, `success`, `expired`, `declined`).
*   `zalo-status-change`: Sự kiện thay đổi trạng thái đăng nhập (`isLoggedIn: true/false`).
*   `zalo-message-received`: Push tin nhắn Zalo mới từ bạn bè / nhóm thời gian thực về React Frontend.

---

## 4. Các Bước Triển Khai Lên Render.com

1. Đẩy toàn bộ source code `kn zalo` lên GitHub Repository.
2. Trên Render Dashboard -> Tạo **New Web Service**:
   * **Build Command**: `npm install && npm run build`
   * **Start Command**: `npm start`
   * **Environment Variables**:
     * `SUPABASE_URL` = `https://<project-id>.supabase.co`
     * `SUPABASE_KEY` = `<your-supabase-key>`
3. Tạo HTTP Monitor trên **UptimeRobot.com** trỏ tới `https://<render-app>.onrender.com/health` (5 phút/lần) để giữ server không bao giờ bị ngủ.
