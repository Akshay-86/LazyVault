import React, { useState } from 'react';
import { Lock, ArrowRight, Eye, EyeOff, Loader2 } from 'lucide-react';
import { db } from '../firebase.js';
import { doc, getDoc } from 'firebase/firestore';

interface PasswordGateProps {
  vaultId: string;
  backendUrl: string;
  onUnlocked: () => void;
  onBack?: () => void;
}

export const PasswordGate: React.FC<PasswordGateProps> = ({ vaultId, backendUrl, onUnlocked, onBack }) => {
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
      // 1. Try checking against Cloud Firestore (Serverless)
      const docSnap = await getDoc(doc(db, 'vaults', vaultId));
      if (docSnap.exists()) {
        const vaultData = docSnap.data();
        if (vaultData.passwordHash) {
          const encoder = new TextEncoder();
          const data = encoder.encode(password);
          const hashBuffer = await crypto.subtle.digest('SHA-256', data);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const enteredHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

          if (enteredHash === vaultData.passwordHash) {
            onUnlocked();
            return;
          } else {
            throw new Error('Incorrect passcode. Please try again.');
          }
        } else {
          // No password required
          onUnlocked();
          return;
        }
      }

      // 2. Fallback to REST endpoint if configured
      if (backendUrl) {
        const res = await fetch(`${backendUrl}/api/v1/vault/${vaultId}/verify-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Incorrect passcode. Please try again.');
        }

        onUnlocked();
      } else {
        throw new Error('Vault not found. Please verify the URL.');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0b0f17] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm bg-[#111726] border border-slate-800 rounded-2xl p-7 shadow-xl space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="h-12 w-12 mx-auto rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-200">
            <Lock className="h-5 w-5 text-blue-500" />
          </div>
          <h2 className="text-lg font-semibold tracking-tight text-white">Passcode Protected</h2>
          <p className="text-xs text-slate-400">
            Enter the passcode configured on the mobile device to access this vault.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Passcode
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                autoFocus
                placeholder="Enter vault passcode"
                className="w-full pl-3.5 pr-10 py-2.5 bg-slate-900 border border-slate-700/80 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition"
              />
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
            <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-800/60 text-xs text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!password || isLoading}
            className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-medium text-xs rounded-lg transition shadow-sm flex items-center justify-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Verifying...</span>
              </>
            ) : (
              <>
                <span>Unlock Vault</span>
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>

          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="w-full py-2 px-4 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 font-medium text-xs rounded-lg transition border border-slate-800 text-center"
            >
              Back to Connect
            </button>
          )}
        </form>

        <div className="text-center pt-2 border-t border-slate-800/60">
          <span className="text-[11px] text-slate-500 font-mono">Vault ID: {vaultId}</span>
        </div>
      </div>
    </div>
  );
};
