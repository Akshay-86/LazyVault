export type RequestStatus =
  | 'WAITING_FOR_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'NEGOTIATING'
  | 'TRANSFERRING'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'FAILED';

export type TransportType = 'webrtc' | 'relay';

export interface CatalogItem {
  path: string;
  name: string;
  size: number;
  sha256: string;
  mtime: number;
  mimeType?: string;
}

export interface CatalogGeneration {
  deviceId: string;
  rootHash: string;
  timestamp: number;
  itemCount: number;
  totalSize: number;
  files: CatalogItem[];
}

export interface FileRequest {
  id: string;
  nonce: string;
  targetSha256: string;
  path: string;
  requesterContext: string;
  requesterIp: string;
  requesterUserAgent: string;
  supportedTransports: TransportType[];
  chosenTransport?: TransportType;
  status: RequestStatus;
  vaultId?: string;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  completedAt?: number;
  relayMetadata?: RelayMetadata;
  error?: string;
}

export interface RelayMetadata {
  downloadUrl: string;
  encryptionKeyB64: string; // Ephemeral AES-256-GCM key
  ivB64: string;            // 12-byte IV for AES-GCM
  authTagB64?: string;      // 16-byte auth tag
  ciphertextSha256?: string;
  originalSha256: string;
  expiresAt: number;
  fileSizeBytes: number;
}

export interface SignalingMessage {
  id: string;
  requestId: string;
  sender: 'client' | 'device';
  type: 'offer' | 'answer' | 'candidate';
  payload: any;
  timestamp: number;
}

export interface DeviceRegistration {
  deviceId: string;
  deviceName: string;
  fcmToken: string;
  publicKey?: string;
  lastSeen: number;
  ipAddress: string;
}
