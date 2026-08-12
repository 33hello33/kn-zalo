import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { ZaloClientManager } from '../services/ZaloClientManager';
import { ZaloMessageStore } from '../services/ZaloMessageStore';

const router = Router();

// Helper to extract appId from request headers or query params
const getAppId = (req: Request): string => {
  const headerAppId = req.headers['x-app-id'] as string;
  const queryAppId = req.query.appId as string;
  const bodyAppId = req.body?.appId as string;
  return (headerAppId || queryAppId || bodyAppId || 'default').trim();
};

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
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
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
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
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
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
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
 * GET /api/zalo/search-phone?phone=0xxxxxxxxx
 * Tìm kiếm người dùng theo số điện thoại và lấy tên gợi nhớ (alias)
 */
router.get('/search-phone', async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const phone = req.query.phone as string;
    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu tham số query phone',
      });
    }

    const contact = await clientManager.findUserByPhone(phone);
    if (!contact) {
      return res.json({
        success: true,
        found: false,
        message: 'Không tìm thấy người dùng với số điện thoại này',
        contact: null,
      });
    }

    return res.json({
      success: true,
      found: true,
      contact,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Lỗi khi tìm kiếm người dùng theo số điện thoại',
    });
  }
});

/**
 * GET /api/zalo/groups
 * Lấy danh sách nhóm
 */
router.get('/groups', async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
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
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const { threadId, message, threadType, quote } = req.body;

    if (!threadId || !message) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu tham số threadId hoặc message',
      });
    }

    const typeNum = parseThreadType(threadType);
    let msgPayload: any = message;
    if (quote) {
      msgPayload = {
        msg: message,
        quote: quote
      };
    }
    const result = await clientManager.sendMessage(threadId, msgPayload, typeNum);
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
router.post('/send-image', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (req: Request, res: Response) => {
  let tempFilePath = '';
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const file = files?.['file']?.[0] || files?.['image']?.[0] || req.file;
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
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
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
    const result = await clientManager.sendFile(threadId, tempFilePath, typeNum, file.originalname);

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
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
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
    const appId = getAppId(req);
    const { friendId } = req.params;
    const limit = req.query.limit ? Number(req.query.limit) : 50;

    const messages = await ZaloMessageStore.getMessagesByThread(friendId, limit, appId);
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
    const appId = getAppId(req);
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const conversations = await ZaloMessageStore.getRecentConversations(limit, appId);

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
 * GET /api/zalo/aliases
 * Lấy danh sách biệt danh (Alias) từ Zalo
 */
router.get(['/aliases', '/alias-list'], async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const aliases = await clientManager.getAliases();
    return res.json({
      success: true,
      aliases,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Lỗi khi lấy danh sách biệt danh',
    });
  }
});

/**
 * POST /api/zalo/set-alias
 * Đặt biệt danh (Alias) cho bạn bè
 */
router.post('/set-alias', async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const { userId, alias } = req.body;
    if (!userId || alias === undefined) {
      return res.status(400).json({ success: false, error: 'Thiếu userId hoặc alias' });
    }
    const result = await clientManager.setAlias(userId, alias);
    return res.json({ success: true, result });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'Lỗi đặt biệt danh' });
  }
});

/**
 * GET /api/zalo/sticker-category/:cateId
 * Lấy danh sách ảnh sticker thực tế của một gói từ Zalo API
 */
router.get('/sticker-category/:cateId', async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const { cateId } = req.params;
    const detail: any = await clientManager.getStickerCategoryDetail(Number(cateId));
    return res.json({ success: true, response: detail });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/zalo/sticker-url/:stickerId
 * Lấy link ảnh sticker trực tiếp từ Zalo Server API (getStickersDetail)
 */
router.get('/sticker-url/:stickerId', async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const { stickerId } = req.params;
    const detail: any = await clientManager.getStickersDetail(Number(stickerId));
    const stk = Array.isArray(detail) ? detail[0] : (detail?.stickers?.[0] || detail);
    const imgUrl = stk?.spriteUrl || stk?.normalUrl || stk?.staticUrl || stk?.url || '';
    return res.json({ success: true, url: imgUrl, detail: stk });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/zalo/send-sticker
 * Gửi sticker Zalo
 */
router.post('/send-sticker', async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const { threadId, stickerId, threadType } = req.body;
    if (!threadId || !stickerId) {
      return res.status(400).json({ success: false, error: 'Thiếu threadId hoặc stickerId' });
    }
    const typeNum = parseThreadType(threadType);
    const result = await clientManager.sendSticker(threadId, Number(stickerId), typeNum);
    return res.json({ success: true, result });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'Gửi sticker thất bại' });
  }
});

/**
 * GET /api/zalo/group-members/:groupId
 * Lấy danh sách thành viên nhóm & vai trò
 */
router.get('/group-members/:groupId', async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const { groupId } = req.params;
    const members = await clientManager.getGroupMembers(groupId);
    return res.json({ success: true, members });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'Lỗi tải danh sách thành viên nhóm' });
  }
});

/**
 * POST /api/zalo/logout
 * Đăng xuất tài khoản hiện tại
 */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
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
