import express, { Request, Response } from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';

import catalogRouter from './routes/catalog.js';
import requestRouter from './routes/request.js';
import signalingRouter from './routes/signaling.js';
import relayRouter from './routes/relay.js';
import deviceRouter from './routes/device.js';
import vaultRouter from './routes/vault.js';
import { store } from './store.js';
import { relayService } from './relay.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 4000;

// Permissive CSP middleware so browser loads scripts, styles, web workers & websockets without security block
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss:;"
  );
  next();
});

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Health Check
app.get('/api/v1/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    system: 'LazyVault Cloud Request Broker & Signaling Service',
    uptime_seconds: process.uptime(),
    registered_devices: store.getPrimaryDevice() ? 1 : 0,
    has_catalog: !!store.getCatalog(),
  });
});

// Mount API Routes
app.use('/api/v1/catalog', catalogRouter);
app.use('/api/v1/request-file', requestRouter);
app.use('/api/v1/signaling', signalingRouter);
app.use('/api/v1/relay', relayRouter);
app.use('/api/v1/device', deviceRouter);
app.use('/api/v1', vaultRouter);

// Exact prompt contract alias: POST /api/v1/relay-complete/:id
app.post('/api/v1/relay-complete/:id', (req: Request, res: Response) => {
  const requestId = req.params.id;
  const encryptionKey = req.body.encryption_key_b64 || req.body.ephemeral_key || req.body.ephemeralKeyHex;
  const iv = req.body.iv_b64 || req.body.iv || req.body.ivHex;
  const authTag = req.body.auth_tag_b64 || req.body.tag || req.body.tagHex;
  const sizeBytes = req.body.file_size_bytes || req.body.size_bytes;
  const download_url = req.body.download_url;

  const request = store.getRequest(requestId);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  if (!encryptionKey || !iv) {
    return res.status(400).json({ error: 'Missing required crypto fields: encryption_key_b64 / ephemeral_key and iv_b64 / iv' });
  }

  const protocol = req.protocol;
  const host = req.get('host');
  const finalDownloadUrl = download_url || `${protocol}://${host}/api/v1/relay/download/${requestId}`;

  const relayMeta = {
    downloadUrl: finalDownloadUrl,
    encryptionKeyB64: encryptionKey,
    ivB64: iv,
    authTagB64: authTag,
    ciphertextSha256: req.body.ciphertext_sha256,
    originalSha256: request.targetSha256,
    expiresAt: Date.now() + 15 * 60 * 1000,
    fileSizeBytes: Number(sizeBytes) || 0,
  };

  relayService.registerMetadata(requestId, relayMeta);
  store.updateRequestStatus(requestId, 'COMPLETED', { relayMetadata: relayMeta });

  console.log(`[Relay] Relay complete received for ${requestId}. Download ready.`);
  return res.status(200).json({
    status: 'COMPLETED',
    request_id: requestId,
    download_url: finalDownloadUrl,
    expires_at: relayMeta.expiresAt,
  });
});

// Serve Web Dashboard Static Files & Handle /v/:vaultId routes
const candidates = [
  path.resolve(process.cwd(), 'web/dist'),
  path.resolve(process.cwd(), '../web/dist'),
  path.resolve(__dirname, '../../web/dist'),
  path.resolve(__dirname, '../../../web/dist'),
];
const webDistPath = candidates.find(c => fs.existsSync(c));

if (webDistPath) {
  console.log(`[Static] Serving Web Dashboard from: ${webDistPath}`);
  app.use(express.static(webDistPath));

  app.get(['/v/:vaultId', '/v/*', '/'], (_req: Request, res: Response) => {
    res.sendFile(path.join(webDistPath, 'index.html'));
  });

  app.get('*', (req: Request, res: Response, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
      return next();
    }
    res.sendFile(path.join(webDistPath, 'index.html'));
  });
}

// WebSocket Server for Real-Time Signaling
wss.on('connection', (ws: WebSocket, req) => {
  console.log(`[WebSocket] Client connected from ${req.socket.remoteAddress}`);

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'SUBSCRIBE_REQUEST' && data.requestId) {
        const handler = (updatedReq: any) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'REQUEST_UPDATE', payload: updatedReq }));
          }
        };
        store.on(`request:${data.requestId}`, handler);
        ws.on('close', () => store.off(`request:${data.requestId}`, handler));
      } else if (data.type === 'SIGNALING' && data.requestId) {
        store.addSignalingMessage({
          requestId: data.requestId,
          sender: data.sender,
          type: data.signalingType,
          payload: data.payload,
        });
      }
    } catch (err) {
      console.error('[WebSocket] Error parsing message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Client disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`  LazyVault Request Broker & Signaling Service`);
  console.log(`  HTTP/REST: http://localhost:${PORT}`);
  console.log(`  Web Dashboard: http://localhost:${PORT}/v/<vaultId>`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`====================================================`);
});

export { app, server };
