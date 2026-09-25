import React, { useState } from 'react';
import { CatalogItem } from '../types.js';
import {
  Search,
  FileCode,
  FileArchive,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  File,
  Copy,
  Check,
  Download,
  FolderOpen,
} from 'lucide-react';

interface CatalogTableProps {
  files: CatalogItem[];
  onRequestFile: (item: CatalogItem) => void;
}

export const CatalogTable: React.FC<CatalogTableProps> = ({ files, onRequestFile }) => {
  const [search, setSearch] = useState('');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const getFileIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (['zip', 'tar', 'gz', 'bz2', '7z', 'rar'].includes(ext)) {
      return <FileArchive className="h-4 w-4 text-amber-400/90" />;
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'heic'].includes(ext)) {
      return <FileImage className="h-4 w-4 text-sky-400/90" />;
    }
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) {
      return <FileVideo className="h-4 w-4 text-purple-400/90" />;
    }
    if (['mp3', 'wav', 'flac', 'aac', 'm4a'].includes(ext)) {
      return <FileAudio className="h-4 w-4 text-emerald-400/90" />;
    }
    if (['json', 'yaml', 'yml', 'xml', 'csv', 'sql', 'js', 'ts', 'kt'].includes(ext)) {
      return <FileCode className="h-4 w-4 text-emerald-400/90" />;
    }
    if (['txt', 'md', 'pdf', 'doc', 'docx', 'xlsx', 'pptx'].includes(ext)) {
      return <FileText className="h-4 w-4 text-blue-400/90" />;
    }
    return <File className="h-4 w-4 text-slate-400" />;
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
    <div className="bg-[#111726] rounded-xl border border-slate-800 shadow-sm overflow-hidden">
      {/* Search Bar & Header */}
      <div className="p-4 border-b border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#0d131f]">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files by name, path, or hash..."
            className="w-full pl-9 pr-4 py-2 bg-slate-900 border border-slate-700/60 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition"
          />
        </div>

        <div className="text-xs text-slate-400">
          Showing <span className="text-slate-200 font-medium">{filteredFiles.length}</span> of{' '}
          <span className="text-slate-200 font-medium">{files.length}</span> files
        </div>
      </div>

      {/* Table */}
      {filteredFiles.length === 0 ? (
        <div className="py-20 text-center text-slate-400">
          <FolderOpen className="h-10 w-10 mx-auto text-slate-600 mb-3 stroke-[1.5]" />
          <p className="text-sm font-medium text-slate-200">No files found</p>
          <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
            {files.length === 0
              ? 'No files have been indexed yet. Tap "Sync Catalog" in your Android app.'
              : 'No files match your search query.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#0e1422] text-slate-400 text-xs font-medium border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4 hidden md:table-cell">Path</th>
                <th className="py-3 px-4">Size</th>
                <th className="py-3 px-4 hidden lg:table-cell">Checksum</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredFiles.map((file) => (
                <tr
                  key={file.sha256}
                  className="hover:bg-slate-800/30 transition group"
                >
                  {/* File Name */}
                  <td className="py-3 px-4 font-medium text-slate-200">
                    <div className="flex items-center space-x-3">
                      <div className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 flex-shrink-0">
                        {getFileIcon(file.name)}
                      </div>
                      <span className="truncate max-w-xs md:max-w-sm font-normal text-slate-100">{file.name}</span>
                    </div>
                  </td>

                  {/* Path */}
                  <td className="py-3 px-4 text-xs font-mono text-slate-400 hidden md:table-cell max-w-xs truncate">
                    {file.path}
                  </td>

                  {/* Size */}
                  <td className="py-3 px-4 text-xs text-slate-300 whitespace-nowrap">
                    <div className="flex items-center space-x-1.5">
                      <span>{formatBytes(file.size)}</span>
                      {file.size >= 100 * 1024 * 1024 && (
                        <span
                          className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/25 rounded"
                          title="Large File (>100MB): Streams directly via WebRTC P2P (Wi-Fi recommended)"
                        >
                          Large P2P
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Checksum */}
                  <td className="py-3 px-4 hidden lg:table-cell">
                    <div className="flex items-center space-x-1.5 font-mono text-xs text-slate-400">
                      <span>{file.sha256.slice(0, 8)}...{file.sha256.slice(-6)}</span>
                      <button
                        onClick={() => copyToClipboard(file.sha256)}
                        title="Copy SHA-256 hash"
                        className="p-1 hover:text-slate-200 rounded transition"
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
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    <button
                      onClick={() => onRequestFile(file)}
                      className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-medium text-xs rounded-lg transition shadow-sm"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download</span>
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
