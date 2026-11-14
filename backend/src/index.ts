import express, { Request, Response, NextFunction } from 'express';
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
import { createRateLimiter } from './middleware/rateLimiter.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 4000;

// Permissive CSP middleware so browser loads scripts, styles, web workers & websockets without security block
app.use((_req: Request, res: Response, next: NextFunction) => {
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

// --- RATE LIMITING MIDDLEWARE ---
// General API rate limiter (protects broker from abuse while allowing intensive test suites)
const generalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 600,
  message: 'API rate limit exceeded. Please back off and try again shortly.',
});

// Sensitive request initiation limiter (prevents push notification spam / battery drain attacks)
const requestInitiationLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many transfer requests initiated. Please wait before creating another request.',
});

// Strict brute-force protection on vault password verification
const authLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many vault authentication attempts. Access temporarily delayed.',
});

app.use('/api/v1', generalLimiter);
app.use('/api/v1/request-file', (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'POST') {
    return requestInitiationLimiter(req, res, next);
  }
  next();
});
app.use(['/api/v1/vault/:id/verify-password', '/api/v1/vault/:id/auth'], authLimiter);

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
    return res.status(404).json({ success: false, error: 'Request not found' });
  }

  if (!encryptionKey || !iv) {
    return res.status(400).json({
      success: false,
      error: 'Missing required crypto fields: encryption_key_b64 / ephemeral_key and iv_b64 / iv',
    });
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
    success: true,
    status: 'COMPLETED',
    request_id: requestId,
    requestId,
    download_url: finalDownloadUrl,
    downloadUrl: finalDownloadUrl,
    expires_at: relayMeta.expiresAt,
    relay_metadata: relayMeta,
    relayMetadata: relayMeta,
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

  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
      return next();
    }
    res.sendFile(path.join(webDistPath, 'index.html'));
  });
}

// Global Express Error Handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Server] Unhandled request error:', err);
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal Server Error',
      message: err.message || 'An unexpected error occurred.',
    });
  }
});

// WebSocket Server with Heartbeat & Connection Cleanup
interface ExtWebSocket extends WebSocket {
  isAlive?: boolean;
}

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((wsClient) => {
    const extWs = wsClient as ExtWebSocket;
    if (extWs.isAlive === false) {
      console.log('[WebSocket] Terminating inactive connection');
      return extWs.terminate();
    }
    extWs.isAlive = false;
    extWs.ping();
  });
}, 30000);

if (heartbeatInterval.unref) {
  heartbeatInterval.unref();
}

wss.on('connection', (ws: ExtWebSocket, req) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  console.log(`[WebSocket] Client connected from ${req.socket.remoteAddress}`);

  const activeHandlers = new Map<string, (data: any) => void>();

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'SUBSCRIBE_REQUEST' && data.requestId) {
        if (!activeHandlers.has(data.requestId)) {
          const handler = (updatedReq: any) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'REQUEST_UPDATE', payload: updatedReq }));
            }
          };
          activeHandlers.set(data.requestId, handler);
          store.on(`request:${data.requestId}`, handler);
        }
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
    for (const [reqId, handler] of activeHandlers.entries()) {
      store.off(`request:${reqId}`, handler);
    }
    activeHandlers.clear();
    console.log('[WebSocket] Client disconnected');
  });

  ws.on('error', (err) => {
    console.warn('[WebSocket] Client error:', err);
  });
});

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Graceful process shutdown
const handleShutdown = () => {
  console.log('[Server] Gracefully shutting down LazyVault server...');
  clearInterval(heartbeatInterval);
  store.destroy();
  relayService.destroy();

  wss.clients.forEach(c => c.terminate());
  wss.close(() => {
    server.close(() => {
      console.log('[Server] HTTP & WebSocket servers terminated cleanly.');
      process.exit(0);
    });
  });

  // Force exit after 5s if still hanging
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`  LazyVault Request Broker & Signaling Service`);
  console.log(`  HTTP/REST: http://localhost:${PORT}`);
  console.log(`  Web Dashboard: http://localhost:${PORT}/v/<vaultId>`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`====================================================`);
});

export { app, server, wss };
