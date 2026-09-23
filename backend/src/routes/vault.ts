import { Router, Request, Response } from 'express';
import { store } from '../store.js';
import { CatalogGeneration } from '../types.js';
import { relayService } from '../relay.js';

const router = Router();

import fs from 'fs';
import path from 'path';

// Store vault metadata with disk persistence
const vaults = new Map<string, any>();
const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const vaultsFile = path.join(dataDir, 'vaults.json');

const loadVaultsFromDisk = () => {
  try {
    if (fs.existsSync(vaultsFile)) {
      const raw = fs.readFileSync(vaultsFile, 'utf-8');
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) {
        vaults.set(k, v);
      }
      console.log(`[Vault] Loaded ${vaults.size} vault link(s) from persistent disk storage`);
    }
  } catch (e) {
    console.warn('[Vault] Failed loading vaults from disk:', e);
  }
};

const saveVaultsToDisk = () => {
  try {
    const obj: Record<string, any> = {};
    for (const [k, v] of vaults.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(vaultsFile, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[Vault] Failed saving vaults to disk:', e);
  }
};

loadVaultsFromDisk();

// GET /api/v1/network-info
router.get('/network-info', (req: Request, res: Response) => {
  const host = req.get('host') || '127.0.0.1:4000';
  res.json({
    status: 'ok',
    host,
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || '127.0.0.1',
    port: 4000,
    timestamp: Date.now(),
  });
});

// POST /api/v1/vault/sync
router.post('/vault/sync', (req: Request, res: Response) => {
  const { vaultId, deviceId, password, expiresInSeconds, catalog } = req.body;

  if (catalog && Array.isArray(catalog.files)) {
    const totalSize = catalog.files.reduce((acc: number, f: any) => acc + (Number(f.size) || 0), 0);
    const generation: CatalogGeneration = {
      deviceId: deviceId || 'unknown-device',
      rootHash: catalog.rootMerkle || 'unknown-root',
      timestamp: Number(catalog.generation) || Date.now(),
      itemCount: catalog.files.length,
      totalSize,
      files: catalog.files.map((f: any) => ({
        path: f.path,
        name: f.name || f.path.split('/').pop() || 'file',
        size: Number(f.size) || 0,
        sha256: f.sha256,
        mtime: Number(f.mtime) || Date.now(),
      })),
    };
    store.setCatalog(generation);
    console.log(`[Vault] Synced vault ${vaultId} with ${catalog.files.length} files from ${deviceId}`);
  }

  const host = req.get('host') || 'localhost:4000';
  const protocol = req.protocol;
  const shareUrl = `${protocol}://${host}/v/${vaultId}`;

  vaults.set(vaultId, {
    vaultId,
    deviceId,
    password: password || '',
    expiresInSeconds: Number(expiresInSeconds) || null,
    shareUrl,
    syncedAt: Date.now(),
  });
  saveVaultsToDisk();

  return res.status(200).json({
    status: 'success',
    vaultId,
    shareUrl,
    message: 'Vault synchronized successfully',
  });
});

// GET /api/v1/vault/:id/info - Check if vault requires password and if link is expired
router.get('/vault/:id/info', (req: Request, res: Response) => {
  const vaultId = req.params.id;
  let v = vaults.get(vaultId);
  if (!v) {
    loadVaultsFromDisk();
    v = vaults.get(vaultId);
  }

  if (!v) {
    return res.json({
      vaultId,
      hasPassword: true,
      requiresPassword: true,
      isExpired: false,
      syncedAt: null,
      expiresInSeconds: null,
    });
  }

  const now = Date.now();
  let isExpired = false;
  let remainingSeconds = null;

  if (v.expiresInSeconds && v.expiresInSeconds > 0 && v.syncedAt) {
    const expireTimestamp = v.syncedAt + v.expiresInSeconds * 1000;
    if (now > expireTimestamp) {
      isExpired = true;
      remainingSeconds = 0;
    } else {
      remainingSeconds = Math.max(0, Math.floor((expireTimestamp - now) / 1000));
    }
  }

  const hasPass = !!(v && v.password && v.password.trim().length > 0);

  return res.json({
    vaultId,
    hasPassword: hasPass,
    requiresPassword: hasPass,
    syncedAt: v?.syncedAt || null,
    expiresInSeconds: v?.expiresInSeconds || null,
    isExpired,
    remainingSeconds,
    expiresAt: (v.expiresInSeconds && v.syncedAt) ? v.syncedAt + v.expiresInSeconds * 1000 : null,
  });
});

// POST /api/v1/vault/:id/verify-password - Verify entered passcode
router.post('/vault/:id/verify-password', (req: Request, res: Response) => {
  const vaultId = req.params.id;
  const { password } = req.body;
  const v = vaults.get(vaultId);

  if (!v || !v.password || v.password.trim().length === 0) {
    return res.json({ status: 'ok', token: 'unlocked' });
  }

  if (v.password === password) {
    console.log(`[Vault] Passcode verified successfully for vault ${vaultId}`);
    return res.json({ status: 'ok', token: 'unlocked' });
  }

  console.warn(`[Vault] Invalid passcode attempt for vault ${vaultId}`);
  return res.status(401).json({ error: 'Incorrect vault passcode. Check your Android device.' });
});

// GET /api/v1/vault/:id/pending-requests - Real-time polling endpoint for Android phone
router.get('/vault/:id/pending-requests', (req: Request, res: Response) => {
  const vaultId = req.params.id;
  const pending = store.getPendingRequestsForVault(vaultId);

  const formatted = pending.map((r) => ({
    requestId: r.id,
    path: r.path,
    sha256: r.targetSha256,
    requesterContext: r.requesterContext,
    requesterIp: r.requesterIp,
    supportedTransports: r.supportedTransports,
    expiresAt: r.expiresAt,
  }));

  if (formatted.length > 0) {
    console.log(`[Vault] Returning ${formatted.length} pending request(s) to phone polling for vault ${vaultId}`);
  }

  return res.json({ requests: formatted });
});

// GET /api/v1/vault/:id/clients - Connected clients count
router.get('/vault/:id/clients', (req: Request, res: Response) => {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || '127.0.0.1';
  res.json({
    clients: [
      {
        clientId: 'web-client-1',
        ip,
        deviceName: 'Web Browser Dashboard',
        connectedAt: Date.now() - 30000,
        lastSeen: Date.now(),
        activeSecondsAgo: 0,
      },
    ],
  });
});

// GET /api/v1/vault/:vaultId/ci-download/:sha256 - Direct cURL / CI download
router.get('/vault/:vaultId/ci-download/:sha256', async (req: Request, res: Response) => {
  const { vaultId, sha256 } = req.params;
  const token = (req.query.token as string) || (req.headers.authorization?.replace('Bearer ', ''));

  const v = vaults.get(vaultId);
  if (!v) {
    return res.status(404).json({ error: 'Vault not found or revoked' });
  }

  if (v.password && v.password.trim().length > 0 && v.password !== token) {
    return res.status(401).json({ error: 'Invalid vault token or password' });
  }

  const catalog = store.getCatalog();
  const file = catalog?.files.find(f => f.sha256.toLowerCase() === sha256.toLowerCase());
  if (!file) {
    return res.status(404).json({ error: 'File not found with specified SHA-256 hash in vault' });
  }

  // Create request with 60s TTL
  const request = store.createRequest({
    targetSha256: file.sha256,
    path: file.path,
    requesterContext: 'CI/CD cURL Client',
    requesterIp: (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || '127.0.0.1',
    requesterUserAgent: req.headers['user-agent'] || 'cURL',
    supportedTransports: ['relay'],
    vaultId,
  });

  console.log(`[CI-Download] Dispatched lease request ${request.id} for ${file.name}. Waiting for mobile authorization...`);

  const startTime = Date.now();
  const checkInterval = 400;

  const pollCompleted = () => new Promise<any>((resolve) => {
    const timer = setInterval(() => {
      const current = store.getRequest(request.id);
      if (!current || current.status === 'FAILED' || current.status === 'REJECTED' || current.status === 'EXPIRED') {
        clearInterval(timer);
        resolve(current);
      } else if (current.status === 'COMPLETED' && current.relayMetadata) {
        clearInterval(timer);
        resolve(current);
      } else if (Date.now() - startTime > 65000) {
        clearInterval(timer);
        resolve(null);
      }
    }, checkInterval);
  });

  const finalReq = await pollCompleted();
  if (!finalReq || finalReq.status !== 'COMPLETED' || !finalReq.relayMetadata) {
    return res.status(504).json({
      error: 'Transfer lease timed out or was denied on the Android device.',
    });
  }

  const blobInfo = relayService.getReadStream(request.id);
  if (!blobInfo) {
    return res.status(404).json({ error: 'Ciphertext blob expired or consumed' });
  }

  try {
    const crypto = await import('crypto');
    const chunks: Buffer[] = [];
    for await (const chunk of blobInfo.stream) {
      chunks.push(chunk as Buffer);
    }
    const ciphertextWithTag = Buffer.concat(chunks);
    const key = Buffer.from(finalReq.relayMetadata.encryptionKeyB64, 'base64');
    const iv = Buffer.from(finalReq.relayMetadata.ivB64, 'base64');

    const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
    const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', plaintext.length);
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
    return res.end(plaintext);
  } catch (err: any) {
    console.error('[CI-Download] Decryption failed:', err);
    return res.status(500).json({ error: 'Decryption failed: ' + err.message });
  }
});

// POST /api/v1/vault/:id/revoke
router.post('/vault/:id/revoke', (req: Request, res: Response) => {
  const vaultId = req.params.id;
  vaults.delete(vaultId);
  res.json({ status: 'revoked', vaultId });
});

export default router;
