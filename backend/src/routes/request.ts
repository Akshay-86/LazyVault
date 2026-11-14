import { Router, Request, Response } from 'express';
import { store } from '../store.js';
import { fcmService } from '../fcm.js';
import { TransportType } from '../types.js';

const router = Router();

// POST /api/v1/request-file
router.post('/', async (req: Request, res: Response) => {
  const targetSha256 = req.body.target_sha256 || req.body.sha256 || req.body.targetSha256;
  const filePath = req.body.path;
  const requesterContext = req.body.requester_context || req.body.requesterContext || 'Anonymous Requester';
  const supportedTransportsRaw = req.body.supported_transports || req.body.supportedTransports;
  const vaultId = req.body.vault_id || req.body.vaultId;

  if (!targetSha256 || !filePath) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameters: target_sha256 (or sha256) and path are required.',
    });
  }

  // Validate supported transports
  const transports: TransportType[] = Array.isArray(supportedTransportsRaw) && supportedTransportsRaw.length > 0
    ? supportedTransportsRaw
    : ['webrtc', 'relay'];

  const requesterIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || '127.0.0.1';
  const requesterUserAgent = req.headers['user-agent'] || 'Unknown Client';

  // Create request with strict 60s TTL
  const request = store.createRequest({
    targetSha256,
    path: filePath,
    requesterContext,
    requesterIp,
    requesterUserAgent,
    supportedTransports: transports,
    vaultId,
  });

  // Look up registered device
  const device = store.getPrimaryDevice();

  // Dispatch high-priority trigger
  const dispatchResult = await fcmService.dispatchApprovalRequest(device?.fcmToken, request);

  console.log(`[Request] Created request ${request.id} for ${filePath} (${request.targetSha256.slice(0, 10)}...). TTL: 60s. FCM dispatched: ${dispatchResult.sentViaFcm}`);

  return res.status(202).json({
    success: true,
    request_id: request.id,
    requestId: request.id,
    status: request.status,
    nonce: request.nonce,
    path: request.path,
    target_sha256: request.targetSha256,
    targetSha256: request.targetSha256,
    expires_at: request.expiresAt,
    ttl_seconds: 60,
    leaseTtlSeconds: 60,
    supported_transports: request.supportedTransports,
    supportedTransports: request.supportedTransports,
    message: 'Request dispatched to dormant mobile node. Awaiting user authorization.',
  });
});

// GET /api/v1/request-file/:id - Polling endpoint
router.get('/:id', (req: Request, res: Response) => {
  const request = store.getRequest(req.params.id);
  if (!request) {
    return res.status(404).json({ error: 'Request not found or expired from memory.' });
  }

  return res.status(200).json({
    request_id: request.id,
    requestId: request.id,
    status: request.status,
    path: request.path,
    target_sha256: request.targetSha256,
    chosen_transport: request.chosenTransport,
    expires_at: request.expiresAt,
    time_remaining_ms: Math.max(0, request.expiresAt - Date.now()),
    decided_at: request.decidedAt,
    completed_at: request.completedAt,
    relay_metadata: request.relayMetadata,
    relayMetadata: request.relayMetadata,
    error: request.error,
  });
});

// GET /api/v1/request-file/:id/events - Server-Sent Events (SSE) for zero-latency reactive updates
router.get('/:id/events', (req: Request, res: Response) => {
  const requestId = req.params.id;
  const initialRequest = store.getRequest(requestId);

  if (!initialRequest) {
    return res.status(404).json({ error: 'Request not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send current state immediately
  res.write(`data: ${JSON.stringify(initialRequest)}\n\n`);

  const onUpdate = (updated: any) => {
    if (updated.id === requestId) {
      res.write(`data: ${JSON.stringify(updated)}\n\n`);
      if (['COMPLETED', 'REJECTED', 'EXPIRED', 'FAILED'].includes(updated.status)) {
        store.off(`request:${requestId}`, onUpdate);
        res.end();
      }
    }
  };

  store.on(`request:${requestId}`, onUpdate);

  req.on('close', () => {
    store.off(`request:${requestId}`, onUpdate);
  });
});

// POST /api/v1/request-file/:id/decision - Device submits ALLOW or DENY
router.post('/:id/decision', (req: Request, res: Response) => {
  const { decision, chosen_transport, selected_transport, chosenTransport } = req.body;
  const requestId = req.params.id;

  const current = store.getRequest(requestId);
  if (!current) {
    return res.status(404).json({ success: false, error: 'Request not found or expired' });
  }

  if (Date.now() > current.expiresAt) {
    store.updateRequestStatus(requestId, 'EXPIRED');
    return res.status(410).json({ success: false, error: 'Request has already expired (60s TTL breached).' });
  }

  if (['REJECTED', 'APPROVED', 'COMPLETED'].includes(current.status)) {
    return res.status(409).json({ success: false, error: `Request already has terminal state: ${current.status}` });
  }

  if (decision === 'DENY') {
    const updated = store.updateRequestStatus(requestId, 'REJECTED');
    console.log(`[Request] Request ${requestId} explicitly REJECTED by user.`);
    return res.status(200).json({ success: true, status: 'REJECTED', request: updated });
  }

  if (decision === 'ALLOW') {
    const transport = chosen_transport || selected_transport || chosenTransport || (current.supportedTransports.includes('webrtc') ? 'webrtc' : 'relay');
    const updated = store.updateRequestStatus(requestId, 'APPROVED', {
      chosenTransport: transport,
    });
    console.log(`[Request] Request ${requestId} explicitly APPROVED by user. Chosen transport: ${transport}`);
    return res.status(200).json({
      success: true,
      status: 'APPROVED',
      chosen_transport: transport,
      chosenTransport: transport,
      request: updated,
    });
  }

  return res.status(400).json({ success: false, error: 'Invalid decision. Must be ALLOW or DENY.' });
});

// POST /api/v1/request-file/:id/status - Update state during transfer
router.post('/:id/status', (req: Request, res: Response) => {
  const { status, error } = req.body;
  const requestId = req.params.id;

  const validStatuses = ['NEGOTIATING', 'TRANSFERRING', 'COMPLETED', 'FAILED'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  const updated = store.updateRequestStatus(requestId, status, { error });
  if (!updated) {
    return res.status(404).json({ error: 'Request not found or in terminal state' });
  }

  return res.status(200).json({ success: true, status: updated.status, request: updated });
});

export default router;
