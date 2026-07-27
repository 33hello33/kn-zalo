import { Router, Request, Response } from 'express';
import { ZaloClientManager } from '../services/ZaloClientManager';

const router = Router();
const clientManager = ZaloClientManager.getInstance();

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

    // Generate/fetch QR
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

/**
 * POST /api/zalo/send-message
 * Nhận nội dung từ Web và gọi ZaloClientManager.sendMessage(...)
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

    const result = await clientManager.sendMessage(threadId, message, threadType);
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
