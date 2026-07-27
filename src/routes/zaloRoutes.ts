import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { ZaloClientManager } from '../services/ZaloClientManager';
import { ZaloMessageStore } from '../services/ZaloMessageStore';

const router = Router();
const clientManager = ZaloClientManager.getInstance();

// Cấu hình Multer giữ nguyên extension đuôi file gốc
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}-${Date.now()}${ext}`);
  }
});

const upload = multer({ storage });

/**
 * GET /api/zalo/qr
 * Trả về dữ liệu ảnh QR Code đăng nhập
 */
router.get('/qr', async (req: Request, res: Response) => {
  try {
    const status = clientManager.getStatus();
    if (status.isLoggedIn) {
      return res.json({
        success: true,
        status: 'already_logged_in',
        user: status.user,
        qr: '',
      });
    }

    const result = await clientManager.generateQRLogin();
    return res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Lỗi khi khởi tạo QR Code',
    });
  }
});

/**
 * GET /api/zalo/status
 * Kiểm tra trạng thái đã đăng nhập hay chưa
 */
router.get('/status', (req: Request, res: Response) => {
  try {
    const status = clientManager.getStatus();
    return res.json({
      success: true,
      isLoggedIn: status.isLoggedIn,
      user: status.user,
      latestQRStatus: status.latestQR.status,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/zalo/friends
 * Lấy danh bạ bạn bè
 */
router.get('/friends', async (req: Request, res: Response) => {
  try {
    const friends = await clientManager.getFriends();
    return res.json({
      success: true,
      friends,
    });
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Lỗi khi lấy danh sách bạn bè',
    });
  }
});

/**
 * GET /api/zalo/groups
 * Lấy danh sách nhóm
 */
router.get('/groups', async (req: Request, res: Response) => {
  try {
    const groups = await clientManager.getGroups();
    return res.json({
      success: true,
      groups,
    });
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Lỗi khi lấy danh sách nhóm',
    });
  }
});

function parseThreadType(threadType: any): number | undefined {
  if (threadType === undefined || threadType === null || threadType === '') return undefined;
  if (threadType === 'group' || threadType === '1' || threadType === 1) return 1;
  if (threadType === 'user' || threadType === '0' || threadType === 0) return 0;
  const num = Number(threadType);
  return isNaN(num) ? undefined : num;
}

/**
 * POST /api/zalo/send-message
 * Gửi tin nhắn văn bản
 */
router.post('/send-message', async (req: Request, res: Response) => {
  try {
    const { threadId, message, threadType } = req.body;

    if (!threadId || !message) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu tham số threadId hoặc message',
      });
    }

    const typeNum = parseThreadType(threadType);
    const result = await clientManager.sendMessage(threadId, message, typeNum);
    return res.json({
      success: true,
      result,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Gửi tin nhắn thất bại',
    });
  }
});

/**
 * POST /api/zalo/send-image
 * Gửi hình ảnh đính kèm (multipart/form-data: field name là 'file' hoặc 'image')
 */
router.post('/send-image', upload.single('file'), async (req: Request, res: Response) => {
  let tempFilePath = '';
  try {
    const file = req.file;
    const { threadId, threadType, caption } = req.body;

    if (!file || !threadId) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu file ảnh hoặc tham số threadId',
      });
    }

    tempFilePath = file.path;
    const typeNum = parseThreadType(threadType);
    const result = await clientManager.sendImage(threadId, tempFilePath, typeNum, caption, file.originalname);

    return res.json({
      success: true,
      result,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Gửi ảnh thất bại',
    });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {}
    }
  }
});

/**
 * POST /api/zalo/send-file
 * Gửi file tài liệu (multipart/form-data: field name là 'file')
 */
router.post('/send-file', upload.single('file'), async (req: Request, res: Response) => {
  let tempFilePath = '';
  try {
    const file = req.file;
    const { threadId, threadType } = req.body;

    if (!file || !threadId) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu file đính kèm hoặc tham số threadId',
      });
    }

    tempFilePath = file.path;
    const typeNum = parseThreadType(threadType);
    const result = await clientManager.sendFile(threadId, tempFilePath, typeNum);

    return res.json({
      success: true,
      result,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Gửi file thất bại',
    });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {}
    }
  }
});

/**
 * GET /api/zalo/messages/group/:groupId
 * Lấy lịch sử 50 tin nhắn nhóm mới nhất từ Zalo
 */
router.get('/messages/group/:groupId', async (req: Request, res: Response) => {
  try {
    const { groupId } = req.params;
    const count = req.query.count ? Number(req.query.count) : 50;

    const history = await clientManager.getGroupChatHistory(groupId, count);
    return res.json({
      success: true,
      count: Array.isArray(history) ? history.length : 0,
      messages: history,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Không thể lấy lịch sử tin nhắn nhóm',
    });
  }
});

/**
 * GET /api/zalo/messages/user/:friendId
 * Lấy lịch sử tin nhắn với bạn bè từ Supabase (hoặc Local fallback)
 */
router.get('/messages/user/:friendId', async (req: Request, res: Response) => {
  try {
    const { friendId } = req.params;
    const limit = req.query.limit ? Number(req.query.limit) : 50;

    const messages = await ZaloMessageStore.getMessagesByThread(friendId, limit);
    return res.json({
      success: true,
      messages,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Không thể lấy lịch sử tin nhắn bạn bè',
    });
  }
});

/**
 * GET /api/zalo/conversations
 * Lấy danh sách cuộc hội thoại chat gần đây từ Supabase
 */
router.get('/conversations', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const conversations = await ZaloMessageStore.getRecentConversations(limit);

    return res.json({
      success: true,
      conversations,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Không thể lấy danh sách cuộc hội thoại',
    });
  }
});

/**
 * POST /api/zalo/logout
 * Đăng xuất tài khoản hiện tại
 */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    await clientManager.logout();
    return res.json({
      success: true,
      message: 'Đã đăng xuất tài khoản Zalo',
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
