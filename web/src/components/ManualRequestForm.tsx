import React, { useState } from 'react';
import { CatalogItem } from '../types.js';
import { Search, Send, X, AlertCircle } from 'lucide-react';

interface ManualRequestFormProps {
  onSubmit: (item: CatalogItem) => void;
}

export const ManualRequestForm: React.FC<ManualRequestFormProps> = ({ onSubmit }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [path, setPath] = useState('');
  const [sha256, setSha256] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    const trimmedPath = path.trim();
    const trimmedSha = sha256.trim().toLowerCase();

    if (!trimmedPath) {
      setValidationError('Storage path is required.');
      return;
    }

    if (!trimmedSha) {
      setValidationError('SHA-256 checksum is required.');
      return;
    }

    if (!/^[a-fA-F0-9]{64}$/.test(trimmedSha)) {
      setValidationError('Invalid SHA-256 checksum. Must be exactly 64 hexadecimal characters.');
      return;
    }

    const filename = trimmedPath.split(/[/\\]/).pop() || 'custom_file';
    onSubmit({
      path: trimmedPath,
      name: filename,
      size: 0,
      sha256: trimmedSha,
      mtime: Date.now(),
    });
    setIsOpen(false);
    setPath('');
    setSha256('');
    setValidationError(null);
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-300 transition"
      >
        <Search className="h-3.5 w-3.5 text-slate-400" />
        <span>Request by Path</span>
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="p-4 bg-[#111726] border border-slate-800 rounded-xl space-y-3 shadow-sm w-full max-w-xl"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-slate-300">
          Request Specific File by Path &amp; Hash
        </h4>
        <button
          type="button"
          onClick={() => {
            setIsOpen(false);
            setValidationError(null);
          }}
          className="text-slate-400 hover:text-slate-200 transition"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] text-slate-400 mb-1">Storage Path</label>
          <input
            type="text"
            required
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              if (validationError) setValidationError(null);
            }}
            placeholder="/storage/emulated/0/.../file.pdf"
            className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-[11px] text-slate-400 mb-1">SHA-256 Checksum</label>
          <input
            type="text"
            required
            value={sha256}
            onChange={(e) => {
              setSha256(e.target.value);
              if (validationError) setValidationError(null);
            }}
            placeholder="64-character hex hash"
            className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {validationError && (
        <div className="p-2 rounded bg-red-950/40 border border-red-800/60 text-xs text-red-300 flex items-center space-x-1.5">
          <AlertCircle className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
          <span>{validationError}</span>
        </div>
      )}

      <div className="flex justify-end space-x-2 pt-1">
        <button
          type="button"
          onClick={() => {
            setIsOpen(false);
            setValidationError(null);
          }}
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg transition"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs rounded-lg transition shadow-sm"
        >
          <Send className="h-3.5 w-3.5" />
          <span>Request File</span>
        </button>
      </div>
    </form>
  );
};
