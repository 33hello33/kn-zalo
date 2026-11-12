import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {
  ZaloClientManager,
  ZaloSessionInvalidError,
  isSessionInvalidError,
  ZALO_SESSION_INVALID_CODE,
  ZALO_SESSION_INVALID_MESSAGE,
} from '../services/ZaloClientManager';
import { ZaloMessageStore } from '../services/ZaloMessageStore';

const router = Router();

/**
 * Trả lỗi thống nhất: phiên Zalo hết hiệu lực (zpw_sek) => 401 + code để giao diện
 * hiển thị đúng thông báo "quét QR đăng nhập lại" thay vì lỗi kỹ thuật khó hiểu.
 */
const sendZaloError = (res: Response, error: any, fallbackMessage: string, status = 500) => {
  const sessionInvalid =
    error instanceof ZaloSessionInvalidError ||
    error?.code === ZALO_SESSION_INVALID_CODE ||
    isSessionInvalidError(error);

  if (sessionInvalid) {
    return res.status(401).json({
      success: false,
      code: ZALO_SESSION_INVALID_CODE,
      sessionExpired: true,
      error: error?.message || ZALO_SESSION_INVALID_MESSAGE,
    });
  }

  return res.status(status).json({
    success: false,
    error: error?.message || fallbackMessage,
  });
};

const SEND_DEDUPE_TTL_MS = 10 * 60 * 1000;
const SEND_DEDUPE_MAX_ENTRIES = 500;
const sendResultCache = new Map<string, { at: number; value: any }>();
const sendInFlight = new Map<string, Promise<any>>();

const getDedupeKey = (req: Request): string => {
  const raw = req.body?.dedupeKey ?? req.headers['x-dedupe-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? String(value).trim().slice(0, 120) : '';
};

/**
 * Chống gửi trùng: khi client timeout rồi bấm gửi lại (hoặc 2 tab cùng gửi 1 chứng từ),
 * trả lại kết quả của lần gửi trước thay vì gửi thêm một tin nữa.
 */
const sendWithDedupe = async <T>(appId: string, dedupeKey: string, run: () => Promise<T>): Promise<T> => {
  const key = dedupeKey ? `${appId}:${dedupeKey}` : '';
  if (!key) return run();

  const cached = sendResultCache.get(key);
  if (cached && Date.now() - cached.at < SEND_DEDUPE_TTL_MS) {
    console.log(`[zaloRoutes][${appId}] Bỏ qua gửi trùng (dedupeKey=${dedupeKey})`);
    return cached.value as T;
  }

  const running = sendInFlight.get(key);
  if (running) return running as Promise<T>;

  const promise = run()
    .then((value) => {
      if (sendResultCache.size > SEND_DEDUPE_MAX_ENTRIES) {
        const cutoff = Date.now() - SEND_DEDUPE_TTL_MS;
        for (const [k, v] of sendResultCache) {
          if (v.at < cutoff) sendResultCache.delete(k);
        }
      }
      sendResultCache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      sendInFlight.delete(key);
    });

  sendInFlight.set(key, promise);
  return promise;
};

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
 * Mỗi appId có một phiên Zalo riêng. Khi server restart (Render spin-down/redeploy),
 * bộ nhớ phiên bị mất nên phải khôi phục lại từ Supabase trước khi xử lý request,
 * nếu không mọi appId (trừ 'default' được khôi phục lúc boot) sẽ báo "Chưa đăng nhập Zalo.".
 */
router.use(async (req: Request, res: Response, next) => {
  try {
    const appId = getAppId(req);
    await ZaloClientManager.getInstance(appId).ensureSession();
  } catch (err: any) {
    console.error('[zaloRoutes] ensureSession error:', err?.message || err);
  }
  next();
});

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
    return sendZaloError(res, error, 'Lỗi khi lấy danh sách bạn bè', 400);
  }
});

/**
 * GET /api/zalo/search-phone?phone=0xxxxxxxxx&mahv=HV001
 * Tìm kiếm người dùng theo số điện thoại và lấy tên gợi nhớ (alias).
 * Nếu không tìm thấy bằng SĐT và có truyền mahv/alias, tự động tìm alias theo mã học viên.
 */
router.get('/search-phone', async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const phone = req.query.phone as string;
    const mahv = (req.query.mahv || req.query.alias) as string;

    if (!phone && !mahv) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu tham số query phone hoặc mahv',
      });
    }

    let contact: any = phone ? await clientManager.findUserByPhone(phone) : null;
    let matchedBy = contact ? 'phone' : null;

    // Khi search Zalo bằng SĐT không được, search thử alias theo mã học viên
    if (!contact && mahv) {
      contact = await clientManager.findUserByAlias(mahv);
      if (contact) matchedBy = 'alias';
    }

    if (!contact) {
      return res.json({
        success: true,
        found: false,
        message: 'Không tìm thấy người dùng với số điện thoại hoặc mã học viên này',
        contact: null,
      });
    }

    return res.json({
      success: true,
      found: true,
      matchedBy,
      contact,
    });
  } catch (error: any) {
    return sendZaloError(res, error, 'Lỗi khi tìm kiếm người dùng theo số điện thoại / mã học viên');
  }
});

/**
 * GET /api/zalo/search-alias?alias=HV001 (hoặc ?mahv=HV001)
 * Tìm kiếm người dùng theo alias (tên gợi nhớ) theo mã học viên, lấy ra người đầu tiên
 */
router.get('/search-alias', async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const alias = (req.query.alias || req.query.mahv || req.query.q) as string;
    if (!alias) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu tham số query alias hoặc mahv',
      });
    }

    const contact = await clientManager.findUserByAlias(alias);
    if (!contact) {
      return res.json({
        success: true,
        found: false,
        message: 'Không tìm thấy người dùng với alias này',
        contact: null,
      });
    }

    return res.json({
      success: true,
      found: true,
      matchedBy: 'alias',
      contact,
    });
  } catch (error: any) {
    return sendZaloError(res, error, 'Lỗi khi tìm kiếm người dùng theo alias');
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
    return sendZaloError(res, error, 'Lỗi khi lấy danh sách nhóm', 400);
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
    const result = await sendWithDedupe(appId, getDedupeKey(req), () =>
      clientManager.sendMessage(threadId, msgPayload, typeNum));
    return res.json({
      success: true,
      result,
      messageId: result?.message?.msgId || null,
    });
  } catch (error: any) {
    return sendZaloError(res, error, 'Gửi tin nhắn thất bại');
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
    const result = await sendWithDedupe(appId, getDedupeKey(req), () =>
      clientManager.sendImage(threadId, tempFilePath, typeNum, caption, file.originalname));

    return res.json({
      success: true,
      result,
      messageId: result?.message?.msgId || result?.attachment?.[0]?.msgId || null,
    });
  } catch (error: any) {
    return sendZaloError(res, error, 'Gửi ảnh thất bại');
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
    const result = await sendWithDedupe(appId, getDedupeKey(req), () =>
      clientManager.sendFile(threadId, tempFilePath, typeNum, file.originalname));

    return res.json({
      success: true,
      result,
      messageId: result?.message?.msgId || result?.attachment?.[0]?.msgId || null,
    });
  } catch (error: any) {
    return sendZaloError(res, error, 'Gửi file thất bại');
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

    let history: any = null;
    try {
      history = await clientManager.getGroupChatHistory(groupId, count);
    } catch (apiErr: any) {
      console.warn(`[zaloRoutes][${appId}] getGroupChatHistory error:`, apiErr?.message);
    }

    let msgs: any[] = [];
    if (history) {
      if (Array.isArray(history)) {
        msgs = history;
      } else if (Array.isArray(history.groupMsgs)) {
        msgs = history.groupMsgs;
      } else if (Array.isArray(history.messages)) {
        msgs = history.messages;
      } else if (Array.isArray(history.data)) {
        msgs = history.data;
      }
    }

    // Fallback: nếu Zalo API không trả về hoặc trả về rỗng, lấy từ Supabase (zalo_messages)
    if (!msgs || msgs.length === 0) {
      try {
        const stored = await ZaloMessageStore.getMessagesByThread(groupId, count, appId);
        if (Array.isArray(stored) && stored.length > 0) {
          msgs = stored;
        }
      } catch (storeErr: any) {
        console.warn(`[zaloRoutes][${appId}] ZaloMessageStore fallback error:`, storeErr?.message);
      }
    }

    return res.json({
      success: true,
      count: msgs.length,
      messages: msgs,
    });
  } catch (error: any) {
    try {
      const appId = getAppId(req);
      const { groupId } = req.params;
      const count = req.query.count ? Number(req.query.count) : 50;
      const stored = await ZaloMessageStore.getMessagesByThread(groupId, count, appId);
      return res.json({
        success: true,
        count: stored.length,
        messages: stored,
      });
    } catch {
      return res.status(500).json({
        success: false,
        error: error.message || 'Không thể lấy lịch sử tin nhắn nhóm',
      });
    }
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
 * GET /api/zalo/group-info/:groupId
 * Lấy thông tin chi tiết một nhóm (Tên nhóm, Avatar, Số thành viên, v.v.)
 */
router.get('/group-info/:groupId', async (req: Request, res: Response) => {
  try {
    const appId = getAppId(req);
    const clientManager = ZaloClientManager.getInstance(appId);
    const { groupId } = req.params;
    const info = await clientManager.getGroupInfo(groupId);
    return res.json({ success: true, info });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'Lỗi tải thông tin nhóm' });
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
    let groupInfo: any = null;
    try {
      groupInfo = await clientManager.getGroupInfo(groupId);
    } catch {}
    return res.json({
      success: true,
      members,
      groupName: groupInfo?.name || groupId,
      avatar: groupInfo?.avatar || '',
      info: groupInfo
    });
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
