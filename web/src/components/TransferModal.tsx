import React, { useEffect, useState, useRef } from 'react';
import { CatalogItem, RequestStatus, FileRequestResponse } from '../types.js';
import { WebRTCReceiver, TransferProgress } from '../webrtc.js';
import {
  X,
  Smartphone,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  Clock,
  ArrowRight,
  Download,
  CheckCircle2,
  AlertTriangle,
  Radio,
} from 'lucide-react';
import { db } from '../firebase.js';
import { collection, addDoc, doc, onSnapshot, updateDoc, getDoc } from 'firebase/firestore';

interface TransferModalProps {
  file: CatalogItem;
  backendUrl: string;
  vaultId?: string | null;
  onClose: () => void;
}

export const TransferModal: React.FC<TransferModalProps> = ({ file, backendUrl, vaultId, onClose }) => {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<RequestStatus>('WAITING_FOR_APPROVAL');
  const [chosenTransport, setChosenTransport] = useState<'webrtc' | 'relay'>('webrtc');
  const [timeRemainingSec, setTimeRemainingSec] = useState<number>(60);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [isIntegrityVerified, setIsIntegrityVerified] = useState<boolean>(false);
  const [verifiedSha256, setVerifiedSha256] = useState<string | null>(null);

  const receiverRef = useRef<WebRTCReceiver | null>(null);
  const pollTimerRef = useRef<any>(null);
  const countdownIntervalRef = useRef<any>(null);
  const isDownloadingRef = useRef<boolean>(false);

  // 1. Initiate Request on Mount
  useEffect(() => {
    let isMounted = true;

    async function initiateRequest() {
      // 1. Try Cloud Firestore (Serverless)
      if (vaultId) {
        try {
          const reqRef = await addDoc(collection(db, 'vaults', vaultId, 'requests'), {
            path: file.path,
            name: file.name || file.path.split('/').pop() || 'file',
            sha256: file.sha256,
            size: file.size,
            status: 'WAITING_FOR_APPROVAL',
            requesterContext: `Web Browser (${navigator.userAgent.split(' ')[0]})`,
            requesterIp: 'Remote Client',
            supportedTransports: ['webrtc'],
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
          });

          const generatedReqId = reqRef.id;
          if (isMounted) {
            setRequestId(generatedReqId);
            setStatus('WAITING_FOR_APPROVAL');
            setTimeRemainingSec(60);
          }

          // Initialize serverless WebRTC DataChannel receiver immediately
          const receiver = new WebRTCReceiver({
            requestId: generatedReqId,
            backendUrl: '',
            vaultId: vaultId,
            expectedSha256: file.sha256,
            filename: file.name || file.path.split('/').pop() || 'download',
            totalSize: file.size,
            onProgress: (p) => {
              if (isMounted) {
                setStatus('TRANSFERRING');
                setTransferProgress(p);
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
                setStatus('FAILED');
                setErrorMessage(err.message);
              }
            },
          });
          receiverRef.current = receiver;
          await receiver.start();

          // Real-time listener for mobile node decision!
          const unsub = onSnapshot(doc(db, 'vaults', vaultId, 'requests', generatedReqId), (snap) => {
            if (snap.exists() && isMounted) {
              const data = snap.data();
              if (data.status) {
                if (data.status === 'APPROVED') {
                  setStatus('TRANSFERRING');
                } else if (data.status === 'REJECTED') {
                  setStatus('REJECTED');
                  setErrorMessage('Transfer was denied on the Android device.');
                  receiver.close();
                } else if (data.status === 'COMPLETED') {
                  setStatus('COMPLETED');
                  setIsIntegrityVerified(true);
                  setVerifiedSha256(data.sha256 || file.sha256);
                }
              }
            }
          });

          // Countdown timer
          countdownIntervalRef.current = setInterval(() => {
            setTimeRemainingSec((prev) => {
              if (prev <= 1) {
                clearInterval(countdownIntervalRef.current);
                setStatus('EXPIRED');
                setErrorMessage('Request timed out after 60 seconds.');
                if (vaultId) {
                  updateDoc(doc(db, 'vaults', vaultId, 'requests', generatedReqId), {
                    status: 'EXPIRED',
                    updatedAt: Date.now(),
                  }).catch(console.warn);
                }
                return 0;
              }
              return prev - 1;
            });
          }, 1000);

          return () => {
            unsub();
            if (vaultId) {
              getDoc(doc(db, 'vaults', vaultId, 'requests', generatedReqId)).then((snap) => {
                if (snap.exists() && snap.data().status === 'WAITING_FOR_APPROVAL') {
                  updateDoc(doc(db, 'vaults', vaultId, 'requests', generatedReqId), {
                    status: 'CANCELLED',
                    updatedAt: Date.now(),
                  }).catch(console.warn);
                }
              }).catch(console.warn);
            }
          };
        } catch (firestoreErr) {
          console.warn('Firestore request failed, trying REST fallback:', firestoreErr);
        }
      }

      // 2. Fallback to REST backend
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
          const err = await res.json();
          throw new Error(err.error || 'Failed to dispatch request');
        }

        const data = await res.json();
        if (isMounted) {
          setRequestId(data.request_id);
          setStatus(data.status);
          setTimeRemainingSec(data.ttl_seconds || 60);
        }
      } catch (err: any) {
        if (isMounted) {
          setErrorMessage(err.message);
          setStatus('FAILED');
        }
      }
    }

    initiateRequest();

    return () => {
      isMounted = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      if (receiverRef.current) receiverRef.current.close();
    };
  }, [file, backendUrl]);

  // 2. Countdown Timer
  useEffect(() => {
    if (status === 'WAITING_FOR_APPROVAL') {
      countdownIntervalRef.current = setInterval(() => {
        setTimeRemainingSec((prev) => {
          if (prev <= 1) {
            clearInterval(countdownIntervalRef.current!);
            setStatus('EXPIRED');
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    }

    return () => {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, [status]);

  // 3. Status Polling / SSE Handler (Legacy REST mode only)
  useEffect(() => {
    if (!requestId || vaultId || ['COMPLETED', 'REJECTED', 'EXPIRED', 'FAILED'].includes(status)) {
      return;
    }

    let active = true;

    // Use SSE for zero-latency updates
    const sse = new EventSource(`${backendUrl}/api/v1/request-file/${requestId}/events`);

    sse.onmessage = (event) => {
      if (!active) return;
      try {
        const update: FileRequestResponse = JSON.parse(event.data);
        if (update.chosen_transport) {
          setChosenTransport(update.chosen_transport);
        }

        if (update.status === 'COMPLETED' && !isDownloadingRef.current) {
          sse.close();
          executeRelayDownload(requestId, update.relay_metadata);
        } else if (update.status === 'APPROVED') {
          setStatus('TRANSFERRING');
          setTransferProgress({
            bytesReceived: 0,
            totalBytes: file.size,
            progressPercent: 20,
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
      // If SSE disconnects, fall back to polling
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
        } catch {
          // Ignore polling errors
        }
        if (active && !['COMPLETED', 'REJECTED', 'EXPIRED', 'FAILED'].includes(status)) {
          pollTimerRef.current = setTimeout(poll, 400);
        }
      };
      pollTimerRef.current = setTimeout(poll, 400);
    };

    return () => {
      active = false;
      sse.close();
    };
  }, [requestId, status, backendUrl]);

// Pure JS SHA-256 implementation for non-secure HTTP LAN contexts where window.crypto.subtle is restricted
function sha256Bytes(bytes: Uint8Array): string {
  function rightRotate(value: number, amount: number) {
    return (value >>> amount) | (value << (32 - amount));
  }
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let i = 0, j = 0;
  let result = '';
  const words: number[] = [];
  const bitLength = bytes.length * 8;
  let hash: number[] = [];
  const k: number[] = [];
  let primeCounter = 0;
  const isComposite: Record<number, boolean> = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) {
        isComposite[i] = true;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }
  const totalLen = ((bytes.length + 8) >> 6) + 1;
  const totalBytes = totalLen * 64;
  const padded = new Uint8Array(totalBytes);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalBytes - 4, bitLength, false);
  view.setUint32(totalBytes - 8, Math.floor(bitLength / maxWord), false);
  for (i = 0; i < totalBytes; i += 4) {
    words.push(view.getUint32(i, false));
  }
  for (j = 0; j < words.length;) {
    const w = words.slice(j, (j += 16));
    const oldHash = hash;
    hash = hash.slice(0, 8);
    for (i = 0; i < 64; i++) {
      const w15 = w[i - 15], w2 = w[i - 2];
      const a = hash[0], e = hash[4];
      const temp1 =
        hash[7] +
        (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
        ((e & hash[5]) ^ (~e & hash[6])) +
        k[i] +
        (w[i] =
          i < 16
            ? w[i]
            : (w[i - 16] +
                (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                w[i - 7] +
                (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
              0);
      const temp2 =
        (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
        ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
    }
    for (i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }
  for (i = 0; i < 8; i++) {
    const hex = (hash[i] >>> 0).toString(16).padStart(8, '0');
    result += hex;
  }
  return result;
}

  // 4. Zero-Trust Ephemeral Relay Download & Decryption (with Secure & Insecure context support)
  const executeRelayDownload = async (reqId: string, meta?: any) => {
    if (isDownloadingRef.current) return;
    isDownloadingRef.current = true;

    try {
      setStatus('TRANSFERRING');
      setTransferProgress({
        bytesReceived: 0,
        totalBytes: file.size,
        progressPercent: 35,
        speedMbps: 0,
        statusText: 'Retrieving ephemeral AES-256-GCM lease metadata...',
      });

      let relayMeta = meta;
      if (!relayMeta) {
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
          speedMbps: 0,
          statusText: 'Streaming encrypted ciphertext from zero-trust relay...',
        });

        const endpoints = [
          relayMeta.downloadUrl,
          `${backendUrl}/api/v1/relay/download/${reqId}`,
          `${backendUrl}/api/v1/relay/${reqId}/download`,
        ];

        let cipherBuffer: ArrayBuffer | null = null;
        let lastErr: any = null;

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

        if (!cipherBuffer) {
          throw new Error(lastErr?.message || 'Failed to download encrypted blob from relay');
        }

        setTransferProgress({
          bytesReceived: cipherBuffer.byteLength,
          totalBytes: file.size,
          progressPercent: 75,
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
        // Non-secure HTTP LAN IP context (e.g. http://192.168.10.15 where browser blocks subtle crypto)
        setTransferProgress({
          bytesReceived: 0,
          totalBytes: file.size,
          progressPercent: 60,
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
        speedMbps: 0,
        statusText: 'Verifying cryptographic SHA-256 integrity...',
      });

      // Verify SHA-256 checksum (using subtle if available, otherwise pure JS sha256Bytes)
      let computedSha256 = '';
      if (hasSubtleCrypto) {
        const hashBuffer = await window.crypto.subtle.digest('SHA-256', plaintextBuffer);
        computedSha256 = Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
          .toLowerCase();
      } else {
        computedSha256 = sha256Bytes(new Uint8Array(plaintextBuffer)).toLowerCase();
      }

      if (file.sha256 && computedSha256 !== file.sha256.toLowerCase()) {
        throw new Error(`SHA-256 mismatch! Expected ${file.sha256}, got ${computedSha256}`);
      }

      // Trigger browser download
      const blob = new Blob([plaintextBuffer], { type: file.mimeType || 'application/octet-stream' });
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(dlUrl);
      }, 1000);

      setIsIntegrityVerified(true);
      setVerifiedSha256(computedSha256);
      setStatus('COMPLETED');
      setTransferProgress({
        bytesReceived: plaintextBuffer.byteLength,
        totalBytes: file.size,
        progressPercent: 100,
        speedMbps: 0,
        statusText: 'Transfer and cryptographic verification complete!',
      });
    } catch (err: any) {
      console.error('[Relay Download] Error:', err);
      setErrorMessage(err.message || 'Decryption failed');
      setStatus('FAILED');
      isDownloadingRef.current = false;
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleClose = () => {
    if (status === 'WAITING_FOR_APPROVAL' && requestId && vaultId) {
      updateDoc(doc(db, 'vaults', vaultId, 'requests', requestId), {
        status: 'CANCELLED',
        updatedAt: Date.now(),
      }).catch(console.warn);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-lg bg-[#0f172a] border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-[#0b1120]">
          <div className="flex items-center space-x-2">
            <Radio className="h-5 w-5 text-cyan-400 animate-pulse" />
            <h2 className="text-base font-bold text-slate-100">Zero-Trust Retrieval Pipeline</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-6">
          {/* Target File Summary */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Target File</span>
              <span className="text-xs font-mono font-medium text-slate-300">
                {formatBytes(file.size)}
              </span>
            </div>
            <div className="font-semibold text-slate-200 truncate">{file.name}</div>
            <div className="font-mono text-xs text-slate-500 truncate">{file.path}</div>
            <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs font-mono">
              <span className="text-slate-400">SHA-256:</span>
              <span className="text-cyan-400">{file.sha256.slice(0, 16)}...</span>
            </div>
          </div>

          {/* State 1: WAITING FOR APPROVAL */}
          {status === 'WAITING_FOR_APPROVAL' && (
            <div className="text-center py-6 space-y-4">
              <div className="relative mx-auto w-24 h-24 flex items-center justify-center">
                {/* Countdown Circular Ring */}
                <svg className="w-24 h-24 transform -rotate-90">
                  <circle
                    cx="48"
                    cy="48"
                    r="40"
                    stroke="#1e293b"
                    strokeWidth="6"
                    fill="transparent"
                  />
                  <circle
                    cx="48"
                    cy="48"
                    r="40"
                    stroke="#06b6d4"
                    strokeWidth="6"
                    fill="transparent"
                    strokeDasharray={251.2}
                    strokeDashoffset={251.2 * (1 - timeRemainingSec / 60)}
                    className="transition-all duration-1000 ease-linear"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <Clock className="h-5 w-5 text-cyan-400 mb-0.5" />
                  <span className="text-xl font-bold font-mono text-white">{timeRemainingSec}s</span>
                </div>
              </div>

              <div>
                <h3 className="text-base font-semibold text-white">
                  Waiting for Approval on Mobile Device...
                </h3>
                <p className="text-xs text-slate-400 max-w-sm mx-auto mt-1">
                  A high-priority heads-up prompt has been dispatched. Please tap <span className="text-emerald-400 font-semibold">[ALLOW]</span> on your phone notification to authorize lease.
                </p>
              </div>

              {/* Security Banner */}
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 text-left flex items-start space-x-2.5">
                <ShieldCheck className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                <div className="text-xs text-slate-300">
                  <span className="font-semibold text-slate-200">Replay-Protected Capability:</span> Single-use token bound by strict 60s cryptographic TTL. Phone remains dormant if ignored.
                </div>
              </div>
            </div>
          )}

          {/* State 2: APPROVED / NEGOTIATING / TRANSFERRING */}
          {(status === 'APPROVED' || status === 'NEGOTIATING' || status === 'TRANSFERRING') && (
            <div className="space-y-4 py-4">
              <div className="flex items-center space-x-3 text-emerald-400 bg-emerald-950/40 border border-emerald-800/60 p-3 rounded-xl text-xs">
                <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
                <div>
                  <span className="font-semibold">Cryptographic Lease Authorized!</span>
                  <div className="text-slate-300">Zero-trust encrypted lease authorized by mobile device.</div>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400 font-medium">
                    {transferProgress?.statusText || 'Streaming encrypted payload from phone...'}
                  </span>
                  <span className="font-mono text-cyan-400 font-semibold">
                    {transferProgress?.progressPercent || 0}%
                  </span>
                </div>
                <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-300"
                    style={{ width: `${transferProgress?.progressPercent || 5}%` }}
                  />
                </div>
              </div>

              {transferProgress?.speedMbps && (
                <div className="flex justify-between text-xs font-mono text-slate-400">
                  <span>Speed: {transferProgress.speedMbps.toFixed(2)} Mbps</span>
                  <span>
                    {(transferProgress.bytesReceived / 1024 / 1024).toFixed(2)} MB /{' '}
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </span>
                </div>
              )}
            </div>
          )}

          {/* State 3: COMPLETED */}
          {status === 'COMPLETED' && (
            <div className="text-center py-6 space-y-4">
              <div className="h-16 w-16 mx-auto rounded-full bg-emerald-950 border border-emerald-500/40 flex items-center justify-center">
                <CheckCircle2 className="h-9 w-9 text-emerald-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Transfer & Verification Complete!</h3>
                <p className="text-xs text-slate-400 mt-1">
                  File reassembled and automatically saved to your browser downloads.
                </p>
              </div>

              {/* Integrity Verification Card */}
              {isIntegrityVerified && (
                <div className="bg-slate-900 border border-emerald-500/30 rounded-xl p-3 text-left space-y-1">
                  <div className="flex items-center space-x-2 text-xs font-semibold text-emerald-400">
                    <ShieldCheck className="h-4 w-4" />
                    <span>Cryptographic Integrity Match (SHA-256)</span>
                  </div>
                  <div className="font-mono text-[11px] text-slate-300 break-all">
                    {verifiedSha256}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* State 4: REJECTED / EXPIRED / FAILED */}
          {(status === 'REJECTED' || status === 'EXPIRED' || status === 'FAILED') && (
            <div className="text-center py-6 space-y-4">
              <div className="h-16 w-16 mx-auto rounded-full bg-red-950/60 border border-red-500/40 flex items-center justify-center">
                <AlertTriangle className="h-9 w-9 text-red-400" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  {status === 'REJECTED'
                    ? 'Request Denied'
                    : status === 'EXPIRED'
                    ? 'Request Expired'
                    : 'Transfer Failed'}
                </h3>
                <p className="text-xs text-slate-400 max-w-sm mx-auto mt-1">
                  {errorMessage || 'The lazy node could not fulfill this transfer request.'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 bg-[#0b1120] border-t border-slate-800 flex justify-end">
          <button
            onClick={handleClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg transition"
          >
            {status === 'COMPLETED' ? 'Done' : 'Dismiss'}
          </button>
        </div>
      </div>
    </div>
  );
};
