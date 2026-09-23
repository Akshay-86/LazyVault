export interface CatalogItem {
  path: string;
  name: string;
  size: number;
  sha256: string;
  mtime: number;
  mimeType?: string;
}

export interface CatalogResponse {
  status: string;
  message?: string;
  device_id?: string;
  root_hash?: string;
  updated_at?: number;
  item_count: number;
  total_size_bytes: number;
  files: CatalogItem[];
}

export type RequestStatus =
  | 'WAITING_FOR_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'NEGOTIATING'
  | 'TRANSFERRING'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'FAILED';

export interface FileRequestResponse {
  request_id: string;
  status: RequestStatus;
  nonce?: string;
  path: string;
  target_sha256: string;
  chosen_transport?: 'webrtc' | 'relay';
  expires_at: number;
  time_remaining_ms?: number;
  relay_metadata?: {
    downloadUrl: string;
    encryptionKeyB64: string;
    ivB64: string;
    authTagB64?: string;
    originalSha256: string;
    fileSizeBytes: number;
  };
  error?: string;
}
