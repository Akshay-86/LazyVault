import React, { useState, useEffect, useCallback } from 'react';
import { CatalogResponse, CatalogItem } from './types.js';
import { Header } from './components/Header.js';
import { CatalogTable } from './components/CatalogTable.js';
import { TransferModal } from './components/TransferModal.js';
import { ManualRequestForm } from './components/ManualRequestForm.js';
import { PasswordGate } from './components/PasswordGate.js';
import { ShieldCheck, Cpu, Lock, Radio, Clock, ArrowRight } from 'lucide-react';
import { db } from './firebase.js';
import { doc, onSnapshot } from 'firebase/firestore';

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
            setIsLocked(true); // Always lock on load / reload!
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
            fetch(`${backendUrl}/api/v1/vault/${vaultId}/info`)
              .then((r) => r.json())
              .then((data) => {
                if (data.isExpired) setIsExpired(true);
                if (data.expiresAt) setExpiresAt(data.expiresAt);
                setHasPassword(!!data.requiresPassword);
                setIsLocked(!!data.requiresPassword);
              })
              .catch((err) => console.warn('Fallback query error:', err));
          }
        }
      },
      (err) => {
        console.warn('Firestore snapshot error, trying fallback:', err);
      }
    );

    return () => unsubscribe();
  }, [vaultId, backendUrl]);

  // 3. Fallback Fetch catalog if REST is used
  const fetchCatalog = useCallback(async () => {
    if (catalog?.files && catalog.files.length > 0) return;
    setIsLoading(true);
    try {
      const url = vaultId ? `${backendUrl}/api/v1/catalog?vaultId=${vaultId}` : `${backendUrl}/api/v1/catalog`;
      const res = await fetch(url);
      if (res.ok) {
        const data: CatalogResponse = await res.json();
        setCatalog(data);
      }
    } catch (err) {
      console.error('Failed to load catalog:', err);
    } finally {
      setIsLoading(false);
    }
  }, [backendUrl, vaultId, catalog]);

  useEffect(() => {
    if (!isLocked && !isExpired && !catalog) {
      fetchCatalog();
    }
  }, [fetchCatalog, isLocked, isExpired, catalog]);

  // 4. Render Link Expired Screen
  if (isExpired && vaultId) {
    return (
      <div className="min-h-screen bg-[#070b14] flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md bg-[#0f172a] border border-red-500/30 rounded-2xl p-8 shadow-2xl text-center space-y-4">
          <div className="h-16 w-16 mx-auto rounded-2xl bg-red-950/60 border border-red-500/40 flex items-center justify-center">
            <Clock className="h-8 w-8 text-red-400" />
          </div>
          <h2 className="text-xl font-bold text-white">Vault Access Link Expired</h2>
          <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs font-mono text-slate-400">
            <span>Vault:</span>
            <span className="font-semibold text-slate-200">{vaultId}</span>
          </div>
          <p className="text-xs text-slate-400">
            This share link reached its TTL limit. The mobile edge storage node has securely revoked access.
          </p>
          <div className="pt-2 border-t border-slate-800/80">
            <p className="text-xs text-slate-500">
              To regain access, open the LazyVault app on your Android device and tap <span className="text-cyan-400 font-semibold">"Revoke & Regenerate"</span>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 5. Render Connect to Vault Screen if no vaultId provided in URL
  if (!vaultId) {
    const handleConnectVault = (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = inputVaultInput.trim();
      if (!trimmed) return;
      let extractedId = trimmed;
      if (trimmed.includes('/v/')) {
        extractedId = trimmed.split('/v/')[1].split(/[/?#]/)[0];
      } else if (trimmed.includes('?v=')) {
        try {
          extractedId = new URL(trimmed).searchParams.get('v') || trimmed;
        } catch {
          extractedId = trimmed.split('?v=')[1].split('&')[0];
        }
      }
      if (extractedId) {
        window.history.pushState({}, '', `/v/${extractedId}`);
        setVaultId(extractedId);
        setIsLoading(true);
        setIsLocked(true);
      }
    };

    return (
      <div className="min-h-screen bg-[#070b14] flex flex-col items-center justify-center p-4">
        <div className="absolute w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl -z-10 pointer-events-none" />
        <div className="w-full max-w-md bg-[#0f172a] border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-6">
          <div className="text-center space-y-2">
            <div className="h-16 w-16 mx-auto rounded-2xl bg-cyan-950/60 border border-cyan-800 flex items-center justify-center shadow-lg shadow-cyan-500/10">
              <Radio className="h-8 w-8 text-cyan-400" />
            </div>
            <h2 className="text-xl font-bold text-white">Connect to LazyVault</h2>
            <p className="text-xs text-slate-400">
              Enter your Vault ID or paste your shareable link from the Android LazyVault app.
            </p>
          </div>

          <form onSubmit={handleConnectVault} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Vault ID or Share Link
              </label>
              <input
                type="text"
                placeholder="e.g. vlt_51f0ba6084 or full URL"
                value={inputVaultInput}
                onChange={(e) => setInputVaultInput(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-white font-mono text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-colors"
                autoFocus
              />
            </div>
            <button
              type="submit"
              disabled={!inputVaultInput.trim()}
              className="w-full py-2.5 px-4 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-semibold rounded-xl text-sm transition-all flex items-center justify-center space-x-2 shadow-lg shadow-cyan-500/20"
            >
              <span>Connect to Vault</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>

          <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-[11px] text-slate-400 space-y-1">
            <div className="font-semibold text-slate-300 flex items-center space-x-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-cyan-400" />
              <span>Zero-Trust Storage Node</span>
            </div>
            <p>
              LazyVault connects directly peer-to-peer to your mobile device via WebRTC with hardware cryptographic verification.
            </p>
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
    <div className="min-h-screen bg-[#070b14] flex flex-col font-sans">
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
        {/* Zero-Trust Architecture Infobar */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex items-start space-x-3">
            <div className="p-2 rounded-lg bg-cyan-950/60 border border-cyan-800 text-cyan-400">
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-200">Lazy Mobile Node</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Android remains dormant until woken by High-Priority trigger.
              </p>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex items-start space-x-3">
            <div className="p-2 rounded-lg bg-emerald-950/60 border border-emerald-800 text-emerald-400">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-200">Zero Persistent Blobs</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Broker stores metadata tree only. No file blobs ever sit in cloud storage.
              </p>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex items-start space-x-3">
            <div className="p-2 rounded-lg bg-amber-950/60 border border-amber-800 text-amber-400">
              <Radio className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-200">Dynamic Transport</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                P2P WebRTC DataChannels for browser, ephemeral AES-GCM relay for CI/CD.
              </p>
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white tracking-tight flex items-center space-x-2">
            <span>Synchronized File Catalog</span>
          </h2>
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
      <footer className="border-t border-slate-800/80 py-4 px-6 text-center text-xs text-slate-500 bg-[#0b1120]">
        LazyVault v1.0 • Zero-Trust Asynchronous Node Storage Protocol
      </footer>
    </div>
  );
};
