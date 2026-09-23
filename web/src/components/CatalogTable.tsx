import React, { useState } from 'react';
import { CatalogItem } from '../types.js';
import {
  Search,
  FileCode,
  FileArchive,
  FileText,
  FileImage,
  File,
  Copy,
  Check,
  DownloadCloud,
  Layers,
} from 'lucide-react';

interface CatalogTableProps {
  files: CatalogItem[];
  onRequestFile: (item: CatalogItem) => void;
}

export const CatalogTable: React.FC<CatalogTableProps> = ({ files, onRequestFile }) => {
  const [search, setSearch] = useState('');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const getFileIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    if (['zip', 'tar', 'gz', 'bz2', '7z', 'rar'].includes(ext || '')) {
      return <FileArchive className="h-5 w-5 text-amber-400" />;
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext || '')) {
      return <FileImage className="h-5 w-5 text-purple-400" />;
    }
    if (['json', 'yaml', 'yml', 'xml', 'csv', 'sql'].includes(ext || '')) {
      return <FileCode className="h-5 w-5 text-emerald-400" />;
    }
    if (['bin', 'pt', 'onnx', 'safetensors', 'weights'].includes(ext || '')) {
      return <Layers className="h-5 w-5 text-cyan-400" />;
    }
    if (['txt', 'md', 'pdf', 'doc', 'docx'].includes(ext || '')) {
      return <FileText className="h-5 w-5 text-blue-400" />;
    }
    return <File className="h-5 w-5 text-slate-400" />;
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(text);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const filteredFiles = files.filter((f) => {
    const term = search.toLowerCase();
    return (
      f.name.toLowerCase().includes(term) ||
      f.path.toLowerCase().includes(term) ||
      f.sha256.toLowerCase().includes(term)
    );
  });

  return (
    <div className="bg-[#0f172a] rounded-xl border border-slate-800 overflow-hidden shadow-2xl">
      {/* Search Header */}
      <div className="p-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by file name, path, or SHA-256 hash..."
            className="w-full pl-9 pr-4 py-2 bg-slate-900 border border-slate-700/60 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition"
          />
        </div>

        <div className="text-xs text-slate-400">
          Showing <span className="text-slate-200 font-semibold">{filteredFiles.length}</span> of{' '}
          <span className="text-slate-200 font-semibold">{files.length}</span> indexed items
        </div>
      </div>

      {/* Table */}
      {filteredFiles.length === 0 ? (
        <div className="py-16 text-center text-slate-400">
          <Layers className="h-12 w-12 mx-auto text-slate-600 mb-3" />
          <p className="text-base font-medium text-slate-300">No matching files found</p>
          <p className="text-xs text-slate-500 mt-1">
            {files.length === 0
              ? 'Mobile node has not pushed any catalog generation yet. Sync from the Android app.'
              : 'Try clearing your search query.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#0b1120] text-slate-400 text-xs uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-3 px-4 font-semibold">File Name</th>
                <th className="py-3 px-4 font-semibold hidden md:table-cell">Storage Path</th>
                <th className="py-3 px-4 font-semibold">Size</th>
                <th className="py-3 px-4 font-semibold">SHA-256 Hash</th>
                <th className="py-3 px-4 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredFiles.map((file) => (
                <tr
                  key={file.sha256}
                  className="hover:bg-slate-800/40 transition group"
                >
                  {/* File Name */}
                  <td className="py-3.5 px-4 font-medium text-slate-200">
                    <div className="flex items-center space-x-3">
                      {getFileIcon(file.name)}
                      <span className="truncate max-w-xs">{file.name}</span>
                    </div>
                  </td>

                  {/* Path */}
                  <td className="py-3.5 px-4 text-xs font-mono text-slate-400 hidden md:table-cell max-w-xs truncate">
                    {file.path}
                  </td>

                  {/* Size */}
                  <td className="py-3.5 px-4 text-xs font-mono text-slate-300">
                    {formatBytes(file.size)}
                  </td>

                  {/* SHA-256 Hash */}
                  <td className="py-3.5 px-4">
                    <div className="flex items-center space-x-1.5 font-mono text-xs text-slate-400">
                      <span className="text-slate-300">{file.sha256.slice(0, 10)}...{file.sha256.slice(-6)}</span>
                      <button
                        onClick={() => copyToClipboard(file.sha256)}
                        title="Copy full SHA-256 hash"
                        className="p-1 hover:text-cyan-400 rounded transition"
                      >
                        {copiedHash === file.sha256 ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5 text-slate-500 hover:text-slate-300" />
                        )}
                      </button>
                    </div>
                  </td>

                  {/* Action */}
                  <td className="py-3.5 px-4 text-right">
                    <button
                      onClick={() => onRequestFile(file)}
                      className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-semibold text-xs rounded-lg shadow-sm hover:shadow-cyan-500/25 transition active:scale-95"
                    >
                      <DownloadCloud className="h-3.5 w-3.5" />
                      <span>Request</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
