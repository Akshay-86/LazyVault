import React, { useState } from 'react';
import { Lock, KeyRound, ShieldAlert, ArrowRight, Eye, EyeOff, CheckCircle2 } from 'lucide-react';

interface PasswordGateProps {
  vaultId: string;
  backendUrl: string;
  onUnlocked: () => void;
}

export const PasswordGate: React.FC<PasswordGateProps> = ({ vaultId, backendUrl, onUnlocked }) => {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`${backendUrl}/api/v1/vault/${vaultId}/verify-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Incorrect passcode. Check your Android device.');
      }

      // Do not store in sessionStorage so every restart/reload requires passcode
      onUnlocked();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#070b14] flex flex-col items-center justify-center p-4">
      {/* Glow Effect */}
      <div className="absolute w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl -z-10 pointer-events-none" />

      <div className="w-full max-w-md bg-[#0f172a] border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-6">
        {/* Icon & Title */}
        <div className="text-center space-y-2">
          <div className="h-16 w-16 mx-auto rounded-2xl bg-gradient-to-br from-amber-500/20 to-cyan-500/20 border border-amber-500/30 flex items-center justify-center shadow-lg shadow-amber-500/10">
            <Lock className="h-8 w-8 text-amber-400" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-white">Encrypted Vault Gate</h2>
          <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-slate-900 border border-slate-700/80 text-xs font-mono text-cyan-400">
            <span>Vault:</span>
            <span className="font-semibold text-white">{vaultId}</span>
          </div>
          <p className="text-xs text-slate-400 pt-1">
            This lazy storage node is password protected. Enter the passcode configured in your Android app to unlock the file catalog.
          </p>
        </div>

        {/* Password Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Vault Passcode
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter passcode (e.g. vault123)"
                className="w-full pl-10 pr-10 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition font-mono"
              />
              <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-center space-x-2 p-3 bg-red-950/60 border border-red-500/40 rounded-xl text-xs text-red-300 animate-in fade-in">
              <ShieldAlert className="h-4 w-4 flex-shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading || !password}
            className="w-full flex items-center justify-center space-x-2 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-semibold text-sm rounded-xl transition shadow-lg shadow-cyan-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <span>Verifying...</span>
            ) : (
              <>
                <span>Unlock Vault</span>
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </form>

        {/* Security Notice */}
        <div className="border-t border-slate-800/80 pt-4 flex items-start space-x-2 text-[11px] text-slate-500">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 mt-0.5 flex-shrink-0" />
          <span>Zero-Trust: The broker only grants catalog visibility upon passcode authentication. File blobs remain asleep on mobile storage.</span>
        </div>
      </div>
    </div>
  );
};
