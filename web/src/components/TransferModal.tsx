import React, { useEffect, useState, useRef, useCallback } from 'react';
import { CatalogItem, RequestStatus, FileRequestResponse, TransferProgress } from '../types.js';
import { WebRTCReceiver } from '../webrtc.js';
import { computeSha256 } from '../utils/crypto.js';
import {
  X,
  Smartphone,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { db } from '../firebase.js';
import { collection, addDoc, doc, onSnapshot, updateDoc, getDoc, deleteDoc, Unsubscribe } from 'firebase/firestore';

interface TransferModalProps {
  file: CatalogItem;
  backendUrl: string;
  vaultId?: string | null;
  onClose: () => void;
}

export const TransferModal: React.FC<TransferModalProps> = ({ file, backendUrl, vaultId, onClose }) => {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<RequestStatus>('WAITING_FOR_APPROVAL');
  const [timeRemainingSec, setTimeRemainingSec] = useState<number>(60);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [isIntegrityVerified, setIsIntegrityVerified] = useState<boolean>(false);
  const [verifiedSha256, setVerifiedSha256] = useState<string | null>(null);

  const receiverRef = useRef<WebRTCReceiver | null>(null);
  const expiresAtRef = useRef<number | null>(null);
  const initialTtlRef = useRef<number>(60);
  const pollTimerRef = useRef<any>(null);
  const countdownIntervalRef = useRef<any>(null);
  const isDownloadingRef = useRef<boolean>(false);
  const firestoreUnsubRef = useRef<Unsubscribe | null>(null);

  const handleClose = useCallback(() => {
    if (status === 'WAITING_FOR_APPROVAL' && requestId && vaultId && db) {
      updateDoc(doc(db, 'vaults', vaultId, 'requests', requestId), {
        status: 'CANCELLED',
        updatedAt: Date.now(),
      }).catch(console.warn);
    }
    if (receiverRef.current) {
      receiverRef.current.close();
      receiverRef.current = null;
    }
    onClose();
  }, [status, requestId, vaultId, onClose]);

  // Keyboard accessibility: Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  // Zero-Trust Ephemeral Relay Download & Decryption
  const executeRelayDownload = useCallback(async (reqId: string, meta?: any) => {
    if (isDownloadingRef.current) return;
    isDownloadingRef.current = true;

    try {
      setStatus('TRANSFERRING');
      setTransferProgress({
        bytesReceived: 0,
        totalBytes: file.size,
        progressPercent: 35,
        speedMBps: 0,
        speedMbps: 0,
        statusText: 'Retrieving ephemeral AES-256-GCM lease metadata...',
      });

      let relayMeta = meta;
      if (!relayMeta && backendUrl) {
        const res = await fetch(`${backendUrl}/api/v1/request-file/${reqId}`);
        if (res.ok) {
          const data = await res.json();
          relayMeta = data.relay_metadata || data.relayMetadata;
        }
      }

      if (!relayMeta || !relayMeta.encryptionKeyB64 || !relayMeta.ivB64) {
        throw new Error('Encrypted relay metadata incomplete or not ready.');
      }

      const hasSubtleCrypto = typeof window !== 'undefined' && !!(window.crypto && window.crypto.subtle);
      let plaintextBuffer: ArrayBuffer;

      if (hasSubtleCrypto) {
        // Secure context (HTTPS or localhost): decrypt directly in browser memory via Web Crypto
        setTransferProgress({
          bytesReceived: 0,
          totalBytes: file.size,
          progressPercent: 55,
          speedMBps: 0,
          speedMbps: 0,
          statusText: 'Streaming encrypted ciphertext from zero-trust relay...',
        });

        let cipherBuffer: ArrayBuffer | null = null;
        let lastErr: any = null;

        // 1. Download Serverless Encrypted Chunks from Firestore (Zero-Trust, Serverless)
        if (relayMeta.chunkCount && vaultId && db) {
          setTransferProgress({
            bytesReceived: 0,
            totalBytes: file.size,
            progressPercent: 50,
            speedMBps: 0,
            speedMbps: 0,
            statusText: `Downloading ${relayMeta.chunkCount} encrypted chunks from cloud relay...`,
          });
          try {
            const chunkPromises = [];
            for (let i = 0; i < relayMeta.chunkCount; i++) {
              chunkPromises.push(getDoc(doc(db, 'vaults', vaultId, 'requests', reqId, 'chunks', `${i}`)));
            }
            const chunkDocs = await Promise.all(chunkPromises);
            const byteArrays: Uint8Array[] = [];
            let totalLen = 0;
            for (const cDoc of chunkDocs) {
              if (!cDoc.exists()) throw new Error(`Missing chunk document ${cDoc.id} in Firestore`);
              const b64 = cDoc.data()?.data;
              if (!b64) throw new Error(`Empty chunk payload in document ${cDoc.id}`);
              const binaryStr = atob(b64);
              const len = binaryStr.length;
              const u8 = new Uint8Array(len);
              for (let k = 0; k < len; k++) {
                u8[k] = binaryStr.charCodeAt(k);
              }
              byteArrays.push(u8);
              totalLen += len;
            }
            const combined = new Uint8Array(totalLen);
            let offset = 0;
            for (const ba of byteArrays) {
              combined.set(ba, offset);
              offset += ba.length;
            }
            cipherBuffer = combined.buffer;

            // Zero-Trust cleanup: asynchronously delete chunks from Firestore
            setTimeout(() => {
              for (let i = 0; i < relayMeta.chunkCount; i++) {
                deleteDoc(doc(db, 'vaults', vaultId, 'requests', reqId, 'chunks', `${i}`)).catch(() => {});
              }
            }, 5000);
          } catch (chunkErr: any) {
            console.warn('[TransferModal] Firestore chunk download error:', chunkErr);
            lastErr = chunkErr;
          }
        }

        // 2. Fall back to REST relay endpoints if cipherBuffer not yet retrieved
        if (!cipherBuffer && backendUrl) {
          const endpoints = [
            relayMeta.downloadUrl,
            `${backendUrl}/api/v1/relay/download/${reqId}`,
            `${backendUrl}/api/v1/relay/${reqId}/download`,
          ].filter(Boolean) as string[];

          for (const ep of endpoints) {
            try {
              const resp = await fetch(ep);
              if (resp.ok) {
                cipherBuffer = await resp.arrayBuffer();
                break;
              }
            } catch (e) {
              lastErr = e;
            }
          }
        }

        if (!cipherBuffer) {
          throw new Error(lastErr?.message || 'Failed to download encrypted blob from relay');
        }

        setTransferProgress({
          bytesReceived: cipherBuffer.byteLength,
          totalBytes: file.size,
          progressPercent: 75,
          speedMBps: 0,
          speedMbps: 0,
          statusText: 'Decrypting ciphertext with ephemeral single-use AES-256-GCM key...',
        });

        const keyBytes = Uint8Array.from(atob(relayMeta.encryptionKeyB64), (c) => c.charCodeAt(0));
        const ivBytes = Uint8Array.from(atob(relayMeta.ivB64), (c) => c.charCodeAt(0));

        const cryptoKey = await window.crypto.subtle.importKey(
          'raw',
          keyBytes,
          { name: 'AES-GCM' },
          false,
          ['decrypt']
        );

        try {
          plaintextBuffer = await window.crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: ivBytes,
              tagLength: 128,
            },
            cryptoKey,
            cipherBuffer
          );
        } catch (decErr: any) {
          throw new Error('AES-256-GCM tag verification or decryption failed: ' + decErr.message);
        }
      } else {
        // Non-secure HTTP LAN IP context where Web Crypto is blocked by browser security
        if (!backendUrl) {
          throw new Error('Relay decryption requires a secure context (HTTPS/localhost) or a configured backend relay.');
        }

        setTransferProgress({
          bytesReceived: 0,
          totalBytes: file.size,
          progressPercent: 60,
          speedMBps: 0,
          speedMbps: 0,
          statusText: 'Streaming payload via ephemeral single-use lease decryptor...',
        });

        const decryptedEndpoints = [
          `${backendUrl}/api/v1/relay/download-decrypted/${reqId}`,
          `${backendUrl}/api/v1/relay/${reqId}/download-decrypted`,
        ];

        let fetchedBuffer: ArrayBuffer | null = null;
        let lastErr: any = null;

        for (const ep of decryptedEndpoints) {
          try {
            const resp = await fetch(ep);
            if (resp.ok) {
              fetchedBuffer = await resp.arrayBuffer();
              break;
            }
          } catch (e) {
            lastErr = e;
          }
        }

        if (!fetchedBuffer) {
          throw new Error(lastErr?.message || 'Failed to retrieve decrypted stream from relay');
        }

        plaintextBuffer = fetchedBuffer;
      }

      setTransferProgress({
        bytesReceived: plaintextBuffer.byteLength,
        totalBytes: file.size,
        progressPercent: 95,
        speedMBps: 0,
        speedMbps: 0,
        statusText: 'Verifying cryptographic SHA-256 integrity...',
      });

      // Verify SHA-256 checksum
      const computedSha256 = await computeSha256(plaintextBuffer);

      if (file.sha256 && computedSha256 !== file.sha256.toLowerCase()) {
        throw new Error(`SHA-256 mismatch! Expected ${file.sha256}, got ${computedSha256}`);
      }

      // Trigger browser download
      const filename = file.name || file.path.split(/[/\\]/).pop() || 'download';
      const blob = new Blob([plaintextBuffer], { type: file.mimeType || 'application/octet-stream' });
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try {
          if (document.body.contains(a)) document.body.removeChild(a);
          URL.revokeObjectURL(dlUrl);
        } catch {}
      }, 1500);

      setIsIntegrityVerified(true);
      setVerifiedSha256(computedSha256);
      setStatus('COMPLETED');
      setTransferProgress({
        bytesReceived: plaintextBuffer.byteLength,
        totalBytes: file.size,
        progressPercent: 100,
        speedMBps: 0,
        speedMbps: 0,
        statusText: 'Transfer and cryptographic verification complete!',
      });
    } catch (err: any) {
      console.error('[Relay Download] Error:', err);
      setErrorMessage(err.message || 'Decryption failed');
      setStatus('FAILED');
      isDownloadingRef.current = false;
    }
  }, [backendUrl, file.mimeType, file.name, file.path, file.sha256, file.size, vaultId]);

  // 1. Initiate Request on Mount
  useEffect(() => {
    let isMounted = true;

    async function initiateRequest() {
      // 1. Try Cloud Firestore (Serverless)
      if (vaultId && db) {
        try {
          const targetExpiresAt = Date.now() + 60000;
          expiresAtRef.current = targetExpiresAt;
          initialTtlRef.current = 60;

          const reqRef = await addDoc(collection(db, 'vaults', vaultId, 'requests'), {
            path: file.path,
            name: file.name || file.path.split(/[/\\]/).pop() || 'file',
            sha256: file.sha256,
            size: file.size,
            status: 'WAITING_FOR_APPROVAL',
            requesterContext: `Web Browser (${navigator.userAgent.split(' ')[0]})`,
            requesterIp: 'Remote Client',
            supportedTransports: ['webrtc', 'relay'],
            createdAt: Date.now(),
            expiresAt: targetExpiresAt,
          });

          const generatedReqId = reqRef.id;
          if (!isMounted) return;

          setRequestId(generatedReqId);
          setStatus('WAITING_FOR_APPROVAL');
          setTimeRemainingSec(Math.max(0, Math.ceil((targetExpiresAt - Date.now()) / 1000)));

          // Initialize serverless WebRTC DataChannel receiver immediately
          const receiver = new WebRTCReceiver({
            requestId: generatedReqId,
            backendUrl: '',
            vaultId: vaultId,
            expectedSha256: file.sha256,
            filename: file.name || file.path.split(/[/\\]/).pop() || 'download',
            totalSize: file.size,
            onProgress: (p) => {
              if (isMounted) {
                setTransferProgress(p);
                setStatus((prev) => {
                  if (prev === 'WAITING_FOR_APPROVAL') {
                    return p.bytesReceived > 0 ? 'TRANSFERRING' : 'WAITING_FOR_APPROVAL';
                  }
                  if (['COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'].includes(prev)) {
                    return prev;
                  }
                  return 'TRANSFERRING';
                });
              }
            },
            onComplete: (_blob, sha) => {
              if (isMounted) {
                setStatus('COMPLETED');
                setIsIntegrityVerified(true);
                setVerifiedSha256(sha);
              }
            },
            onError: (err) => {
              if (isMounted) {
                console.warn('[TransferModal] WebRTC error, holding for relay fallback:', err.message);
                const isLarge = file.size > 50 * 1024 * 1024;
                setTransferProgress((prev) => ({
                  bytesReceived: prev?.bytesReceived || 0,
                  totalBytes: file.size,
                  progressPercent: 25,
                  speedMBps: 0,
                  speedMbps: 0,
                  statusText: isLarge
                    ? 'Direct P2P blocked by carrier NAT. File > 50 MB cannot use cloud relay (connect phone to Wi-Fi).'
                    : 'Direct P2P blocked by carrier NAT. Waiting for encrypted relay fallback...',
                }));
              }
            },
          });
          receiverRef.current = receiver;
          await receiver.start();

          // Real-time listener for mobile node decision
          const unsub = onSnapshot(doc(db, 'vaults', vaultId, 'requests', generatedReqId), (snap) => {
            if (snap.exists() && isMounted) {
              const data = snap.data();
              if (data.expiresAt) {
                expiresAtRef.current = data.expiresAt;
              }
              if (data.status) {
                setStatus((currentStatus) => {
                  if (['EXPIRED', 'CANCELLED', 'FAILED', 'COMPLETED'].includes(currentStatus)) {
                    if (receiverRef.current) {
                      receiverRef.current.close();
                    }
                    return currentStatus;
                  }

                  if (data.status === 'APPROVED') {
                    if (expiresAtRef.current && Date.now() >= expiresAtRef.current) {
                      setErrorMessage('Transfer request expired (60s limit reached before approval).');
                      if (receiverRef.current) receiverRef.current.close();
                      return 'EXPIRED';
                    }

                    setTransferProgress((prev) => prev || {
                      bytesReceived: 0,
                      totalBytes: file.size,
                      progressPercent: 5,
                      speedMBps: 0,
                      speedMbps: 0,
                      statusText: 'Transfer approved on phone! Establishing direct P2P stream...',
                    });
                    return 'TRANSFERRING';
                  } else if (data.status === 'REJECTED') {
                    setErrorMessage('Transfer was denied on the Android device.');
                    if (receiverRef.current) receiverRef.current.close();
                    return 'REJECTED';
                  } else if (data.status === 'COMPLETED') {
                    const relayMeta = data.relayMetadata || data.relay_metadata;
                    if ((data.chosenTransport === 'relay' || relayMeta) && !isDownloadingRef.current) {
                      executeRelayDownload(generatedReqId, relayMeta);
                    } else if (!isDownloadingRef.current) {
                      setIsIntegrityVerified(true);
                      setVerifiedSha256(data.sha256 || file.sha256);
                    }
                    return 'COMPLETED';
                  } else if (data.status === 'EXPIRED') {
                    setErrorMessage('Transfer request expired (60s limit reached before approval).');
                    if (receiverRef.current) receiverRef.current.close();
                    return 'EXPIRED';
                  } else if (data.status === 'FAILED') {
                    setErrorMessage(data.error || 'Transfer failed on device.');
                    if (receiverRef.current) receiverRef.current.close();
                    return 'FAILED';
                  }
                  return currentStatus;
                });
              }
            }
          });
          firestoreUnsubRef.current = unsub;
          return;
        } catch (firestoreErr) {
          console.warn('Firestore request failed, trying REST fallback:', firestoreErr);
        }
      }

      // 2. Fallback to REST backend
      if (backendUrl) {
        try {
          const res = await fetch(`${backendUrl}/api/v1/request-file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              target_sha256: file.sha256,
              path: file.path,
              requester_context: `Web Browser (${navigator.userAgent.split(' ')[0]})`,
              supported_transports: ['relay'],
              vault_id: vaultId,
            }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Failed to dispatch request');
          }

          const data = await res.json();
          if (isMounted) {
            const ttl = data.ttl_seconds || 60;
            initialTtlRef.current = ttl;
            expiresAtRef.current = Date.now() + ttl * 1000;
            setRequestId(data.request_id);
            setStatus(data.status);
            setTimeRemainingSec(ttl);
          }
        } catch (err: any) {
          if (isMounted) {
            setErrorMessage(err.message);
            setStatus('FAILED');
          }
        }
      } else {
        if (isMounted) {
          setErrorMessage('Unable to dispatch request: neither Firestore nor backend URL configured.');
          setStatus('FAILED');
        }
      }
    }

    initiateRequest();

    return () => {
      isMounted = false;
      if (firestoreUnsubRef.current) {
        firestoreUnsubRef.current();
        firestoreUnsubRef.current = null;
      }
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      if (receiverRef.current) {
        receiverRef.current.close();
        receiverRef.current = null;
      }
    };
  }, [file, backendUrl, vaultId, executeRelayDownload]);

  // 2. Authoritative Countdown Timer Synced with expiresAt
  useEffect(() => {
    if (status !== 'WAITING_FOR_APPROVAL') {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      return;
    }

    const checkExpiration = () => {
      if (!expiresAtRef.current) return;
      const now = Date.now();
      const remaining = Math.max(0, Math.ceil((expiresAtRef.current - now) / 1000));
      setTimeRemainingSec(remaining);

      if (remaining <= 0) {
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
        setStatus('EXPIRED');
        setErrorMessage('Transfer request timed out after 60 seconds.');
        if (receiverRef.current) {
          receiverRef.current.close();
          receiverRef.current = null;
        }
        if (vaultId && requestId && db) {
          updateDoc(doc(db, 'vaults', vaultId, 'requests', requestId), {
            status: 'EXPIRED',
            updatedAt: Date.now(),
          }).catch(console.warn);
        }
      }
    };

    checkExpiration();
    countdownIntervalRef.current = setInterval(checkExpiration, 500);

    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, [status, vaultId, requestId]);

  // 3. Status Polling / SSE Handler (REST mode only)
  useEffect(() => {
    if (!requestId || vaultId || !backendUrl || ['COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'].includes(status)) {
      return;
    }

    let active = true;
    const sse = new EventSource(`${backendUrl}/api/v1/request-file/${requestId}/events`);

    sse.onmessage = (event) => {
      if (!active) return;
      try {
        const update: FileRequestResponse = JSON.parse(event.data);

        if (update.status === 'COMPLETED' && !isDownloadingRef.current) {
          sse.close();
          executeRelayDownload(requestId, update.relay_metadata);
        } else if (update.status === 'APPROVED') {
          setStatus('TRANSFERRING');
          setTransferProgress({
            bytesReceived: 0,
            totalBytes: file.size,
            progressPercent: 20,
            speedMBps: 0,
            speedMbps: 0,
            statusText: 'Lease approved on phone! Encrypting and streaming payload...',
          });
        } else if (update.status === 'REJECTED') {
          setStatus('REJECTED');
          setErrorMessage('Transfer request was explicitly REJECTED on the Android device.');
          sse.close();
        } else if (update.status === 'EXPIRED') {
          setStatus('EXPIRED');
          setErrorMessage('Transfer request expired (60s TTL limit reached before approval).');
          sse.close();
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    sse.onerror = () => {
      sse.close();
      const poll = async () => {
        if (!active) return;
        try {
          const resp = await fetch(`${backendUrl}/api/v1/request-file/${requestId}`);
          if (resp.ok) {
            const data: FileRequestResponse = await resp.json();
            if (data.status === 'COMPLETED' && !isDownloadingRef.current) {
              executeRelayDownload(requestId, data.relay_metadata || (data as any).relayMetadata);
              return;
            } else if (data.status === 'APPROVED') {
              setStatus('TRANSFERRING');
            } else if (['REJECTED', 'EXPIRED', 'FAILED'].includes(data.status)) {
              setStatus(data.status);
              if (data.error) setErrorMessage(data.error);
              return;
            }
          }
        } catch {}
        if (active && !['COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'].includes(status)) {
          pollTimerRef.current = setTimeout(poll, 500);
        }
      };
      pollTimerRef.current = setTimeout(poll, 500);
    };

    return () => {
      active = false;
      sse.close();
    };
  }, [requestId, status, backendUrl, vaultId, file.size, executeRelayDownload]);

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes <= 0 || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const progressFraction = Math.max(0, Math.min(1, timeRemainingSec / (initialTtlRef.current || 60)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="w-full max-w-md bg-[#111726] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-[#0d131f]">
          <h2 className="text-sm font-semibold text-slate-100">File Download</h2>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-5">
          {/* Target File Summary */}
          <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Selected File</span>
              <span className="text-xs font-mono font-medium text-slate-300">
                {file.size > 0 ? formatBytes(file.size) : 'On-demand stream'}
              </span>
            </div>
            <div className="font-medium text-sm text-slate-100 truncate">{file.name}</div>
            <div className="font-mono text-[11px] text-slate-400 truncate">{file.path}</div>
          </div>

          {/* Large File Advisory */}
          {file.size >= 100 * 1024 * 1024 && (
            <div className="bg-amber-950/20 border border-amber-800/40 rounded-xl p-3 text-xs text-amber-300 flex items-start space-x-2.5">
              <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-medium text-amber-200">Large File Transfer ({formatBytes(file.size)})</span>
                <p className="text-amber-400/80 text-[11px] mt-0.5 leading-relaxed">
                  Large files stream directly peer-to-peer via WebRTC. For fastest speed and reliability across cellular networks, ensure the host phone is awake and connected to Wi-Fi.
                </p>
              </div>
            </div>
          )}

          {/* State 1: WAITING FOR APPROVAL */}
          {status === 'WAITING_FOR_APPROVAL' && (
            <div className="text-center py-5 space-y-4">
              <div className="relative mx-auto w-20 h-20 flex items-center justify-center">
                <svg className="w-20 h-20 transform -rotate-90">
                  <circle
                    cx="40"
                    cy="40"
                    r="34"
                    stroke="#1e293b"
                    strokeWidth="4"
                    fill="transparent"
                  />
                  <circle
                    cx="40"
                    cy="40"
                    r="34"
                    stroke="#3b82f6"
                    strokeWidth="4"
                    fill="transparent"
                    strokeDasharray={213.6}
                    strokeDashoffset={213.6 * (1 - progressFraction)}
                    className="transition-all duration-500 ease-linear"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-bold font-mono text-white">{timeRemainingSec}s</span>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-white">
                  Waiting for Device Approval
                </h3>
                <p className="text-xs text-slate-400 max-w-xs mx-auto mt-1 leading-relaxed">
                  A notification prompt was sent to your phone. Tap <span className="text-white font-medium">Allow</span> to start the transfer.
                </p>
              </div>

              <div className="bg-slate-900/60 border border-slate-800/80 rounded-lg p-2.5 text-xs text-slate-400 flex items-center justify-center space-x-2">
                <Smartphone className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                <span>Single-use direct transfer • Auto-cancels in 60s</span>
              </div>
            </div>
          )}

          {/* State 2: APPROVED / NEGOTIATING / TRANSFERRING */}
          {(status === 'APPROVED' || status === 'NEGOTIATING' || status === 'TRANSFERRING') && (
            <div className="space-y-4 py-3">
              <div className="flex items-center space-x-2.5 text-emerald-400 bg-emerald-950/30 border border-emerald-800/40 p-3 rounded-xl text-xs">
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                <span className="text-slate-200">Transfer approved. Streaming data...</span>
              </div>

              {/* Progress Bar */}
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400 font-medium truncate max-w-[220px]">
                    {transferProgress?.statusText || 'Downloading file...'}
                  </span>
                  <span className="font-mono text-blue-400 font-medium">
                    {transferProgress?.progressPercent || 0}%
                  </span>
                </div>
                <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all duration-300 rounded-full"
                    style={{ width: `${transferProgress?.progressPercent || 5}%` }}
                  />
                </div>
              </div>

              {transferProgress && (
                <div className="flex justify-between text-xs font-mono text-slate-400">
                  <span>
                    {transferProgress.speedMBps > 0
                      ? `${transferProgress.speedMBps.toFixed(1)} MB/s`
                      : 'P2P Stream'}
                  </span>
                  <span>
                    {formatBytes(transferProgress.bytesReceived)}
                    {(transferProgress.totalBytes > 0 || file.size > 0) &&
                      ` / ${formatBytes(transferProgress.totalBytes || file.size)}`}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* State 3: COMPLETED */}
          {status === 'COMPLETED' && (
            <div className="text-center py-5 space-y-4">
              <div className="h-12 w-12 mx-auto rounded-full bg-emerald-950/60 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-white">Download Complete</h3>
                <p className="text-xs text-slate-400 mt-1">
                  The file was saved to your downloads and verified bit-for-bit.
                </p>
              </div>

              {isIntegrityVerified && (
                <div className="bg-[#0d131f] border border-slate-800 rounded-lg p-2.5 text-left space-y-1">
                  <div className="flex items-center space-x-1.5 text-xs text-slate-300">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="font-medium">SHA-256 Verified:</span>
                  </div>
                  <div className="font-mono text-[11px] text-slate-400 break-all">
                    {verifiedSha256}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* State 4: REJECTED / EXPIRED / CANCELLED / FAILED */}
          {(status === 'REJECTED' || status === 'EXPIRED' || status === 'CANCELLED' || status === 'FAILED') && (
            <div className="text-center py-5 space-y-3">
              <div className="h-12 w-12 mx-auto rounded-full bg-red-950/60 border border-red-500/30 flex items-center justify-center text-red-400">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {status === 'REJECTED'
                    ? 'Transfer Declined'
                    : status === 'EXPIRED'
                    ? 'Request Expired'
                    : status === 'CANCELLED'
                    ? 'Transfer Cancelled'
                    : 'Transfer Failed'}
                </h3>
                <p className="text-xs text-slate-400 max-w-xs mx-auto mt-1 leading-relaxed">
                  {errorMessage ||
                    (status === 'REJECTED'
                      ? 'The transfer request was declined on the mobile device.'
                      : status === 'CANCELLED'
                      ? 'The transfer request was cancelled.'
                      : 'The transfer could not be completed.')}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 bg-[#0d131f] border-t border-slate-800 flex justify-end">
          <button
            onClick={handleClose}
            className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-200 text-xs font-medium rounded-lg transition"
          >
            {status === 'COMPLETED' ? 'Done' : 'Dismiss'}
          </button>
        </div>
      </div>
    </div>
  );
};
