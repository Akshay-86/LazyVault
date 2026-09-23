import { Router, Request, Response } from 'express';
import { store } from '../store.js';
import { fcmService } from '../fcm.js';

const router = Router();

// POST /api/v1/device/register - Register Android node FCM token & identity
router.post('/register', (req: Request, res: Response) => {
  const { device_id, device_name, fcm_token, public_key } = req.body;

  if (!device_id || !fcm_token) {
    return res.status(400).json({ error: 'device_id and fcm_token are required' });
  }

  const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || '127.0.0.1';

  store.registerDevice({
    deviceId: device_id,
    deviceName: device_name || 'LazyVault Android Node',
    fcmToken: fcm_token,
    publicKey: public_key,
    lastSeen: Date.now(),
    ipAddress,
  });

  console.log(`[Device] Registered Android node ${device_id} ("${device_name || 'Default'}") from ${ipAddress}`);

  return res.status(200).json({
    status: 'registered',
    device_id,
    timestamp: Date.now(),
  });
});

// GET /api/v1/device/status - Check registered device status
router.get('/status', (_req: Request, res: Response) => {
  const device = store.getPrimaryDevice();
  if (!device) {
    return res.status(200).json({
      status: 'offline',
      registered: false,
      message: 'No Android phone currently registered with this broker.',
    });
  }

  const isRecent = Date.now() - device.lastSeen < 24 * 3600 * 1000;
  return res.status(200).json({
    status: isRecent ? 'registered' : 'stale',
    registered: true,
    device_id: device.deviceId,
    device_name: device.deviceName,
    last_seen: device.lastSeen,
    ip_address: device.ipAddress,
  });
});

// GET /api/v1/device/events - SSE bridge for dev mode / emulators without Google Play Services
router.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', message: 'LazyVault device event bridge active' })}\n\n`);

  const onTrigger = (data: any) => {
    res.write(`data: ${JSON.stringify({ type: 'REQUEST_TRIGGER', payload: data })}\n\n`);
  };

  fcmService.devEvents.on('request_trigger', onTrigger);

  req.on('close', () => {
    fcmService.devEvents.off('request_trigger', onTrigger);
  });
});

export default router;
