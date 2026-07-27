# Hướng Dẫn Tích Hợp Phía React Frontend (Static Website)

Tài liệu này cung cấp code mẫu và hướng dẫn chi tiết giúp kết nối trang web React tĩnh của bạn với Node.js Backend Service vừa xây dựng.

---

## 1. Cài Đặt Thư Viện Cần Thiết

Trên project React Frontend của bạn, cài đặt `socket.io-client` và `axios`:

```bash
npm install socket.io-client axios
```

---

## 2. Tạo Service Khởi Tạo Socket.IO (`src/services/zaloSocketClient.js`)

```javascript
import { io } from 'socket.io-client';

const BACKEND_URL = 'http://localhost:5000';

export const socket = io(BACKEND_URL, {
  autoConnect: true,
  transports: ['websocket', 'polling']
});
```

---

## 3. Component Hiển Thị QR Code & Đăng Nhập (`ZaloQRLogin.jsx`)

```jsx
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { socket } from '../services/zaloSocketClient';

export default function ZaloQRLogin({ onLoginSuccess }) {
  const [qrCode, setQrCode] = useState('');
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    // 1. Kiểm tra trạng thái đã đăng nhập hay chưa
    axios.get('http://localhost:5000/api/zalo/status')
      .then(res => {
        if (res.data.isLoggedIn) {
          setStatus('success');
          if (onLoginSuccess) onLoginSuccess(res.data.user);
        } else {
          // Gọi API khởi tạo QR
          fetchQR();
        }
      });

    // 2. Lắng nghe event QR update từ WebSockets realtime
    socket.on('zalo-qr-update', (data) => {
      console.log('QR status updated:', data.status);
      if (data.qr) setQrCode(data.qr);
      setStatus(data.status);

      if (data.status === 'success') {
        alert('Đăng nhập Zalo thành công!');
        if (onLoginSuccess) onLoginSuccess();
      }
    });

    return () => {
      socket.off('zalo-qr-update');
    };
  }, []);

  const fetchQR = async () => {
    try {
      const res = await axios.get('http://localhost:5000/api/zalo/qr');
      if (res.data.qr) {
        setQrCode(res.data.qr);
      }
      setStatus(res.data.status);
    } catch (err) {
      console.error('Lỗi khi lấy QR:', err);
      setStatus('error');
    }
  };

  return (
    <div style={{ textAlign: 'center', padding: 20 }}>
      <h3>Đăng Nhập Zalo Bằng Mã QR</h3>
      {status === 'waiting' && qrCode && (
        <div>
          <img src={qrCode} alt="Zalo QR Code" style={{ width: 250, height: 250 }} />
          <p>Mở ứng dụng Zalo trên điện thoại để quét mã</p>
        </div>
      )}

      {status === 'scanned' && <p>✅ Đã quét mã thành công! Vui lòng xác nhận trên điện thoại...</p>}
      {status === 'expired' && (
        <div>
          <p>❌ Mã QR đã hết hạn.</p>
          <button onClick={fetchQR}>Tạo lại mã QR</button>
        </div>
      )}
      {status === 'success' && <p>🎉 Bạn đã đăng nhập Zalo thành công!</p>}
    </div>
  );
}
```

---

## 4. Component Chat & Lắng Nghe Tin Nhắn Realtime (`ZaloChatApp.jsx`)

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

  useEffect(() => {
    // 1. Tải danh bạ và nhóm từ Backend
    loadContacts();

    // 2. Lắng nghe sự kiện tin nhắn mới thời gian thực từ Zalo
    socket.on('zalo-message-received', (payload) => {
      console.log('Nội dung tin nhắn Zalo mới:', payload);
      
      // Push tin nhắn mới vào state hiển thị UI
      setMessages(prev => [...prev, payload.data]);
    });

    return () => {
      socket.off('zalo-message-received');
    };
  }, []);

  const loadContacts = async () => {
    try {
      const friendsRes = await axios.get('http://localhost:5000/api/zalo/friends');
      if (friendsRes.data.success) {
        setFriends(friendsRes.data.friends || []);
      }

      const groupsRes = await axios.get('http://localhost:5000/api/zalo/groups');
      if (groupsRes.data.success) {
        setGroups(groupsRes.data.groups || []);
      }
    } catch (err) {
      console.error('Lỗi khi tải danh bạ:', err);
    }
  };

  const handleSendMessage = async () => {
    if (!selectedThreadId || !messageText) return;

    try {
      const res = await axios.post('http://localhost:5000/api/zalo/send-message', {
        threadId: selectedThreadId,
        message: messageText
      });

      if (res.data.success) {
        // Thêm tin nhắn vừa gửi vào giao diện
        setMessages(prev => [...prev, {
          msgId: Date.now(),
          uidFrom: 'me',
          content: messageText
        }]);
        setMessageText('');
      }
    } catch (err) {
      alert('Gửi tin nhắn thất bại: ' + (err.response?.data?.error || err.message));
    }
  };

  return (
    <div style={{ display: 'flex', gap: 20, padding: 20 }}>
      {/* Cột danh sách Bạn bè / Nhóm */}
      <div style={{ width: 250, borderRight: '1px solid #ccc' }}>
        <h4>Bạn Bè</h4>
        <ul>
          {friends.map(f => (
            <li key={f.userId} onClick={() => setSelectedThreadId(f.userId)} style={{ cursor: 'pointer' }}>
              {f.displayName || f.userId}
            </li>
          ))}
        </ul>

        <h4>Nhóm</h4>
        <ul>
          {groups.map(g => (
            <li key={g.groupId} onClick={() => setSelectedThreadId(g.groupId)} style={{ cursor: 'pointer' }}>
              {g.name || g.groupId}
            </li>
          ))}
        </ul>
      </div>

      {/* Cột nội dung khung Chat */}
      <div style={{ flex: 1 }}>
        <h4>Đang chat với: {selectedThreadId || 'Chưa chọn'}</h4>
        <div style={{ height: 300, overflowY: 'auto', border: '1px solid #ddd', padding: 10 }}>
          {messages.map((m, idx) => (
            <div key={idx} style={{ textAlign: m.uidFrom === 'me' ? 'right' : 'left' }}>
              <p><strong>{m.uidFrom}:</strong> {m.content || m.msg || JSON.stringify(m)}</p>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
          <input
            type="text"
            value={messageText}
            onChange={e => setMessageText(e.target.value)}
            placeholder="Nhập nội dung tin nhắn..."
            style={{ flex: 1, padding: 8 }}
          />
          <button onClick={handleSendMessage} style={{ padding: '8px 16px' }}>Gửi</button>
        </div>
      </div>
    </div>
  );
}
```
