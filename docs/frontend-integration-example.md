# Hướng Dẫn Tích Hợp Phía React Frontend (Static Website)

Tài liệu này cung cấp code mẫu và hướng dẫn chi tiết giúp kết nối trang web React tĩnh của bạn với Node.js Backend Service vừa xây dựng.

---

## 1. Cài Đặt Thư Viện Cần Thiết

Trên project React Frontend của bạn, cài đặt `socket.io-client` và `axios`:

```bash
npm install socket.io-client axios
```

---

## 2. Danh Sách REST APIs

| Method | Endpoint | Mô Tả | Payload / Multipart |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/zalo/qr` | Lấy dữ liệu ảnh QR đăng nhập | None |
| `GET` | `/api/zalo/status` | Kiểm tra trạng thái đăng nhập | None |
| `GET` | `/api/zalo/friends` | Lấy danh bạ bạn bè | None |
| `GET` | `/api/zalo/groups` | Lấy danh sách nhóm | None |
| `GET` | `/api/zalo/search-phone` | Tìm kiếm người dùng theo SĐT (tự động lấy tên gợi nhớ/alias) | Query: `?phone=0xxxxxxxxx` |
| `POST` | `/api/zalo/send-message` | Gửi tin nhắn văn bản | `{ threadId, message, threadType }` |
| `POST` | `/api/zalo/send-image` | Gửi hình ảnh | FormData: `file`, `threadId`, `threadType`, `caption` |
| `POST` | `/api/zalo/send-file` | Gửi file đính kèm | FormData: `file`, `threadId`, `threadType` |
| `GET` | `/api/zalo/messages/group/:groupId` | Lấy 50 tin nhắn gần nhất của Nhóm | Query: `?count=50` |
| `GET` | `/api/zalo/messages/user/:friendId` | Lấy lịch sử tin nhắn bạn bè từ Supabase | Query: `?limit=50` |
| `GET` | `/api/zalo/conversations` | Lấy danh sách cuộc hội thoại vừa chat | Query: `?limit=20` |
| `POST` | `/api/zalo/logout` | Đăng xuất tài khoản Zalo | None |

---

## 3. Code Mẫu Tra Cứu Số Điện Thoại (Lấy Tên Gợi Nhớ / Alias)

```javascript
// Tìm kiếm liên hệ Zalo theo số điện thoại & lấy tên gợi nhớ (Alias)
async function searchContactByPhone(phoneNumber) {
  try {
    const res = await axios.get(`http://localhost:5000/api/zalo/search-phone?phone=${phoneNumber}`);
    if (res.data.success && res.data.found) {
      const contact = res.data.contact;
      console.log('Tên hiển thị ưu tiên (Alias):', contact.resolvedName);
      console.log('Tên Zalo gốc:', contact.displayName);
      console.log('Tên gợi nhớ (Alias):', contact.alias);
      console.log('Avatar URL:', contact.avatarUrl);
      console.log('User ID:', contact.userId);
      return contact;
    }
    return null;
  } catch (err) {
    console.error('Lỗi khi tra cứu số điện thoại:', err);
    return null;
  }
}
```

---

## 4. Code Mẫu Gửi File & Hình Ảnh

```javascript
// Gửi hình ảnh qua API
async function sendZaloImage(threadId, fileObject, caption = '') {
  const formData = new FormData();
  formData.append('file', fileObject);
  formData.append('threadId', threadId);
  formData.append('caption', caption);

  const res = await axios.post('http://localhost:5000/api/zalo/send-image', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  });
  return res.data;
}

// Gửi file tài liệu qua API
async function sendZaloFile(threadId, fileObject) {
  const formData = new FormData();
  formData.append('file', fileObject);
  formData.append('threadId', threadId);

  const res = await axios.post('http://localhost:5000/api/zalo/send-file', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  });
  return res.data;
}
```

---

## 5. Code Mẫu Lấy Lịch Sử Chat & Danh Sách Hội Thoại

```javascript
// Lấy 50 tin nhắn gần nhất của Nhóm Chat
async function fetchGroupMessages(groupId) {
  const res = await axios.get(`http://localhost:5000/api/zalo/messages/group/${groupId}?count=50`);
  return res.data.messages; // Danh sách 50 tin nhắn Zalo
}

// Lấy lịch sử tin nhắn bạn bè từ Supabase
async function fetchUserMessages(friendId) {
  const res = await axios.get(`http://localhost:5000/api/zalo/messages/user/${friendId}?limit=50`);
  return res.data.messages;
}

// Lấy danh sách hội thoại vừa chat gần đây
async function fetchRecentConversations() {
  const res = await axios.get('http://localhost:5000/api/zalo/conversations');
  return res.data.conversations;
}
```

---

## 5. Service Socket.IO Realtime (`src/services/zaloSocketClient.js`)

```javascript
import { io } from 'socket.io-client';

const BACKEND_URL = 'http://localhost:5000';

export const socket = io(BACKEND_URL, {
  autoConnect: true,
  transports: ['websocket', 'polling']
});
```

---

## 6. Component Chat Demo (`ZaloChatApp.jsx`)

```jsx
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { socket } from '../services/zaloSocketClient';

export default function ZaloChatApp() {
  const [friends, setFriends] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState('');
  const [messageText, setMessageText] = useState('');
  const [messages, setMessages] = useState([]);
  const [fileInput, setFileInput] = useState(null);
  const [searchPhone, setSearchPhone] = useState('');
  const [searchResult, setSearchResult] = useState(null);

  useEffect(() => {
    loadContacts();

    socket.on('zalo-message-received', (payload) => {
      setMessages(prev => [...prev, payload.data]);
    });

    return () => {
      socket.off('zalo-message-received');
    };
  }, []);

  const loadContacts = async () => {
    try {
      const friendsRes = await axios.get('http://localhost:5000/api/zalo/friends');
      if (friendsRes.data.success) setFriends(friendsRes.data.friends || []);

      const groupsRes = await axios.get('http://localhost:5000/api/zalo/groups');
      if (groupsRes.data.success) setGroups(groupsRes.data.groups || []);
    } catch (err) {
      console.error('Lỗi khi tải danh bạ:', err);
    }
  };

  const handleSelectThread = async (id, isGroup = false) => {
    setSelectedThreadId(id);
    try {
      if (isGroup) {
        const res = await axios.get(`http://localhost:5000/api/zalo/messages/group/${id}?count=50`);
        setMessages(res.data.messages || []);
      } else {
        const res = await axios.get(`http://localhost:5000/api/zalo/messages/user/${id}?limit=50`);
        setMessages(res.data.messages || []);
      }
    } catch (err) {
      console.error('Lỗi khi tải lịch sử tin nhắn:', err);
    }
  };

  const handleSearchPhone = async (phone) => {
    if (!phone) return;
    try {
      const res = await axios.get(`http://localhost:5000/api/zalo/search-phone?phone=${phone}`);
      if (res.data.success && res.data.found) {
        setSearchResult(res.data.contact);
      } else {
        alert('Không tìm thấy liên hệ với SĐT này!');
        setSearchResult(null);
      }
    } catch (err) {
      alert('Lỗi tra cứu SĐT: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleSendFileOrImage = async (e) => {
    const file = e.target.files[0];
    if (!file || !selectedThreadId) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('threadId', selectedThreadId);

    const isImage = file.type.startsWith('image/');
    const endpoint = isImage ? '/api/zalo/send-image' : '/api/zalo/send-file';

    try {
      await axios.post(`http://localhost:5000${endpoint}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      alert('Đã gửi file/ảnh thành công!');
    } catch (err) {
      alert('Gửi file thất bại: ' + (err.response?.data?.error || err.message));
    }
  };

  return (
    <div style={{ display: 'flex', gap: 20, padding: 20 }}>
      {/* Sidebar danh sách */}
      <div style={{ width: 280, borderRight: '1px solid #ccc', paddingRight: 10 }}>
        {/* Tìm kiếm SĐT */}
        <h4>Tra Cứu Theo SĐT</h4>
        <div style={{ display: 'flex', gap: 5, marginBottom: 15 }}>
          <input
            type="text"
            placeholder="Nhập SĐT 0xxx..."
            value={searchPhone}
            onChange={(e) => setSearchPhone(e.target.value)}
            style={{ flex: 1, padding: 5 }}
          />
          <button onClick={() => handleSearchPhone(searchPhone)}>Tìm</button>
        </div>

        {searchResult && (
          <div style={{ background: '#f0f8ff', padding: 10, borderRadius: 5, marginBottom: 15 }}>
            <p style={{ margin: '0 0 5px 0' }}><strong>Tên gợi nhớ (Alias):</strong> {searchResult.resolvedName}</p>
            <p style={{ margin: '0 0 5px 0', fontSize: 12, color: '#666' }}>Tên Zalo: {searchResult.displayName}</p>
            <button onClick={() => handleSelectThread(searchResult.userId, false)}>Chat Ngay</button>
          </div>
        )}

        <h4>Bạn Bè</h4>
        <ul>
          {friends.map(f => (
            <li key={f.userId} onClick={() => handleSelectThread(f.userId, false)} style={{ cursor: 'pointer' }}>
              {f.alias || f.displayName || f.userId}
            </li>
          ))}
        </ul>

        <h4>Nhóm</h4>
        <ul>
          {groups.map(g => (
            <li key={g.groupId} onClick={() => handleSelectThread(g.groupId, true)} style={{ cursor: 'pointer' }}>
              {g.name || g.groupId}
            </li>
          ))}
        </ul>
      </div>

      {/* Frame Chat */}
      <div style={{ flex: 1 }}>
        <h4>Đang chat với: {selectedThreadId || 'Chưa chọn'}</h4>
        <div style={{ height: 350, overflowY: 'auto', border: '1px solid #ddd', padding: 10 }}>
          {messages.map((m, idx) => (
            <div key={idx} style={{ textAlign: m.sender_id === 'me' || m.uidFrom === 'me' ? 'right' : 'left' }}>
              <p><strong>{m.sender_name || m.uidFrom}:</strong> {m.content || m.msg || JSON.stringify(m)}</p>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
          <input
            type="file"
            onChange={handleSendFileOrImage}
            style={{ width: 200 }}
          />
        </div>
      </div>
    </div>
  );
}
```
