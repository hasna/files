import { useState } from "react";
import { X, Copy, ExternalLink, Tag, Trash2 } from "lucide-react";
import { api } from "../lib/api.js";
import type { FileRecord } from "../types.js";

interface Props {
  file: FileRecord;
  onClose: () => void;
  onTagsChanged: (file: FileRecord) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

export function FileDetailPanel({ file, onClose, onTagsChanged }: Props) {
  const [newTag, setNewTag] = useState("");
  const [tags, setTags] = useState<string[]>(file.tags);
  const [adding, setAdding] = useState(false);

  const copyToClipboard = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

  const handleAddTag = async () => {
    const tag = newTag.trim().toLowerCase();
    if (!tag || tags.includes(tag)) { setNewTag(""); return; }
    setAdding(true);
    await api.addTag(file.id, [tag]);
    const updated = [...tags, tag];
    setTags(updated);
    onTagsChanged({ ...file, tags: updated });
    setNewTag("");
    setAdding(false);
  };

  const handleRemoveTag = async (tag: string) => {
    await api.removeTags(file.id, [tag]);
    const updated = tags.filter((t) => t !== tag);
    setTags(updated);
    onTagsChanged({ ...file, tags: updated });
  };

  const rows: Array<[string, string]> = [
    ["ID", file.id],
    ["Name", file.name],
    ["Extension", file.ext || "—"],
    ["Size", formatSize(file.size)],
    ["MIME", file.mime],
    ["Hash", file.hash ? `${file.hash.slice(0, 32)}…` : "—"],
    ["Path", file.path],
    ["Source", file.source_id],
    ["Machine", file.machine_id],
    ["Indexed", file.indexed_at ? new Date(file.indexed_at).toLocaleString() : "—"],
    ["Modified", file.modified_at ? new Date(file.modified_at).toLocaleString() : "—"],
  ];

  return (
    <div className="w-96 shrink-0 border-l border-slate-800 bg-slate-900 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <span className="font-medium text-white truncate text-sm">{file.name}</span>
        <button onClick={onClose} className="p-1 hover:bg-slate-800 rounded transition-colors ml-2 shrink-0">
          <X className="w-4 h-4 text-slate-400" />
        </button>
      </div>

      {/* Metadata */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="space-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex gap-2 text-sm">
              <span className="text-slate-500 w-20 shrink-0">{label}</span>
              <div className="flex items-center gap-1 min-w-0">
                <span className="text-slate-300 truncate font-mono text-xs">{value}</span>
                {["ID", "Path", "Hash"].includes(label) && value !== "—" && (
                  <button onClick={() => copyToClipboard(label === "Hash" ? (file.hash ?? "") : label === "Path" ? file.path : file.id)} className="shrink-0 p-0.5 hover:text-white text-slate-500 transition-colors">
                    <Copy className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Tags */}
        <div>
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1">
            <Tag className="w-3 h-3" /> Tags
          </div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {tags.map((t) => (
              <span key={t} className="flex items-center gap-1 px-2 py-0.5 bg-indigo-900/50 text-indigo-300 rounded text-xs">
                {t}
                <button onClick={() => handleRemoveTag(t)} className="hover:text-red-400 transition-colors">
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </span>
            ))}
            {!tags.length && <span className="text-slate-600 text-xs">No tags</span>}
          </div>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500"
              placeholder="Add tag…"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
            />
            <button
              onClick={handleAddTag}
              disabled={adding || !newTag.trim()}
              className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm rounded transition-colors"
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
