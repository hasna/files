import { useState, useEffect, useCallback } from "react";
import { HardDrive, Search, Tag, Server, RefreshCw, File, Database, Layers, BookOpen } from "lucide-react";
import { FileDetailPanel } from "./components/FileDetailPanel.js";
import { api } from "./lib/api.js";
import type { Source, FileRecord, Machine, Tag as TagType, Collection, Project } from "./types.js";

type View = "files" | "sources" | "tags" | "machines" | "collections" | "projects";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

function cn(...classes: (string | undefined | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

export default function App() {
  const [view, setView] = useState<View>("files");
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [tags, setTags] = useState<TagType[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [collectionFiles, setCollectionFiles] = useState<FileRecord[]>([]);
  const [projectFiles, setProjectFiles] = useState<FileRecord[]>([]);
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileRecord | null>(null);
  const [query, setQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [selectedSource, setSelectedSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [indexing, setIndexing] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { limit: 100 };
      if (query) params.q = query;
      if (selectedTag) params.tag = selectedTag;
      if (selectedSource) params.source_id = selectedSource;
      const data = await api.files(params);
      setFiles(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [query, selectedTag, selectedSource]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  useEffect(() => {
    api.sources().then(setSources).catch(() => {});
    api.machines().then(setMachines).catch(() => {});
    api.tags().then(setTags).catch(() => {});
    api.collections().then(setCollections).catch(() => {});
    api.projects().then(setProjects).catch(() => {});
  }, []);

  const handleIndex = async (sourceId: string) => {
    setIndexing(sourceId);
    try {
      await api.indexSource(sourceId);
      const updated = await api.sources();
      setSources(updated);
      await loadFiles();
    } catch { /* ignore */ }
    setIndexing(null);
  };

  const navItem = (v: View, icon: React.ReactNode, label: string) => (
    <button
      onClick={() => setView(v)}
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-lg text-sm w-full transition-colors",
        view === v ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800"
      )}
    >
      {icon} {label}
    </button>
  );

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-52 bg-slate-900 border-r border-slate-800 flex flex-col p-3 gap-1 shrink-0">
        <div className="flex items-center gap-2 px-3 py-3 mb-2">
          <Database className="w-5 h-5 text-indigo-400" />
          <span className="font-semibold text-white">Files</span>
        </div>
        {navItem("files", <File className="w-4 h-4" />, "Files")}
        {navItem("sources", <HardDrive className="w-4 h-4" />, "Sources")}
        {navItem("collections", <Layers className="w-4 h-4" />, "Collections")}
        {navItem("projects", <BookOpen className="w-4 h-4" />, "Projects")}
        {navItem("tags", <Tag className="w-4 h-4" />, "Tags")}
        {navItem("machines", <Server className="w-4 h-4" />, "Machines")}
        <div className="mt-auto text-xs text-slate-600 px-3 pb-1">open-files v0.1.0</div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {view === "files" && (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-3 p-4 border-b border-slate-800 bg-slate-900">
              <div className="flex items-center gap-2 flex-1 bg-slate-800 rounded-lg px-3 py-2">
                <Search className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  className="bg-transparent flex-1 text-sm outline-none text-white placeholder:text-slate-500"
                  placeholder="Search files…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <select
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300"
                value={selectedSource}
                onChange={(e) => setSelectedSource(e.target.value)}
              >
                <option value="">All sources</option>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300"
                value={selectedTag}
                onChange={(e) => setSelectedTag(e.target.value)}
              >
                <option value="">All tags</option>
                {tags.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
              </select>
              <button onClick={loadFiles} className="p-2 hover:bg-slate-800 rounded-lg transition-colors">
                <RefreshCw className={cn("w-4 h-4 text-slate-400", loading && "animate-spin")} />
              </button>
            </div>

            {/* File table + detail panel */}
            <div className="flex flex-1 overflow-hidden">
              <div className="flex-1 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-900 border-b border-slate-800">
                  <tr className="text-slate-400 text-left">
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Path</th>
                    <th className="px-4 py-3 font-medium">Size</th>
                    <th className="px-4 py-3 font-medium">Tags</th>
                    <th className="px-4 py-3 font-medium">Modified</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => (
                    <tr key={f.id} onClick={() => setSelectedFile(f)} className={cn("border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors cursor-pointer", selectedFile?.id === f.id && "bg-indigo-900/20")}>
                      <td className="px-4 py-2.5 text-white font-medium flex items-center gap-2">
                        <File className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        {f.name}
                      </td>
                      <td className="px-4 py-2.5 text-slate-400 max-w-xs truncate font-mono text-xs">{f.path}</td>
                      <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">{formatSize(f.size)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex gap-1 flex-wrap">
                          {f.tags.map((t) => (
                            <span key={t} className="px-1.5 py-0.5 bg-indigo-900/50 text-indigo-300 rounded text-xs">{t}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 text-xs whitespace-nowrap">
                        {f.modified_at ? new Date(f.modified_at).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                  {!loading && !files.length && (
                    <tr><td colSpan={5} className="px-4 py-12 text-center text-slate-500">No files found</td></tr>
                  )}
                </tbody>
              </table>
              </div>
              {selectedFile && (
                <FileDetailPanel
                  file={selectedFile}
                  onClose={() => setSelectedFile(null)}
                  onTagsChanged={(updated) => {
                    setSelectedFile(updated);
                    setFiles((prev) => prev.map((f) => f.id === updated.id ? updated : f));
                  }}
                />
              )}
            </div>
            <div className="px-4 py-2 border-t border-slate-800 text-xs text-slate-500">{files.length} file(s)</div>
          </>
        )}

        {view === "sources" && (
          <div className="p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Sources</h2>
            <div className="space-y-3">
              {sources.map((s) => (
                <div key={s.id} className="bg-slate-800 rounded-xl p-4 flex items-center gap-4">
                  <HardDrive className="w-8 h-8 text-indigo-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-white">{s.name}</div>
                    <div className="text-xs text-slate-400 truncate font-mono">
                      {s.type === "s3" ? `s3://${s.bucket}${s.prefix ? `/${s.prefix}` : ""}` : s.path}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {s.file_count} files · {s.type.toUpperCase()} · {s.enabled ? "enabled" : "disabled"}
                    </div>
                  </div>
                  <button
                    onClick={() => handleIndex(s.id)}
                    disabled={indexing === s.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5", indexing === s.id && "animate-spin")} />
                    Index
                  </button>
                </div>
              ))}
              {!sources.length && <p className="text-slate-500">No sources yet. Run: <code className="text-indigo-300">files sources add ./path</code></p>}
            </div>
          </div>
        )}

        {view === "tags" && (
          <div className="p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Tags</h2>
            <div className="flex flex-wrap gap-2">
              {tags.map((t) => (
                <span key={t.id} className="px-3 py-1.5 rounded-full text-sm font-medium" style={{ backgroundColor: `${t.color}22`, color: t.color, border: `1px solid ${t.color}44` }}>
                  {t.name}
                </span>
              ))}
              {!tags.length && <p className="text-slate-500">No tags yet.</p>}
            </div>
          </div>
        )}

        {view === "collections" && (
          <div className="flex h-full">
            {/* Collection list */}
            <div className="w-64 border-r border-slate-800 p-4 overflow-y-auto">
              <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">Collections</h2>
              {collections.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setSelectedCollection(c.id);
                    api.files({ collection_id: c.id, limit: 200 }).then(setCollectionFiles).catch(() => {});
                  }}
                  className={cn("w-full text-left px-3 py-2 rounded-lg text-sm mb-1 transition-colors", selectedCollection === c.id ? "bg-indigo-600 text-white" : "text-slate-300 hover:bg-slate-800")}
                >
                  <div className="font-medium">{c.name}</div>
                  {c.description && <div className="text-xs opacity-60 truncate">{c.description}</div>}
                </button>
              ))}
              {!collections.length && <p className="text-slate-500 text-sm">No collections yet.<br /><code className="text-indigo-400">files collections create "name"</code></p>}
            </div>
            {/* Files in collection */}
            <div className="flex-1 overflow-auto">
              {selectedCollection ? (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-900 border-b border-slate-800">
                    <tr className="text-slate-400 text-left">
                      <th className="px-4 py-3 font-medium">Name</th>
                      <th className="px-4 py-3 font-medium">Path</th>
                      <th className="px-4 py-3 font-medium">Size</th>
                      <th className="px-4 py-3 font-medium">Tags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collectionFiles.map((f) => (
                      <tr key={f.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                        <td className="px-4 py-2.5 text-white font-medium">{f.name}</td>
                        <td className="px-4 py-2.5 text-slate-400 font-mono text-xs truncate max-w-xs">{f.path}</td>
                        <td className="px-4 py-2.5 text-slate-400">{formatSize(f.size)}</td>
                        <td className="px-4 py-2.5">{f.tags.map((t) => <span key={t} className="px-1.5 py-0.5 bg-indigo-900/50 text-indigo-300 rounded text-xs mr-1">{t}</span>)}</td>
                      </tr>
                    ))}
                    {!collectionFiles.length && <tr><td colSpan={4} className="px-4 py-12 text-center text-slate-500">No files in this collection</td></tr>}
                  </tbody>
                </table>
              ) : <div className="flex items-center justify-center h-full text-slate-500">Select a collection</div>}
            </div>
          </div>
        )}

        {view === "projects" && (
          <div className="flex h-full">
            <div className="w-64 border-r border-slate-800 p-4 overflow-y-auto">
              <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">Projects</h2>
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setSelectedProject(p.id);
                    api.files({ project_id: p.id, limit: 200 }).then(setProjectFiles).catch(() => {});
                  }}
                  className={cn("w-full text-left px-3 py-2 rounded-lg text-sm mb-1 transition-colors", selectedProject === p.id ? "bg-indigo-600 text-white" : "text-slate-300 hover:bg-slate-800")}
                >
                  <div className="font-medium">{p.name}</div>
                  {p.description && <div className="text-xs opacity-60 truncate">{p.description}</div>}
                </button>
              ))}
              {!projects.length && <p className="text-slate-500 text-sm">No projects yet.<br /><code className="text-indigo-400">files projects create "name"</code></p>}
            </div>
            <div className="flex-1 overflow-auto">
              {selectedProject ? (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-900 border-b border-slate-800">
                    <tr className="text-slate-400 text-left">
                      <th className="px-4 py-3 font-medium">Name</th>
                      <th className="px-4 py-3 font-medium">Path</th>
                      <th className="px-4 py-3 font-medium">Size</th>
                      <th className="px-4 py-3 font-medium">Tags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projectFiles.map((f) => (
                      <tr key={f.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                        <td className="px-4 py-2.5 text-white font-medium">{f.name}</td>
                        <td className="px-4 py-2.5 text-slate-400 font-mono text-xs truncate max-w-xs">{f.path}</td>
                        <td className="px-4 py-2.5 text-slate-400">{formatSize(f.size)}</td>
                        <td className="px-4 py-2.5">{f.tags.map((t) => <span key={t} className="px-1.5 py-0.5 bg-indigo-900/50 text-indigo-300 rounded text-xs mr-1">{t}</span>)}</td>
                      </tr>
                    ))}
                    {!projectFiles.length && <tr><td colSpan={4} className="px-4 py-12 text-center text-slate-500">No files in this project</td></tr>}
                  </tbody>
                </table>
              ) : <div className="flex items-center justify-center h-full text-slate-500">Select a project</div>}
            </div>
          </div>
        )}

        {view === "machines" && (
          <div className="p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Machines</h2>
            <div className="space-y-3">
              {machines.map((m) => (
                <div key={m.id} className="bg-slate-800 rounded-xl p-4 flex items-center gap-4">
                  <Server className="w-8 h-8 text-emerald-400 shrink-0" />
                  <div className="flex-1">
                    <div className="font-medium text-white flex items-center gap-2">
                      {m.hostname}
                      {m.is_current && <span className="text-xs bg-emerald-900/50 text-emerald-400 px-2 py-0.5 rounded-full">this machine</span>}
                    </div>
                    <div className="text-xs text-slate-400">{m.platform} / {m.arch}</div>
                    <div className="text-xs text-slate-500">Last seen: {new Date(m.last_seen).toLocaleString()}</div>
                  </div>
                </div>
              ))}
              {!machines.length && <p className="text-slate-500">No machines registered.</p>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
