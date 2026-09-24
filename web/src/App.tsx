import React, { useState, useEffect, useCallback } from 'react';
import { CatalogResponse, CatalogItem } from './types.js';
import { Header } from './components/Header.js';
import { CatalogTable } from './components/CatalogTable.js';
import { TransferModal } from './components/TransferModal.js';
import { ManualRequestForm } from './components/ManualRequestForm.js';
import { PasswordGate } from './components/PasswordGate.js';
import { Shield, Smartphone, ArrowRight, Zap, FolderLock } from 'lucide-react';
import { db } from './firebase.js';
import { doc, onSnapshot, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

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
  const [vaultId, setVaultId] = useState<string | null>(() => {
    const path = window.location.pathname;
    if (path.startsWith('/v/')) {
      const id = path.replace('/v/', '').split('/')[0];
      if (id) return id;
    }
    const params = new URLSearchParams(window.location.search);
    return params.get('v') || null;
  });
  const [isLocked, setIsLocked] = useState<boolean>(true);
  const [hasPassword, setHasPassword] = useState<boolean>(false);
  const [isExpired, setIsExpired] = useState<boolean>(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [inputVaultInput, setInputVaultInput] = useState<string>('');

  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

  // 1. Parse Vault ID on location changes
  useEffect(() => {
    const path = window.location.pathname;
    if (path.startsWith('/v/')) {
      const id = path.replace('/v/', '').split('/')[0];
      if (id) setVaultId(id);
    } else {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('v');
      if (v) setVaultId(v);
    }
  }, []);

  // 2. Query Vault security & expiry info directly from Cloud Firestore
  useEffect(() => {
    if (!vaultId) {
      setIsLocked(false);
      return;
    }

    // Direct real-time listener from Cloud Firestore (100% Serverless!)
    const unsubscribe = onSnapshot(
      doc(db, 'vaults', vaultId),
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          const now = Date.now();
          const expAt = data.expiresAt || null;

          if (expAt && expAt > 0 && now > expAt) {
            setIsExpired(true);
            setIsLocked(false);
            return;
          }

          if (expAt) {
            setExpiresAt(expAt);
          }

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
          // Fallback to local REST backend if available
          if (backendUrl) {
            fetch(`${backendUrl}/api/v1/vault/${vaultId}/security`)
              .then((res) => (res.ok ? res.json() : null))
              .then((data) => {
                if (!data) return;
                if (data.requiresPassword) {
                  setHasPassword(true);
                  setIsLocked(true);
                } else {
                  setHasPassword(false);
                  setIsLocked(false);
                }
              })
              .catch(() => {});
          }
        }
      },
      (error) => {
        console.warn('Firestore subscription error:', error);
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

  const handleConnectVault = (e: React.FormEvent) => {
    e.preventDefault();
    const input = inputVaultInput.trim();
    if (!input) return;

    let targetId = input;
    if (input.includes('/v/')) {
      targetId = input.split('/v/')[1].split('/')[0].split('?')[0];
    } else if (input.includes('v=')) {
      const match = input.match(/[?&]v=([^&]+)/);
      if (match) targetId = match[1];
    }

    if (targetId) {
      window.history.pushState({}, '', `/v/${targetId}`);
      setVaultId(targetId);
      setIsLocked(true);
    }
  };

  // 4. Render Expired Screen
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
        </div>
      </div>
    );
  }

  // 5. Render Connect Screen if no Vault ID
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
                onChange={(e) => setInputVaultInput(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700/80 rounded-lg text-white font-mono text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
                autoFocus
              />
            </div>
            <button
              type="submit"
              disabled={!inputVaultInput.trim()}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg text-xs transition shadow-sm flex items-center justify-center space-x-2"
            >
              <span>Connect</span>
              <ArrowRight className="h-4 w-4" />
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

  // 6. Render Password Gate if locked
  if (isLocked && vaultId) {
    return (
      <PasswordGate
        vaultId={vaultId}
        backendUrl={backendUrl}
        onUnlocked={() => {
          setIsLocked(false);
          fetchCatalog();
        }}
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
