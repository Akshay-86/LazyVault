import React, { useState, useEffect, useCallback } from 'react';
import { CatalogResponse, CatalogItem } from './types.js';
import { Header } from './components/Header.js';
import { CatalogTable } from './components/CatalogTable.js';
import { TransferModal } from './components/TransferModal.js';
import { ManualRequestForm } from './components/ManualRequestForm.js';
import { PasswordGate } from './components/PasswordGate.js';
import { ShieldCheck, Cpu, Lock, Radio, Clock } from 'lucide-react';

export const App: React.FC = () => {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [activeTransferFile, setActiveTransferFile] = useState<CatalogItem | null>(null);
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [isLocked, setIsLocked] = useState<boolean>(true);
  const [hasPassword, setHasPassword] = useState<boolean>(false);
  const [isExpired, setIsExpired] = useState<boolean>(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

  // 1. Parse Vault ID from URL
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

  // 2. Query Vault security & expiry info
  useEffect(() => {
    if (!vaultId) {
      setIsLocked(false);
      return;
    }

    fetch(`${backendUrl}/api/v1/vault/${vaultId}/info`)
      .then((r) => r.json())
      .then((data) => {
        if (data.isExpired) {
          setIsExpired(true);
          setIsLocked(false);
          return;
        }

        if (data.expiresAt) {
          setExpiresAt(data.expiresAt);
        }

        if (data.requiresPassword) {
          setHasPassword(true);
          // Always locked on every restart/reload!
          setIsLocked(true);
        } else {
          setHasPassword(false);
          setIsLocked(false);
        }
      })
      .catch((err) => {
        console.warn('Failed to query vault info:', err);
        setIsLocked(false);
      });
  }, [vaultId, backendUrl]);

  // 3. Fetch catalog
  const fetchCatalog = useCallback(async () => {
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
  }, [backendUrl, vaultId]);

  useEffect(() => {
    if (!isLocked && !isExpired) {
      fetchCatalog();
    }
  }, [fetchCatalog, isLocked, isExpired]);

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

  // 5. Render Password Gate if locked
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
