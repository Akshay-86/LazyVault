import React, { useState, useEffect, useCallback } from 'react';
import { CatalogResponse, CatalogItem } from './types.js';
import { Header } from './components/Header.js';
import { CatalogTable } from './components/CatalogTable.js';
import { TransferModal } from './components/TransferModal.js';
import { ManualRequestForm } from './components/ManualRequestForm.js';
import { PasswordGate } from './components/PasswordGate.js';
import { Shield, Smartphone, ArrowRight, Zap, FolderLock, FolderX, Loader2, AlertCircle } from 'lucide-react';
import { db } from './firebase.js';
import { doc, getDoc, onSnapshot, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

function parseVaultIdFromLocation(): string | null {
  const path = window.location.pathname;
  if (path.startsWith('/v/')) {
    const id = path.replace('/v/', '').split('/')[0];
    if (id) return id;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get('v') || null;
}

function extractAndValidateVaultId(input: string): { vaultId: string | null; error: string | null } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { vaultId: null, error: 'Please enter a Vault ID or paste a share link.' };
  }

  let id = trimmed;
  if (trimmed.includes('/v/')) {
    id = trimmed.split('/v/')[1].split('/')[0].split('?')[0];
  } else if (trimmed.includes('v=')) {
    const match = trimmed.match(/[?&]v=([^&]+)/);
    if (match) id = match[1];
  }

  // Allow standard Vault ID formats: 'vlt_<alphanumeric>' or generic min 6-char IDs
  const isValidFormat = /^vlt_[a-zA-Z0-9_-]{4,32}$/.test(id) || /^[a-zA-Z0-9_-]{6,32}$/.test(id);
  if (!isValidFormat) {
    return {
      vaultId: null,
      error: 'Invalid Vault ID format. It should look like "vlt_51f0ba6084" or a full share link.',
    };
  }

  return { vaultId: id, error: null };
}

function getClientDeviceName(): string {
  const ua = navigator.userAgent;
  let browser = 'Browser';
  if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Chrome') && !ua.includes('Edge')) browser = 'Chrome';
  else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
  else if (ua.includes('Edge')) browser = 'Edge';

  let os = 'Device';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('Linux') && !ua.includes('Android')) os = 'Linux';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

  return `${browser} on ${os}`;
}

export const App: React.FC = () => {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [activeTransferFile, setActiveTransferFile] = useState<CatalogItem | null>(null);
  const [vaultId, setVaultId] = useState<string | null>(() => parseVaultIdFromLocation());
  const [isCheckingVault, setIsCheckingVault] = useState<boolean>(() => !!parseVaultIdFromLocation());
  const [vaultNotFound, setVaultNotFound] = useState<boolean>(false);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [hasPassword, setHasPassword] = useState<boolean>(false);
  const [isExpired, setIsExpired] = useState<boolean>(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [inputVaultInput, setInputVaultInput] = useState<string>('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);

  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

  // 1. Parse Vault ID on location changes
  useEffect(() => {
    const id = parseVaultIdFromLocation();
    if (id) {
      setVaultId(id);
      setIsCheckingVault(true);
      setVaultNotFound(false);
    }
  }, []);

  // 2. Query Vault security & expiry info directly from Cloud Firestore
  useEffect(() => {
    if (!vaultId) {
      setIsCheckingVault(false);
      setIsLocked(false);
      setVaultNotFound(false);
      return;
    }

    setIsCheckingVault(true);
    setVaultNotFound(false);
    setIsExpired(false);

    // Direct real-time listener from Cloud Firestore (100% Serverless!)
    const unsubscribe = onSnapshot(
      doc(db, 'vaults', vaultId),
      (docSnap) => {
        setIsCheckingVault(false);
        if (docSnap.exists()) {
          const data = docSnap.data();
          const now = Date.now();
          const expAt = data.expiresAt || null;

          if (expAt && expAt > 0 && now > expAt) {
            setIsExpired(true);
            setIsLocked(false);
            setVaultNotFound(false);
            setIsLoading(false);
            return;
          }

          if (expAt) {
            setExpiresAt(expAt);
          }

          setVaultNotFound(false);

          if (data.requiresPassword) {
            setHasPassword(true);
            setIsLocked(true);
          } else {
            setHasPassword(false);
            setIsLocked(false);
          }

          if (data.files && Array.isArray(data.files)) {
            const fileList: CatalogItem[] = data.files.map((f: any) => ({
              path: f.path,
              name: f.name || f.path.split('/').pop() || 'file',
              size: f.size,
              sha256: f.sha256,
              mtime: f.mtime,
            }));
            setCatalog({
              status: 'success',
              root_hash: data.merkleRoot || '',
              updated_at: data.updatedAt || Date.now(),
              total_size_bytes: fileList.reduce((acc, f) => acc + (f.size || 0), 0),
              item_count: fileList.length,
              device_id: data.deviceId || 'Android Storage Node',
              files: fileList,
            });
            setIsLoading(false);
          }
        } else {
          // Document does not exist in Firestore
          if (!backendUrl) {
            setVaultNotFound(true);
            setIsLocked(false);
            setIsLoading(false);
          } else {
            // Fallback to local REST backend if available
            fetch(`${backendUrl}/api/v1/vault/${vaultId}/security`)
              .then((res) => (res.ok ? res.json() : null))
              .then((data) => {
                if (!data) {
                  setVaultNotFound(true);
                  setIsLocked(false);
                  return;
                }
                setVaultNotFound(false);
                if (data.requiresPassword) {
                  setHasPassword(true);
                  setIsLocked(true);
                } else {
                  setHasPassword(false);
                  setIsLocked(false);
                }
              })
              .catch(() => {
                setVaultNotFound(true);
                setIsLocked(false);
              })
              .finally(() => setIsLoading(false));
          }
        }
      },
      (error) => {
        console.warn('Firestore subscription error (vault missing or permission denied):', error);
        setIsCheckingVault(false);
        setIsLoading(false);
        setVaultNotFound(true);
        setIsLocked(false);
      }
    );

    return () => unsubscribe();
  }, [vaultId, backendUrl]);

  // 3. Register client presence in Cloud Firestore for real-time Connected Devices
  useEffect(() => {
    if (!vaultId) return;

    const clientId = 'client_' + Math.random().toString(36).slice(2, 9);
    const clientRef = doc(db, 'vaults', vaultId, 'clients', clientId);
    const deviceName = getClientDeviceName();

    setDoc(clientRef, {
      clientId,
      deviceName,
      ip: 'Web Browser',
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    }).catch(console.warn);

    const heartbeatTimer = setInterval(() => {
      updateDoc(clientRef, {
        lastSeen: Date.now(),
      }).catch(console.warn);
    }, 15000);

    const handleUnload = () => {
      deleteDoc(clientRef).catch(() => {});
    };
    window.addEventListener('beforeunload', handleUnload);

    return () => {
      clearInterval(heartbeatTimer);
      window.removeEventListener('beforeunload', handleUnload);
      deleteDoc(clientRef).catch(() => {});
    };
  }, [vaultId]);

  // 3. Fetch Catalog Function
  const fetchCatalog = useCallback(async () => {
    setIsLoading(true);
    try {
      if (vaultId) {
        // Handled reactively by Firestore above
        setIsLoading(false);
        return;
      }
      if (backendUrl) {
        const res = await fetch(`${backendUrl}/api/v1/catalog`);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data: CatalogResponse = await res.json();
        setCatalog(data);
      }
    } catch (err: any) {
      console.error('Failed to fetch catalog:', err);
    } finally {
      setIsLoading(false);
    }
  }, [vaultId, backendUrl]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  // 4. Auto-open file transfer modal if ?file= query parameter is present in URL
  const [hasAutoOpenedFile, setHasAutoOpenedFile] = useState(false);
  useEffect(() => {
    if (!catalog?.files || hasAutoOpenedFile || isLocked) return;
    const params = new URLSearchParams(window.location.search);
    const targetFileParam = params.get('file');
    if (!targetFileParam) return;

    const matched = catalog.files.find(
      (f) =>
        f.name === targetFileParam ||
        f.path === targetFileParam ||
        f.sha256 === targetFileParam ||
        f.name.toLowerCase() === targetFileParam.toLowerCase()
    );

    if (matched) {
      setActiveTransferFile(matched);
      setHasAutoOpenedFile(true);
    }
  }, [catalog, isLocked, hasAutoOpenedFile]);

  const handleResetToConnect = () => {
    window.history.pushState({}, '', '/');
    setVaultId(null);
    setVaultNotFound(false);
    setIsExpired(false);
    setIsLocked(false);
    setHasPassword(false);
    setIsCheckingVault(false);
    setInputVaultInput('');
    setConnectError(null);
    setCatalog(null);
  };

  const handleConnectVault = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnectError(null);

    const { vaultId: targetId, error } = extractAndValidateVaultId(inputVaultInput);
    if (error || !targetId) {
      setConnectError(error || 'Invalid Vault ID.');
      return;
    }

    setIsConnecting(true);
    try {
      // Pre-check if vault exists in Cloud Firestore before redirecting
      const docSnap = await getDoc(doc(db, 'vaults', targetId)).catch((err) => {
        console.warn('Firestore pre-check error:', err);
        return null;
      });

      if (!docSnap || !docSnap.exists()) {
        if (backendUrl) {
          const res = await fetch(`${backendUrl}/api/v1/vault/${targetId}/security`).catch(() => null);
          if (!res || !res.ok) {
            setConnectError(`No active vault found with ID "${targetId}". Check the ID or ensure your LazyVault Android app is running.`);
            setIsConnecting(false);
            return;
          }
        } else {
          setConnectError(`No active vault found with ID "${targetId}". Check the ID or ensure your LazyVault Android app is running.`);
          setIsConnecting(false);
          return;
        }
      } else {
        const data = docSnap.data();
        const now = Date.now();
        if (data.expiresAt && data.expiresAt > 0 && now > data.expiresAt) {
          setConnectError(`This vault link has expired. Request a new share link from the Android app.`);
          setIsConnecting(false);
          return;
        }
      }

      window.history.pushState({}, '', `/v/${targetId}`);
      setVaultId(targetId);
      setVaultNotFound(false);
      setIsCheckingVault(true);
    } catch (err: any) {
      setConnectError(`Unable to verify vault: ${err.message || 'Network error'}`);
    } finally {
      setIsConnecting(false);
    }
  };

  // 4. Render Loading State when verifying Vault
  if (isCheckingVault && vaultId) {
    return (
      <div className="min-h-screen bg-[#0b0f17] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-[#111726] border border-slate-800 rounded-2xl p-7 text-center space-y-4 shadow-xl">
          <div className="h-12 w-12 mx-auto rounded-xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
            <Loader2 className="h-6 w-6 animate-spin text-blue-400" />
          </div>
          <h2 className="text-base font-semibold text-white">Connecting to Vault</h2>
          <p className="text-xs text-slate-400 font-mono">
            {vaultId}
          </p>
          <p className="text-xs text-slate-500">
            Verifying device availability and catalog...
          </p>
        </div>
      </div>
    );
  }

  // 5. Render Vault Not Found Screen
  if (vaultNotFound && vaultId) {
    return (
      <div className="min-h-screen bg-[#0b0f17] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-[#111726] border border-slate-800 rounded-2xl p-7 text-center space-y-5 shadow-xl">
          <div className="h-12 w-12 mx-auto rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
            <FolderX className="h-6 w-6 text-red-400" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-white">Vault Not Found</h2>
            <p className="text-xs text-slate-400 font-mono break-all">
              {vaultId}
            </p>
            <p className="text-xs text-slate-400 leading-relaxed pt-1">
              No active vault was found with this ID. It may have expired, been revoked, or the ID was mistyped.
            </p>
          </div>
          <button
            type="button"
            onClick={handleResetToConnect}
            className="w-full py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-lg text-xs transition border border-slate-700/80 shadow-sm"
          >
            Enter Another Vault ID
          </button>
        </div>
      </div>
    );
  }

  // 6. Render Expired Screen
  if (isExpired) {
    return (
      <div className="min-h-screen bg-[#0b0f17] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-[#111726] border border-slate-800 rounded-2xl p-7 text-center space-y-4 shadow-xl">
          <div className="h-12 w-12 mx-auto rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400">
            <FolderLock className="h-6 w-6 text-amber-500" />
          </div>
          <h2 className="text-lg font-semibold text-white">Vault Link Expired</h2>
          <p className="text-xs text-slate-400">
            This vault link has reached its expiration time. Request a new share link from the Android LazyVault app.
          </p>
          <button
            type="button"
            onClick={handleResetToConnect}
            className="w-full py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-lg text-xs transition border border-slate-700/80 shadow-sm"
          >
            Connect to Another Vault
          </button>
        </div>
      </div>
    );
  }

  // 7. Render Connect Screen if no Vault ID
  if (!vaultId) {
    return (
      <div className="min-h-screen bg-[#0b0f17] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-[#111726] border border-slate-800 rounded-2xl p-7 shadow-xl space-y-6">
          <div className="text-center space-y-2">
            <div className="h-12 w-12 mx-auto rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-sm">
              <Shield className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-semibold text-white">Connect to LazyVault</h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Enter your Vault ID or paste your shareable link to browse and download files.
            </p>
          </div>

          <form onSubmit={handleConnectVault} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Vault ID or Share Link
              </label>
              <input
                type="text"
                placeholder="e.g. vlt_51f0ba6084"
                value={inputVaultInput}
                onChange={(e) => {
                  setInputVaultInput(e.target.value);
                  if (connectError) setConnectError(null);
                }}
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700/80 rounded-lg text-white font-mono text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
                autoFocus
              />
            </div>

            {connectError && (
              <div className="p-3 rounded-lg bg-red-950/40 border border-red-800/60 text-xs text-red-300 flex items-start space-x-2">
                <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />
                <span>{connectError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={!inputVaultInput.trim() || isConnecting}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg text-xs transition shadow-sm flex items-center justify-center space-x-2"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Verifying Vault...</span>
                </>
              ) : (
                <>
                  <span>Connect</span>
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </form>

          <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 text-xs text-slate-400">
            <span className="font-medium text-slate-300 block mb-0.5">Need a Vault ID?</span>
            Open the LazyVault app on your phone, configure a folder, and tap "Share Link".
          </div>
        </div>
      </div>
    );
  }

  // 8. Render Password Gate if locked
  if (isLocked && vaultId) {
    return (
      <PasswordGate
        vaultId={vaultId}
        backendUrl={backendUrl}
        onUnlocked={() => {
          setIsLocked(false);
          fetchCatalog();
        }}
        onBack={handleResetToConnect}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0f17] flex flex-col font-sans">
      {/* Top Navigation & Status */}
      <Header
        vaultId={vaultId}
        deviceId={catalog?.device_id}
        itemCount={catalog?.item_count || 0}
        totalSizeBytes={catalog?.total_size_bytes || 0}
        rootHash={catalog?.root_hash}
        lastUpdated={catalog?.updated_at}
        expiresAt={expiresAt}
        hasPassword={hasPassword}
        isLoading={isLoading}
        onRefresh={fetchCatalog}
        onLock={() => setIsLocked(true)}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        {/* Architecture Infobar */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          <div className="bg-[#111726] border border-slate-800 rounded-xl p-4 flex items-start space-x-3 shadow-sm">
            <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-blue-400">
              <Zap className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-slate-200">Direct Peer-to-Peer</h3>
              <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                Files stream directly between your device and browser via encrypted WebRTC.
              </p>
            </div>
          </div>

          <div className="bg-[#111726] border border-slate-800 rounded-xl p-4 flex items-start space-x-3 shadow-sm">
            <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-emerald-400">
              <Shield className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-slate-200">Zero Cloud Storage</h3>
              <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                Only file names and hashes are indexed. No files ever sit on cloud servers.
              </p>
            </div>
          </div>

          <div className="bg-[#111726] border border-slate-800 rounded-xl p-4 flex items-start space-x-3 shadow-sm">
            <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300">
              <Smartphone className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-slate-200">On-Demand Approval</h3>
              <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                Your phone sleeps until you request a file and tap Allow on the notification.
              </p>
            </div>
          </div>
        </div>

        {/* Action Controls & Catalog Heading */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
          <div>
            <h2 className="text-base font-semibold text-white tracking-tight">Available Files</h2>
            <p className="text-xs text-slate-400">Select any file to stream directly to your downloads</p>
          </div>
          <ManualRequestForm onSubmit={(item) => setActiveTransferFile(item)} />
        </div>

        {/* File Table */}
        <CatalogTable
          files={catalog?.files || []}
          vaultId={vaultId}
          onRequestFile={(item) => setActiveTransferFile(item)}
        />
      </main>

      {/* Transfer Modal */}
      {activeTransferFile && (
        <TransferModal
          file={activeTransferFile}
          backendUrl={backendUrl}
          vaultId={vaultId}
          onClose={() => setActiveTransferFile(null)}
        />
      )}

      {/* Footer */}
      <footer className="border-t border-slate-800/80 py-4 px-6 text-center text-xs text-slate-500 bg-[#0d131f]">
        LazyVault • Private Peer-to-Peer File Transfer Protocol
      </footer>
    </div>
  );
};
