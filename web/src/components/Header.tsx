import React from 'react';
import { ShieldCheck, HardDrive, RefreshCw, Smartphone, Key, Lock, Clock } from 'lucide-react';

interface HeaderProps {
  vaultId?: string | null;
  deviceId?: string;
  itemCount: number;
  totalSizeBytes: number;
  rootHash?: string;
  lastUpdated?: number;
  expiresAt?: number | null;
  hasPassword?: boolean;
  isLoading: boolean;
  onRefresh: () => void;
  onLock?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  vaultId,
  deviceId,
  itemCount,
  totalSizeBytes,
  rootHash,
  lastUpdated,
  expiresAt,
  hasPassword,
  isLoading,
  onRefresh,
  onLock,
}) => {
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatExpiry = (target: number) => {
    const diff = target - Date.now();
    if (diff <= 0) return 'Expired';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `${days}d left`;
    }
    return `${hours}h ${mins}m left`;
  };

  return (
    <header className="border-b border-slate-800 bg-[#0b1120] px-6 py-4">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <ShieldCheck className="h-6 w-6 text-white" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="text-xl font-bold tracking-tight text-white">LazyVault</h1>
              <span className="px-2 py-0.5 text-xs font-semibold bg-cyan-950 text-cyan-400 border border-cyan-800 rounded-full">
                Zero-Trust Dormant Node
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Asynchronously leased on-demand storage • Zero persistent blobs on cloud
            </p>
          </div>
        </div>

        {/* Stats & Actions */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Vault ID */}
          {vaultId && (
            <div className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-cyan-950/80 border border-cyan-700/70 text-xs">
              <span className="text-cyan-400 font-semibold">Vault:</span>
              <span className="font-mono text-cyan-200 font-medium">{vaultId}</span>
            </div>
          )}

          {/* Node Status */}
          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs">
            <Smartphone className="h-4 w-4 text-emerald-400" />
            <span className="text-slate-400">Node:</span>
            <span className="font-mono font-medium text-slate-200">
              {deviceId ? deviceId.slice(0, 12) + '...' : 'Dormant (Waiting)'}
            </span>
          </div>

          {/* Files & Size */}
          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs">
            <HardDrive className="h-4 w-4 text-cyan-400" />
            <span className="text-slate-400">Catalog:</span>
            <span className="font-semibold text-slate-200">{itemCount} files</span>
            <span className="text-slate-500">({formatBytes(totalSizeBytes)})</span>
          </div>

          {/* Merkle Root */}
          {rootHash && (
            <div className="hidden lg:flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs">
              <Key className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-slate-400">Root:</span>
              <span className="font-mono text-amber-300/90">{rootHash.slice(0, 10)}...</span>
            </div>
          )}

          {/* Expiration Timer */}
          {expiresAt && (
            <div className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs">
              <Clock className="h-3.5 w-3.5 text-cyan-400" />
              <span className="text-slate-400">TTL:</span>
              <span className="font-mono text-cyan-300 font-medium">{formatExpiry(expiresAt)}</span>
            </div>
          )}

          {/* Refresh Button */}
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/30 border border-cyan-500/40 text-cyan-300 text-xs font-medium transition disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Sync</span>
          </button>

          {/* Lock Vault Button */}
          {hasPassword && onLock && (
            <button
              onClick={onLock}
              title="Lock Vault (Require passcode again)"
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-amber-950/40 hover:bg-amber-900/50 border border-amber-700/60 text-amber-300 text-xs font-medium transition"
            >
              <Lock className="h-3.5 w-3.5 text-amber-400" />
              <span>Lock</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
