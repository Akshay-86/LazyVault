import React, { useState } from 'react';
import {
  Shield,
  HardDrive,
  RefreshCw,
  Smartphone,
  Lock,
  Clock,
  Copy,
  Check,
} from 'lucide-react';

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
  expiresAt,
  hasPassword,
  isLoading,
  onRefresh,
  onLock,
}) => {
  const [copiedVaultId, setCopiedVaultId] = useState(false);

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

  const copyVaultId = () => {
    if (!vaultId) return;
    navigator.clipboard.writeText(vaultId);
    setCopiedVaultId(true);
    setTimeout(() => setCopiedVaultId(false), 2000);
  };

  return (
    <header className="border-b border-slate-800/80 bg-[#0d131f]/90 backdrop-blur-md sticky top-0 z-40 px-6 py-3.5 transition-colors">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="h-9 w-9 rounded-lg bg-blue-600 flex items-center justify-center shadow-sm text-white font-semibold">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2.5">
              <h1 className="text-base font-semibold text-white tracking-tight">LazyVault</h1>
              <span className="px-2 py-0.5 text-[11px] font-medium bg-slate-800 text-slate-300 border border-slate-700/60 rounded-full">
                Peer-to-Peer
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Direct device-to-browser transfers • No cloud storage
            </p>
          </div>
        </div>

        {/* Stats & Actions */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Vault ID */}
          {vaultId && (
            <button
              onClick={copyVaultId}
              title="Click to copy Vault ID"
              className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs transition group"
            >
              <span className="text-slate-400">Vault:</span>
              <span className="font-mono text-slate-200 font-medium">{vaultId}</span>
              {copiedVaultId ? (
                <Check className="h-3.5 w-3.5 text-emerald-400 ml-1" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-slate-500 group-hover:text-slate-300 ml-1 transition" />
              )}
            </button>
          )}

          {/* Device Status */}
          <div className="flex items-center space-x-2 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-slate-300 font-medium">
              {deviceId ? deviceId.slice(0, 14) : 'Device Ready'}
            </span>
          </div>

          {/* Files & Size */}
          <div className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300">
            <HardDrive className="h-3.5 w-3.5 text-slate-400" />
            <span className="font-medium text-slate-200">{itemCount}</span>
            <span className="text-slate-400">files</span>
            <span className="text-slate-500">({formatBytes(totalSizeBytes)})</span>
          </div>

          {/* Expiration Timer */}
          {expiresAt && (
            <div className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300">
              <Clock className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-slate-400">Expires:</span>
              <span className="font-medium text-slate-200">{formatExpiry(expiresAt)}</span>
            </div>
          )}

          {/* Protected Indicator */}
          {hasPassword && (
            <div className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300">
              <Lock className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-slate-400">Passcode Protected</span>
            </div>
          )}

          {/* Lock Action (if authenticated) */}
          {hasPassword && onLock && (
            <button
              onClick={onLock}
              title="Lock Vault"
              className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition"
            >
              <Lock className="h-4 w-4" />
            </button>
          )}

          {/* Refresh Action */}
          <button
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh Catalog"
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-200 text-xs font-medium transition disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>
    </header>
  );
};
