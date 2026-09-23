import { Router, Request, Response } from 'express';
import { store } from '../store.js';

const router = Router();

// POST /api/v1/signaling/:id - Relays WebRTC SDP offers/answers and ICE candidates
router.post('/:id', (req: Request, res: Response) => {
  const requestId = req.params.id;
  const { sender, type, payload } = req.body;

  if (!sender || !type || payload === undefined) {
    return res.status(400).json({
      error: 'Invalid signaling message. Required: sender ("client"|"device"), type ("offer"|"answer"|"candidate"), payload',
    });
  }

  const request = store.getRequest(requestId);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  const msg = store.addSignalingMessage({
    requestId,
    sender,
    type,
    payload,
  });

  return res.status(201).json({ status: 'delivered', message_id: msg.id });
});

// GET /api/v1/signaling/:id - Retrieve pending signaling messages
router.get('/:id', (req: Request, res: Response) => {
  const requestId = req.params.id;
  const peer = req.query.peer as ('client' | 'device') | undefined;

  const messages = store.getSignalingMessages(requestId, peer);
  return res.status(200).json({ messages });
});

// GET /api/v1/signaling/:id/events - SSE stream for instant WebRTC signaling
router.get('/:id/events', (req: Request, res: Response) => {
  const requestId = req.params.id;
  const peer = req.query.peer as ('client' | 'device') | undefined;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send any existing messages
  const existing = store.getSignalingMessages(requestId, peer);
  for (const msg of existing) {
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  const onSignaling = (msg: any) => {
    // Only forward to the opposite peer if specified
    if (!peer || (peer === 'client' && msg.sender === 'device') || (peer === 'device' && msg.sender === 'client')) {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    }
  };

  store.on(`signaling:${requestId}`, onSignaling);

  req.on('close', () => {
    store.off(`signaling:${requestId}`, onSignaling);
  });
});

export default router;
