/**
 * WebRTC DataChannel Receiver Pipeline for LazyVault Web Client
 * 100% Serverless via Cloud Firestore Signaling (with REST fallback)
 * Connects to mobile node, reassembles streamed binary chunks, computes SHA-256
 * progressively using streaming hash, and triggers automatic browser download.
 */

import { db } from './firebase.js';
import { doc, collection, addDoc, setDoc, onSnapshot, Unsubscribe } from 'firebase/firestore';
import { TransferProgress } from './types.js';
import { StreamingSha256 } from './utils/crypto.js';

export { type TransferProgress };

export class WebRTCReceiver {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private requestId: string;
  private backendUrl: string;
  private vaultId?: string;
  private expectedSha256: string;
  private filename: string;
  private totalSize: number;
  private currentBatch: ArrayBuffer[] = [];
  private blobParts: Blob[] = [];
  private currentBatchBytes = 0;
  private readonly BATCH_SIZE_BYTES = 32 * 1024 * 1024; // 32MB native Blob batching to prevent V8 heap pressure
  private bytesReceived = 0;
  private startTime = 0;
  private sseSource: EventSource | null = null;
  private firestoreUnsubs: Unsubscribe[] = [];
  private isDestroyed = false;
  private isCompleted = false;
  private isRemoteDescriptionSet = false;
  private queuedCandidates: RTCIceCandidateInit[] = [];
  private lastProgressUpdate = 0;
  private completionTimeout: any = null;
  private streamingHasher = new StreamingSha256();

  private onProgressCb?: (progress: TransferProgress) => void;
  private onCompleteCb?: (blob: Blob, sha256: string) => void;
  private onErrorCb?: (error: Error) => void;

  constructor(params: {
    requestId: string;
    backendUrl: string;
    vaultId?: string;
    expectedSha256: string;
    filename: string;
    totalSize: number;
    onProgress?: (progress: TransferProgress) => void;
    onComplete?: (blob: Blob, sha256: string) => void;
    onError?: (error: Error) => void;
  }) {
    this.requestId = params.requestId;
    this.backendUrl = params.backendUrl ? params.backendUrl.replace(/\/$/, '') : '';
    this.vaultId = params.vaultId;
    this.expectedSha256 = (params.expectedSha256 || '').toLowerCase().trim();
    this.filename = params.filename || 'download';
    this.totalSize = params.totalSize || 0;
    this.onProgressCb = params.onProgress;
    this.onCompleteCb = params.onComplete;
    this.onErrorCb = params.onError;
  }

  public async start(): Promise<void> {
    try {
      this.updateProgress(0, 'Initializing WebRTC peer connection...');

      const config: RTCConfiguration = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      };

      this.pc = new RTCPeerConnection(config);

      // Listen for ICE candidates and send to phone via Firestore
      this.pc.onicecandidate = async (event) => {
        if (event.candidate && !this.isDestroyed) {
          const cand = event.candidate;
          const candInit: RTCIceCandidateInit = {
            candidate: cand.candidate,
            sdpMid: cand.sdpMid,
            sdpMLineIndex: cand.sdpMLineIndex,
          };

          if (this.vaultId && db) {
            try {
              await addDoc(collection(db, 'vaults', this.vaultId, 'requests', this.requestId, 'callerCandidates'), {
                candidate: cand.candidate,
                sdpMid: cand.sdpMid,
                sdpMLineIndex: cand.sdpMLineIndex,
                createdAt: Date.now(),
              });
            } catch (e) {
              console.warn('[WebRTC] Failed to save caller candidate to Firestore:', e);
            }
          }
          if (this.backendUrl) {
            this.sendSignalingMessage('candidate', candInit).catch(() => {});
          }
        }
      };

      this.pc.onconnectionstatechange = async () => {
        if (!this.pc || this.isDestroyed) return;
        console.log(`[WebRTC] Connection state: ${this.pc.connectionState}`);
        if (this.pc.connectionState === 'connected') {
          let connectionType = 'Direct P2P';
          try {
            const stats = await this.pc.getStats();
            stats.forEach((report) => {
              if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated)) {
                const localCand = stats.get(report.localCandidateId);
                const remoteCand = stats.get(report.remoteCandidateId);
                const localType = localCand?.candidateType || 'unknown';
                const remoteType = remoteCand?.candidateType || 'unknown';
                console.log(`[WebRTC] Active ICE Pair: Local=${localType} (${localCand?.ip || localCand?.address}:${localCand?.port}) <--> Remote=${remoteType} (${remoteCand?.ip || remoteCand?.address}:${remoteCand?.port})`);
                if (localType === 'host' && remoteType === 'host') {
                  connectionType = 'Ultra-Fast Direct LAN';
                } else if (localType === 'srflx' || remoteType === 'srflx') {
                  connectionType = 'Router NAT Hairpin';
                }
              }
            });
          } catch (e) {
            console.warn('[WebRTC] Stats inspection error:', e);
          }
          this.updateProgress(25, `${connectionType} connection established!`);
        } else if (this.pc.connectionState === 'failed') {
          this.onErrorCb?.(new Error('WebRTC direct P2P connection failed. Check device network.'));
        }
      };

      // Set up DataChannel
      this.dataChannel = this.pc.createDataChannel('lazyvault-transfer', {
        ordered: true,
      });
      this.setupDataChannel(this.dataChannel);

      // Create Offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Serverless Signaling via Firestore
      if (this.vaultId && db) {
        await setDoc(doc(db, 'vaults', this.vaultId, 'requests', this.requestId), {
          offer: {
            sdp: offer.sdp,
            type: offer.type,
          },
          supportedTransports: ['webrtc', 'relay'],
          updatedAt: Date.now(),
        }, { merge: true });

        this.updateProgress(0, 'Offer created. Awaiting mobile peer authorization...');

        // Listen for phone's WebRTC Answer
        const reqDocUnsub = onSnapshot(doc(db, 'vaults', this.vaultId, 'requests', this.requestId), async (snap) => {
          if (this.isDestroyed || !this.pc) return;
          if (snap.exists()) {
            const data = snap.data();
            if (data.answer && !this.isRemoteDescriptionSet) {
              console.log('[WebRTC] Received remote answer from Android via Firestore');
              try {
                const remoteDesc = new RTCSessionDescription(data.answer);
                await this.pc.setRemoteDescription(remoteDesc);
                this.isRemoteDescriptionSet = true;
                this.updateProgress(15, 'Remote answer received. Punching NAT hole...');

                // Drain queued ICE candidates safely
                while (this.queuedCandidates.length > 0) {
                  const c = this.queuedCandidates.shift();
                  if (c && this.pc) {
                    await this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn);
                  }
                }
              } catch (e) {
                console.error('[WebRTC] Failed setting remote description:', e);
              }
            }
          }
        });
        this.firestoreUnsubs.push(reqDocUnsub);

        // Listen for phone's ICE Candidates (calleeCandidates)
        const calleeCandidatesUnsub = onSnapshot(
          collection(db, 'vaults', this.vaultId, 'requests', this.requestId, 'calleeCandidates'),
          async (snapshot) => {
            if (this.isDestroyed || !this.pc) return;
            for (const change of snapshot.docChanges()) {
              if (change.type === 'added') {
                const candData = change.doc.data();
                if (candData.candidate) {
                  const candidateInit: RTCIceCandidateInit = {
                    candidate: candData.candidate,
                    sdpMid: candData.sdpMid,
                    sdpMLineIndex: candData.sdpMLineIndex,
                  };
                  if (this.isRemoteDescriptionSet && this.pc) {
                    await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit)).catch(console.warn);
                  } else {
                    this.queuedCandidates.push(candidateInit);
                  }
                }
              }
            }
          }
        );
        this.firestoreUnsubs.push(calleeCandidatesUnsub);
      }

      // REST broker fallback if configured
      if (this.backendUrl) {
        this.sendSignalingMessage('offer', {
          sdp: offer.sdp,
          type: offer.type,
        }).catch(() => {});
        this.listenToSignalingSSE();
      }
    } catch (err: any) {
      console.error('[WebRTC] Start error:', err);
      this.onErrorCb?.(err);
    }
  }

  private setupDataChannel(channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      if (this.isDestroyed) {
        try { channel.close(); } catch {}
        return;
      }
      console.log('[WebRTC] DataChannel OPENED!');
      this.startTime = Date.now();
      this.updateProgress(0, 'Direct P2P DataChannel open. Streaming chunks...');
    };

    channel.onmessage = async (event) => {
      if (this.isDestroyed || this.isCompleted) return;
      let data = event.data;

      // Handle Blob conversion if browser delivers as Blob
      if (data instanceof Blob) {
        try {
          data = await data.arrayBuffer();
        } catch {
          return;
        }
      }

      // Check if message is a JSON control signal (e.g. EOF or ERROR)
      if (typeof data === 'string') {
        try {
          const control = JSON.parse(data);
          if (control.type === 'EOF') {
            if (this.completionTimeout) {
              clearTimeout(this.completionTimeout);
              this.completionTimeout = null;
            }
            if (control.totalBytes && !this.totalSize) {
              this.totalSize = control.totalBytes;
            }
            await this.handleTransferCompletion(control.sha256);
            return;
          } else if (control.type === 'ERROR') {
            console.error('[WebRTC] Received remote error:', control.error);
            this.onErrorCb?.(new Error(control.error || 'Transfer failed on device'));
            return;
          }
        } catch {
          // Normal string payload
        }
      }

      if (data instanceof ArrayBuffer) {
        // Feed into streaming SHA-256 hasher on-the-fly
        this.streamingHasher.update(data);

        this.currentBatch.push(data);
        this.currentBatchBytes += data.byteLength;
        this.bytesReceived += data.byteLength;

        // Merge every 32MB into a native Blob to keep JS heap footprint near zero
        if (this.currentBatchBytes >= this.BATCH_SIZE_BYTES) {
          this.blobParts.push(new Blob(this.currentBatch));
          this.currentBatch = [];
          this.currentBatchBytes = 0;
        }

        const now = Date.now();
        if (now - this.lastProgressUpdate >= 150 || (this.totalSize > 0 && this.bytesReceived >= this.totalSize)) {
          this.lastProgressUpdate = now;
          const durationSec = Math.max(0.001, (now - this.startTime) / 1000);
          const speedMBps = (this.bytesReceived / (1024 * 1024)) / durationSec;
          const percent = this.totalSize > 0
            ? Math.min(100, Math.round((this.bytesReceived / this.totalSize) * 100))
            : 50;

          this.updateProgress(
            percent,
            `Streaming P2P: ${(this.bytesReceived / 1024 / 1024).toFixed(2)} MB (${speedMBps.toFixed(2)} MB/s)`,
            speedMBps
          );
        }

        // Auto EOF check if total size reached (with debounce and cancellation guard)
        if (this.totalSize > 0 && this.bytesReceived >= this.totalSize) {
          if (!this.completionTimeout) {
            this.completionTimeout = setTimeout(() => {
              this.completionTimeout = null;
              if (!this.isCompleted && !this.isDestroyed) {
                if (this.blobParts.length > 0 || this.currentBatch.length > 0) {
                  this.handleTransferCompletion();
                }
              }
            }, 300);
          }
        }
      }
    };

    channel.onerror = (err: any) => {
      console.warn('[WebRTC] DataChannel warning/error event:', err);
      if (channel.readyState === 'closed' || channel.readyState === 'closing') {
        let detail = 'DataChannel closed unexpectedly';
        try {
          if (err && typeof err.message === 'string') {
            detail = err.message;
          } else if (err && err.error && typeof err.error.message === 'string') {
            detail = err.error.message;
          }
        } catch {
          // Firefox Restricted XPCOM RTCError object
        }
        if (!this.isCompleted && !this.isDestroyed) {
          this.onErrorCb?.(new Error(`DataChannel closed: ${detail}`));
        }
      }
    };

    channel.onclose = () => {
      console.log('[WebRTC] DataChannel closed');
    };
  }

  private async handleTransferCompletion(reportedSha?: string) {
    if (this.isCompleted || this.isDestroyed) return;
    if (this.blobParts.length === 0 && this.currentBatch.length === 0) return;

    this.isCompleted = true;
    if (this.completionTimeout) {
      clearTimeout(this.completionTimeout);
      this.completionTimeout = null;
    }

    this.updateProgress(100, 'Verifying cryptographic SHA-256 integrity...');

    // Flush any remaining chunks into blobParts
    if (this.currentBatch.length > 0) {
      this.blobParts.push(new Blob(this.currentBatch));
      this.currentBatch = [];
      this.currentBatchBytes = 0;
    }

    const blob = new Blob(this.blobParts, { type: 'application/octet-stream' });
    this.blobParts = []; // Free memory

    // Finalize computed SHA-256 from the progressive streaming hasher
    let computedSha256 = this.streamingHasher.digest();

    console.log(`[WebRTC] Computed SHA-256: ${computedSha256}`);
    console.log(`[WebRTC] Expected SHA-256: ${this.expectedSha256}`);
    if (reportedSha) {
      console.log(`[WebRTC] Reported SHA-256: ${reportedSha}`);
    }

    // Cryptographic verification against expected checksum
    if (this.expectedSha256) {
      if (computedSha256 !== this.expectedSha256) {
        const err = new Error(`Integrity check failed! Expected ${this.expectedSha256}, got ${computedSha256}`);
        this.onErrorCb?.(err);
        return;
      }
    } else if (reportedSha && computedSha256 !== reportedSha.toLowerCase()) {
      const err = new Error(`Integrity check failed! Device reported ${reportedSha}, got ${computedSha256}`);
      this.onErrorCb?.(err);
      return;
    }

    // Trigger automatic browser download
    this.triggerDownload(blob, this.filename);

    // Update Firestore status to COMPLETED if in serverless mode
    if (this.vaultId && db) {
      try {
        await setDoc(doc(db, 'vaults', this.vaultId, 'requests', this.requestId), {
          status: 'COMPLETED',
          completedAt: Date.now(),
        }, { merge: true });
      } catch (e) {
        console.warn('Failed to update status to COMPLETED in Firestore', e);
      }
    }

    this.onCompleteCb?.(blob, computedSha256);
    this.close();
  }

  private triggerDownload(blob: Blob, filename: string) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'download';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try {
          if (document.body.contains(a)) {
            document.body.removeChild(a);
          }
          URL.revokeObjectURL(url);
        } catch {}
      }, 1500);
    } catch (e) {
      console.error('[WebRTC] Download trigger error:', e);
    }
  }

  private async sendSignalingMessage(type: string, payload: any) {
    if (!this.backendUrl) return;
    try {
      await fetch(`${this.backendUrl}/api/v1/signaling/${this.requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: 'client',
          type,
          payload,
        }),
      });
    } catch (e) {
      console.warn('[WebRTC] Signaling send error:', e);
    }
  }

  private listenToSignalingSSE() {
    if (!this.backendUrl) return;
    const sseUrl = `${this.backendUrl}/api/v1/signaling/${this.requestId}/events?peer=client`;
    this.sseSource = new EventSource(sseUrl);

    this.sseSource.onmessage = async (event) => {
      if (this.isDestroyed || !this.pc) return;

      try {
        const msg = JSON.parse(event.data);
        if (msg.sender !== 'device') return;

        if (msg.type === 'answer' && !this.isRemoteDescriptionSet) {
          console.log('[WebRTC] Received remote answer from device via SSE');
          const remoteDesc = new RTCSessionDescription(msg.payload);
          await this.pc.setRemoteDescription(remoteDesc);
          this.isRemoteDescriptionSet = true;
          this.updateProgress(15, 'Received peer answer. Establishing P2P hole punch...');

          while (this.queuedCandidates.length > 0) {
            const c = this.queuedCandidates.shift();
            if (c && this.pc) {
              await this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn);
            }
          }
        } else if (msg.type === 'candidate') {
          if (this.isRemoteDescriptionSet && this.pc) {
            await this.pc.addIceCandidate(new RTCIceCandidate(msg.payload)).catch(console.warn);
          } else {
            this.queuedCandidates.push(msg.payload);
          }
        }
      } catch (err) {
        console.error('[WebRTC] Error processing signaling message:', err);
      }
    };

    this.sseSource.onerror = () => {};
  }

  private updateProgress(percent: number, statusText: string, speedMBps = 0) {
    this.onProgressCb?.({
      bytesReceived: this.bytesReceived,
      totalBytes: this.totalSize,
      progressPercent: percent,
      speedMBps,
      speedMbps: speedMBps * 8,
      statusText,
    });
  }

  public close(): void {
    this.isDestroyed = true;
    if (this.completionTimeout) {
      clearTimeout(this.completionTimeout);
      this.completionTimeout = null;
    }
    for (const unsub of this.firestoreUnsubs) {
      try { unsub(); } catch {}
    }
    this.firestoreUnsubs = [];
    if (this.sseSource) {
      this.sseSource.onmessage = null;
      this.sseSource.onerror = null;
      try { this.sseSource.close(); } catch {}
      this.sseSource = null;
    }
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onerror = null;
      this.dataChannel.onclose = null;
      try { this.dataChannel.close(); } catch {}
      this.dataChannel = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
    this.blobParts = [];
    this.currentBatch = [];
    this.currentBatchBytes = 0;
    this.queuedCandidates = [];
  }
}
