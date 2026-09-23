import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { relayService } from '../relay.js';
import { store } from '../store.js';

const router = Router();

// PUT /api/v1/relay/upload/:id or /api/v1/relay/:id/upload
const handleUpload = async (req: Request, res: Response) => {
  const requestId = req.params.id;
  const request = store.getRequest(requestId);

  if (!request) {
    return res.status(404).json({ error: 'Request not found or expired' });
  }

  try {
    store.updateRequestStatus(requestId, 'TRANSFERRING');
    const bytesReceived = await relayService.saveEncryptedStream(requestId, req);
    console.log(`[Relay] Stored encrypted blob for request ${requestId} (${bytesReceived} bytes)`);

    return res.status(200).json({
      status: 'uploaded',
      request_id: requestId,
      bytes_received: bytesReceived,
    });
  } catch (error: any) {
    console.error(`[Relay] Upload failed for request ${requestId}:`, error);
    store.updateRequestStatus(requestId, 'FAILED', { error: error.message });
    return res.status(500).json({ error: 'Failed to stream ciphertext blob' });
  }
};

router.put('/upload/:id', handleUpload);
router.put('/:id/upload', handleUpload);

// GET /api/v1/relay/download/:id and /api/v1/relay/:id/download - Client downloads encrypted ciphertext
const handleDownload = (req: Request, res: Response) => {
  const requestId = req.params.id;
  const result = relayService.getReadStream(requestId);

  if (!result) {
    return res.status(404).json({
      error: 'Ciphertext blob not found or already consumed (single-use zero-trust policy).',
    });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', result.size);
  res.setHeader('Content-Disposition', `attachment; filename="lazyvault-${requestId}.enc"`);

  result.stream.pipe(res);
};

router.get('/download/:id', handleDownload);
router.get('/:id/download', handleDownload);

// GET /api/v1/relay/download-decrypted/:id and /api/v1/relay/:id/download-decrypted
// Provides client-transparent decryption for non-secure HTTP LAN contexts where window.crypto.subtle is restricted
const handleDecryptedDownload = async (req: Request, res: Response) => {
  const requestId = req.params.id;
  const meta = relayService.getMetadata(requestId);
  const result = relayService.getReadStream(requestId);

  if (!result || !meta) {
    return res.status(404).json({ error: 'Ciphertext blob or metadata not found' });
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk as Buffer);
    }
    const ciphertextWithTag = Buffer.concat(chunks);
    const key = Buffer.from(meta.encryptionKeyB64, 'base64');
    const iv = Buffer.from(meta.ivB64, 'base64');

    const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
    const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const request = store.getRequest(requestId);
    const filename = request?.path?.split('/')?.pop() || `lazyvault-${requestId}`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', plaintext.length);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.end(plaintext);
  } catch (err: any) {
    console.error(`[Relay] Decryption failed for ${requestId}:`, err);
    return res.status(500).json({ error: 'Decryption failed: ' + err.message });
  }
};

router.get('/download-decrypted/:id', handleDecryptedDownload);
router.get('/:id/download-decrypted', handleDecryptedDownload);

// POST /api/v1/relay/complete/:id or /api/v1/relay/:id/complete - Phone submits presigned URL & encryption key
const handleComplete = (req: Request, res: Response) => {
  const requestId = req.params.id;
  const encryptionKey = req.body.encryption_key_b64 || req.body.ephemeral_key || req.body.ephemeralKeyHex;
  const iv = req.body.iv_b64 || req.body.iv || req.body.ivHex;
  const authTag = req.body.auth_tag_b64 || req.body.tag || req.body.tagHex;
  const sizeBytes = req.body.file_size_bytes || req.body.size_bytes;
  const downloadUrl = req.body.download_url;

  const request = store.getRequest(requestId);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  if (!encryptionKey || !iv) {
    return res.status(400).json({
      error: 'Missing required crypto fields: encryption_key_b64 / ephemeral_key and iv_b64 / iv',
    });
  }

  // If download_url not supplied, default to the backend's internal relay endpoint
  const protocol = req.protocol;
  const host = req.get('host');
  const finalDownloadUrl = downloadUrl || `${protocol}://${host}/api/v1/relay/download/${requestId}`;

  const relayMeta = {
    downloadUrl: finalDownloadUrl,
    encryptionKeyB64: encryptionKey,
    ivB64: iv,
    authTagB64: authTag,
    ciphertextSha256: req.body.ciphertext_sha256,
    originalSha256: request.targetSha256,
    expiresAt: Date.now() + 15 * 60 * 1000, // 15-minute validity
    fileSizeBytes: Number(sizeBytes) || 0,
  };

  relayService.registerMetadata(requestId, relayMeta);

  // Transition request state to COMPLETED
  store.updateRequestStatus(requestId, 'COMPLETED', {
    relayMetadata: relayMeta,
  });

  console.log(`[Relay] Phone completed encrypted upload for ${requestId}. Ready for client.`);

  return res.status(200).json({
    status: 'COMPLETED',
    request_id: requestId,
    download_url: finalDownloadUrl,
    expires_at: relayMeta.expiresAt,
    relay_metadata: relayMeta,
  });
};

router.post('/complete/:id', handleComplete);
router.post('/:id/complete', handleComplete);

export default router;
