import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { RelayMetadata } from './types.js';

export class EphemeralRelayService {
  private storageDir: string;
  private metadataMap: Map<string, RelayMetadata> = new Map();
  private consumedBlobs: Set<string> = new Set();
  private purgeInterval: NodeJS.Timeout;

  constructor() {
    this.storageDir = path.resolve(process.cwd(), 'ephemeral_relay');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    // Schedule regular purge of expired ephemeral blobs
    this.purgeInterval = setInterval(() => this.purgeExpiredBlobs(), 60 * 1000);
    if (this.purgeInterval.unref) {
      this.purgeInterval.unref();
    }
  }

  public sanitizeId(requestId: string): string {
    const cleaned = requestId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleaned) {
      throw new Error('Invalid or unsafe request ID');
    }
    return cleaned;
  }

  public getBlobPath(requestId: string): string {
    const safeId = this.sanitizeId(requestId);
    return path.join(this.storageDir, `${safeId}.enc`);
  }

  public async saveEncryptedStream(requestId: string, stream: Readable): Promise<number> {
    const safeId = this.sanitizeId(requestId);
    this.consumedBlobs.delete(safeId);
    const filePath = this.getBlobPath(safeId);
    const writeStream = fs.createWriteStream(filePath);
    await pipeline(stream, writeStream);
    const stats = await fs.promises.stat(filePath);
    return stats.size;
  }

  public registerMetadata(requestId: string, metadata: RelayMetadata): void {
    const safeId = this.sanitizeId(requestId);
    this.metadataMap.set(safeId, metadata);
  }

  public getMetadata(requestId: string): RelayMetadata | undefined {
    const safeId = this.sanitizeId(requestId);
    return this.metadataMap.get(safeId);
  }

  public getReadStream(requestId: string): { stream: fs.ReadStream; size: number } | null {
    const safeId = this.sanitizeId(requestId);

    // Single-use guarantee: reject if already consumed
    if (this.consumedBlobs.has(safeId)) {
      return null;
    }

    const filePath = this.getBlobPath(safeId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    // Mark as consumed immediately so concurrent second downloads cannot start
    this.consumedBlobs.add(safeId);

    const size = fs.statSync(filePath).size;
    const stream = fs.createReadStream(filePath);

    // Single-use zero-trust policy: purge blob from disk as soon as read stream finishes
    const cleanup = () => {
      this.deleteBlob(safeId).catch(() => {});
    };
    stream.once('close', cleanup);
    stream.once('end', cleanup);

    return { stream, size };
  }

  public async deleteBlob(requestId: string): Promise<void> {
    try {
      const safeId = this.sanitizeId(requestId);
      this.consumedBlobs.add(safeId);
      this.metadataMap.delete(safeId);
      const filePath = this.getBlobPath(safeId);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        console.log(`[Relay] Zero-trust purge: deleted ephemeral blob for request ${safeId}`);
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.warn(`[Relay] Failed to delete blob ${requestId}:`, err);
      }
    }
  }

  private purgeExpiredBlobs(): void {
    const now = Date.now();
    for (const [id, meta] of this.metadataMap.entries()) {
      if (now > meta.expiresAt) {
        this.deleteBlob(id);
      }
    }
    // Prune consumedBlobs cache if excessively large
    if (this.consumedBlobs.size > 10000) {
      this.consumedBlobs.clear();
    }
  }

  public destroy(): void {
    clearInterval(this.purgeInterval);
  }
}

export const relayService = new EphemeralRelayService();
