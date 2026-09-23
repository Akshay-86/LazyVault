import React, { useState } from 'react';
import { CatalogItem } from '../types.js';
import { PlusCircle, Send } from 'lucide-react';

interface ManualRequestFormProps {
  onSubmit: (item: CatalogItem) => void;
}

export const ManualRequestForm: React.FC<ManualRequestFormProps> = ({ onSubmit }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [path, setPath] = useState('');
  const [sha256, setSha256] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!path || !sha256) return;

    const filename = path.split('/').pop() || 'custom_file';
    onSubmit({
      path,
      name: filename,
      size: 0,
      sha256: sha256.trim().toLowerCase(),
      mtime: Date.now(),
    });
    setIsOpen(false);
    setPath('');
    setSha256('');
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-slate-700/60 bg-slate-900/80 hover:bg-slate-800 text-xs font-medium text-slate-300 transition"
      >
        <PlusCircle className="h-3.5 w-3.5 text-cyan-400" />
        <span>Request by Path/Hash</span>
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="p-4 bg-slate-900/90 border border-slate-800 rounded-xl space-y-3"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
          Manual Blob Request
        </h4>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="text-xs text-slate-500 hover:text-slate-300"
        >
          Cancel
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] text-slate-400 mb-1">Android Storage Path</label>
          <input
            type="text"
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/storage/emulated/0/LazyVault/artifact.tar"
            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
          />
        </div>
        <div>
          <label className="block text-[11px] text-slate-400 mb-1">Expected SHA-256 Hash</label>
          <input
            type="text"
            required
            value={sha256}
            onChange={(e) => setSha256(e.target.value)}
            placeholder="64-character hex hash"
            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
          />
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-semibold text-xs rounded-lg transition"
        >
          <Send className="h-3.5 w-3.5" />
          <span>Dispatch Request</span>
        </button>
      </div>
    </form>
  );
};
