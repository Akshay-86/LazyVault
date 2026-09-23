import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CatalogGeneration, FileRequest, RequestStatus, DeviceRegistration, SignalingMessage } from './types.js';

export class LazyVaultStore extends EventEmitter {
  private catalog: CatalogGeneration | null = null;
  private requests: Map<string, FileRequest> = new Map();
  private devices: Map<string, DeviceRegistration> = new Map();
  private signalingQueue: Map<string, SignalingMessage[]> = new Map();
  private usedNonces: Set<string> = new Set();
  private cleanupInterval: NodeJS.Timeout;
  private catalogFile: string;
  private devicesFile: string;

  constructor() {
    super();
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.catalogFile = path.join(dataDir, 'catalog.json');
    this.devicesFile = path.join(dataDir, 'devices.json');

    this.loadFromDisk();

    // Run garbage collection on expired requests every 5 seconds
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 5000);
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.catalogFile)) {
        const raw = fs.readFileSync(this.catalogFile, 'utf-8');
        this.catalog = JSON.parse(raw);
        console.log(`[Store] Restored catalog from disk (${this.catalog?.files?.length || 0} files)`);
      }
    } catch (e) {
      console.warn('[Store] Could not load catalog from disk:', e);
    }

    try {
      if (fs.existsSync(this.devicesFile)) {
        const raw = fs.readFileSync(this.devicesFile, 'utf-8');
        const devList: DeviceRegistration[] = JSON.parse(raw);
        for (const d of devList) {
          this.devices.set(d.deviceId, d);
        }
        console.log(`[Store] Restored ${this.devices.size} device registration(s) from disk`);
      }
    } catch (e) {
      console.warn('[Store] Could not load devices from disk:', e);
    }
  }

  // --- CATALOG MANAGEMENT ---

  public setCatalog(generation: CatalogGeneration): void {
    this.catalog = generation;
    try {
      fs.writeFileSync(this.catalogFile, JSON.stringify(generation, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[Store] Failed writing catalog to disk:', e);
    }
    this.emit('catalog_updated', generation);
  }

  public getCatalog(): CatalogGeneration | null {
    return this.catalog;
  }

  public findFileByHash(sha256: string) {
    if (!this.catalog) return null;
    return this.catalog.files.find(f => f.sha256.toLowerCase() === sha256.toLowerCase()) || null;
  }

  public findFileByPath(path: string) {
    if (!this.catalog) return null;
    return this.catalog.files.find(f => f.path === path) || null;
  }

  // --- DEVICE MANAGEMENT ---

  public registerDevice(reg: DeviceRegistration): void {
    this.devices.set(reg.deviceId, reg);
    this.emit('device_registered', reg);
  }

  public getDevice(deviceId: string): DeviceRegistration | undefined {
    return this.devices.get(deviceId);
  }

  public getPrimaryDevice(): DeviceRegistration | undefined {
    // Return the most recently seen registered device
    let latest: DeviceRegistration | undefined;
    for (const dev of this.devices.values()) {
      if (!latest || dev.lastSeen > latest.lastSeen) {
        latest = dev;
      }
    }
    return latest;
  }

  // --- REQUEST STATE MACHINE ---

  public createRequest(params: {
    targetSha256: string;
    path: string;
    requesterContext: string;
    requesterIp: string;
    requesterUserAgent: string;
    supportedTransports: ('webrtc' | 'relay')[];
    vaultId?: string;
  }): FileRequest {
    const requestId = crypto.randomUUID();
    const nonce = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const ttlMs = 60 * 1000; // Strict 60-second TTL
    const expiresAt = now + ttlMs;

    this.usedNonces.add(nonce);

    const request: FileRequest = {
      id: requestId,
      nonce,
      targetSha256: params.targetSha256,
      path: params.path,
      requesterContext: params.requesterContext,
      requesterIp: params.requesterIp,
      requesterUserAgent: params.requesterUserAgent,
      supportedTransports: params.supportedTransports,
      vaultId: params.vaultId,
      status: 'WAITING_FOR_APPROVAL',
      createdAt: now,
      expiresAt,
    };

    this.requests.set(requestId, request);
    this.emit('request_created', request);
    return request;
  }

  public getPendingRequestsForVault(vaultId?: string): FileRequest[] {
    const now = Date.now();
    const list: FileRequest[] = [];
    for (const req of this.requests.values()) {
      if (req.status === 'WAITING_FOR_APPROVAL' && now <= req.expiresAt) {
        if (!vaultId || !req.vaultId || req.vaultId === vaultId) {
          list.push(req);
        }
      }
    }
    return list;
  }

  public getRequest(id: string): FileRequest | undefined {
    const req = this.requests.get(id);
    if (!req) return undefined;

    // Check if expired
    if (req.status === 'WAITING_FOR_APPROVAL' && Date.now() > req.expiresAt) {
      req.status = 'EXPIRED';
      this.emit('request_updated', req);
    }

    return req;
  }

  public updateRequestStatus(
    id: string,
    status: RequestStatus,
    extra?: Partial<FileRequest>
  ): FileRequest | null {
    const req = this.getRequest(id);
    if (!req) return null;

    // Replay/Terminal state protection:
    // If request already REJECTED, EXPIRED, or COMPLETED, do not allow modification
    if (['REJECTED', 'EXPIRED', 'COMPLETED'].includes(req.status)) {
      return null;
    }

    req.status = status;
    if (status === 'APPROVED' || status === 'REJECTED') {
      req.decidedAt = Date.now();
    }
    if (status === 'COMPLETED') {
      req.completedAt = Date.now();
    }
    if (extra) {
      Object.assign(req, extra);
    }

    this.emit('request_updated', req);
    this.emit(`request:${id}`, req);
    return req;
  }

  // --- SIGNALING MESSAGES ---

  public addSignalingMessage(msg: Omit<SignalingMessage, 'id' | 'timestamp'>): SignalingMessage {
    const fullMsg: SignalingMessage = {
      ...msg,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    const list = this.signalingQueue.get(msg.requestId) || [];
    list.push(fullMsg);
    this.signalingQueue.set(msg.requestId, list);

    this.emit(`signaling:${msg.requestId}`, fullMsg);
    return fullMsg;
  }

  public getSignalingMessages(requestId: string, forPeer?: 'client' | 'device'): SignalingMessage[] {
    const list = this.signalingQueue.get(requestId) || [];
    if (!forPeer) return list;
    // If recipient is client, return messages sent by device, and vice versa
    const sender = forPeer === 'client' ? 'device' : 'client';
    return list.filter(m => m.sender === sender);
  }

  // --- CLEANUP ---

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, req] of this.requests.entries()) {
      if (req.status === 'WAITING_FOR_APPROVAL' && now > req.expiresAt) {
        req.status = 'EXPIRED';
        this.emit('request_updated', req);
        this.emit(`request:${id}`, req);
      }
      // Purge requests older than 1 hour from memory
      if (now - req.createdAt > 3600 * 1000) {
        this.requests.delete(id);
        this.signalingQueue.delete(id);
      }
    }
  }

  public destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}

export const store = new LazyVaultStore();
