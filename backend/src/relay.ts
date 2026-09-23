import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { RelayMetadata } from './types.js';

export class EphemeralRelayService {
  private storageDir: string;
  private metadataMap: Map<string, RelayMetadata> = new Map();

  constructor() {
    this.storageDir = path.resolve(process.cwd(), 'ephemeral_relay');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    // Schedule regular purge of expired ephemeral blobs
    setInterval(() => this.purgeExpiredBlobs(), 60 * 1000);
  }

  public getBlobPath(requestId: string): string {
    return path.join(this.storageDir, `${requestId}.enc`);
  }

  public async saveEncryptedStream(requestId: string, stream: Readable): Promise<number> {
    const filePath = this.getBlobPath(requestId);
    const writeStream = fs.createWriteStream(filePath);
    await pipeline(stream, writeStream);
    const stats = await fs.promises.stat(filePath);
    return stats.size;
  }

  public registerMetadata(requestId: string, metadata: RelayMetadata): void {
    this.metadataMap.set(requestId, metadata);
  }

  public getMetadata(requestId: string): RelayMetadata | undefined {
    return this.metadataMap.get(requestId);
  }

  public getReadStream(requestId: string): { stream: fs.ReadStream; size: number } | null {
    const filePath = this.getBlobPath(requestId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const size = fs.statSync(filePath).size;
    const stream = fs.createReadStream(filePath);

    // Single-use guarantee: schedule deletion with 60-second grace period
    stream.on('close', () => {
      setTimeout(() => {
        this.deleteBlob(requestId).catch(() => {});
      }, 60000);
    });

    return { stream, size };
  }

  public async deleteBlob(requestId: string): Promise<void> {
    const filePath = this.getBlobPath(requestId);
    this.metadataMap.delete(requestId);
    if (fs.existsSync(filePath)) {
      try {
        await fs.promises.unlink(filePath);
        console.log(`[Relay] Zero-trust purge: deleted ephemeral blob for request ${requestId}`);
      } catch (err) {
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
  }
}

export const relayService = new EphemeralRelayService();
