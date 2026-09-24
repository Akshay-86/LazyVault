/**
 * WebRTC DataChannel Receiver Pipeline for LazyVault Web Client
 * 100% Serverless via Cloud Firestore Signaling (with REST fallback)
 * Connects to mobile node, reassembles streamed binary chunks, computes SHA-256,
 * and triggers automatic browser download.
 */

import { db } from './firebase.js';
import { doc, collection, addDoc, setDoc, onSnapshot, Unsubscribe } from 'firebase/firestore';

export interface TransferProgress {
  bytesReceived: number;
  totalBytes: number;
  progressPercent: number;
  speedMbps: number;
  statusText: string;
}

export class WebRTCReceiver {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private requestId: string;
  private backendUrl: string;
  private vaultId?: string;
  private expectedSha256: string;
  private filename: string;
  private totalSize: number;
  private receivedChunks: ArrayBuffer[] = [];
  private bytesReceived = 0;
  private startTime = 0;
  private sseSource: EventSource | null = null;
  private firestoreUnsubs: Unsubscribe[] = [];
  private isDestroyed = false;
  private isRemoteDescriptionSet = false;
  private queuedCandidates: RTCIceCandidateInit[] = [];

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
    this.expectedSha256 = params.expectedSha256.toLowerCase();
    this.filename = params.filename;
    this.totalSize = params.totalSize;
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
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      };

      this.pc = new RTCPeerConnection(config);

      // Listen for ICE candidates and send to phone via Firestore
      this.pc.onicecandidate = async (event) => {
        if (event.candidate) {
          const cand = event.candidate;
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
            this.sendSignalingMessage('candidate', cand.toJSON()).catch(() => {});
          }
        }
      };

      this.pc.onconnectionstatechange = () => {
        if (this.pc) {
          console.log(`[WebRTC] Connection state: ${this.pc.connectionState}`);
          if (this.pc.connectionState === 'connected') {
            this.updateProgress(25, 'Direct P2P DataChannel connection established!');
          } else if (this.pc.connectionState === 'failed') {
            this.onErrorCb?.(new Error('WebRTC direct P2P connection failed. Check device network.'));
          }
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
          supportedTransports: ['webrtc'],
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

                // Drain queued ICE candidates
                for (const c of this.queuedCandidates) {
                  await this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn);
                }
                this.queuedCandidates = [];
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
                  if (this.isRemoteDescriptionSet) {
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
      console.log('[WebRTC] DataChannel OPENED!');
      this.startTime = Date.now();
      this.updateProgress(0, 'Direct P2P DataChannel open. Streaming chunks...');
    };

    channel.onmessage = async (event) => {
      const data = event.data;

      // Check if message is a JSON control signal (e.g. EOF)
      if (typeof data === 'string') {
        try {
          const control = JSON.parse(data);
          if (control.type === 'EOF') {
            await this.handleTransferCompletion(control.sha256);
          }
          return;
        } catch {
          // Normal string payload
        }
      }

      if (data instanceof ArrayBuffer) {
        this.receivedChunks.push(data);
        this.bytesReceived += data.byteLength;

        const durationSec = Math.max(0.001, (Date.now() - this.startTime) / 1000);
        const speedMbps = ((this.bytesReceived * 8) / (1024 * 1024)) / durationSec;
        const percent = this.totalSize > 0
          ? Math.min(100, Math.round((this.bytesReceived / this.totalSize) * 100))
          : 50;

        this.updateProgress(
          percent,
          `Streaming P2P: ${(this.bytesReceived / 1024 / 1024).toFixed(2)} MB (${speedMbps.toFixed(2)} Mbps)`,
          speedMbps
        );

        // Auto EOF check if total size reached
        if (this.totalSize > 0 && this.bytesReceived >= this.totalSize) {
          setTimeout(() => {
            if (this.receivedChunks.length > 0) {
              this.handleTransferCompletion();
            }
          }, 300);
        }
      }
    };

    channel.onerror = (err) => {
      console.error('[WebRTC] DataChannel error:', err);
      this.onErrorCb?.(new Error('DataChannel error encountered'));
    };

    channel.onclose = () => {
      console.log('[WebRTC] DataChannel closed');
    };
  }

  private async handleTransferCompletion(reportedSha?: string) {
    if (this.receivedChunks.length === 0) return;

    this.updateProgress(100, 'Verifying cryptographic SHA-256 integrity...');

    const blob = new Blob(this.receivedChunks, { type: 'application/octet-stream' });
    this.receivedChunks = []; // Free memory

    // Compute SHA-256 via Web Crypto API (with fallback if insecure context)
    let computedSha256 = '';
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      const arrayBuffer = await blob.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      computedSha256 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toLowerCase();
    } else if (reportedSha) {
      computedSha256 = reportedSha.toLowerCase();
    }

    console.log(`[WebRTC] Computed SHA-256: ${computedSha256}`);
    console.log(`[WebRTC] Expected SHA-256: ${this.expectedSha256}`);

    if (computedSha256 && this.expectedSha256 && computedSha256 !== this.expectedSha256) {
      const err = new Error(`Integrity check failed! Expected ${this.expectedSha256}, got ${computedSha256}`);
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  private async sendSignalingMessage(type: string, payload: any) {
    if (!this.backendUrl) return;
    await fetch(`${this.backendUrl}/api/v1/signaling/${this.requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'client',
        type,
        payload,
      }),
    });
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

          for (const c of this.queuedCandidates) {
            await this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.warn);
          }
          this.queuedCandidates = [];
        } else if (msg.type === 'candidate') {
          if (this.isRemoteDescriptionSet) {
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

  private updateProgress(percent: number, statusText: string, speedMbps = 0) {
    this.onProgressCb?.({
      bytesReceived: this.bytesReceived,
      totalBytes: this.totalSize,
      progressPercent: percent,
      speedMbps,
      statusText,
    });
  }

  public close(): void {
    this.isDestroyed = true;
    for (const unsub of this.firestoreUnsubs) {
      try { unsub(); } catch {}
    }
    this.firestoreUnsubs = [];
    if (this.sseSource) {
      this.sseSource.close();
      this.sseSource = null;
    }
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }
}
