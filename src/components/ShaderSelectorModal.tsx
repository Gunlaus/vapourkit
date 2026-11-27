import { useEffect, useRef, useState } from 'react';
import { Sparkles, Plus } from 'lucide-react';
import { PickerModal, PickerRow, PickerSidebarSection, PickerChip } from './PickerModal';
import { ShaderEditDialog } from './ShaderEditDialog';
import type { NvencRuntimeStatus } from '../../electron/nvencTypes';
import type { ShaderSettings, ShaderLibraryEntry } from '../../electron/shaderTypes';
export function ShaderSelectorModal({ onClose, onSelect }: { onClose: () => void; onSelect: (settings: ShaderSettings) => void }) {
  const [entries, setEntries] = useState<ShaderLibraryEntry[]>([]), [query, setQuery] = useState(''), [category, setCategory] = useState('All');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [editing, setEditing] = useState<ShaderLibraryEntry | null>(null);
  const [runtime, setRuntime] = useState<{ installed: boolean; busy: boolean } | null>(null);
  const [native, setNative] = useState<NvencRuntimeStatus | null>(null);
  const active = useRef(true);
  const refresh = async () => { const values = await window.electronAPI.listShaderLibrary(); if (active.current) setEntries(values); };
  useEffect(() => {
    active.current = true;
    void refresh().catch(e => setError(String(e)));
    void window.electronAPI.getShaderRuntimeStatus().then(setRuntime).catch(e => setError(String(e)));
    void window.electronAPI.getNvencRuntimeStatus().then(setNative).catch(e => setError(String(e)));
    return () => { active.current = false; };
  }, []);
  const categories = ['All', ...new Set(entries.flatMap(e => e.categories).filter(Boolean).sort())];
  const choose = async (entry: ShaderLibraryEntry) => {
    if (busy) return; setBusy(true); setError('');
    try {
      const value = await window.electronAPI.chooseShader(entry.id);
      if (active.current && value) { active.current = false; onSelect(value); onClose(); }
    } catch (e) { if (active.current) setError(String(e)); }
    finally { if (active.current) setBusy(false); }
  };
  return <>
    {editing && <ShaderEditDialog key={editing.id || editing.name} entry={editing} onClose={() => setEditing(null)} onSaved={() => { void refresh(); }} />}
    <PickerModal title="GLSL Shader Library" icon={Sparkles} closeLabel="Close shader library" onClose={() => { active.current = false; onClose(); }}
      searchQuery={query} onSearchChange={setQuery} searchPlaceholder="Search shaders, descriptions or categories…"
      sidebar={<PickerSidebarSection label="Categories" options={categories.map(key => ({ key, label: key, count: entries.filter(e => key === 'All' || e.categories.includes(key)).length }))} selected={category} onSelect={setCategory} />}
      headerActions={<button type="button" disabled={busy} className="text-accent-400 text-xs inline-flex items-center gap-1 px-3" onClick={() => {
        setError(''); void window.electronAPI.importShaderLibrary().then(value => { if (active.current && value) setEditing(value); }).catch(e => setError(String(e)));
      }}><Plus className="w-3 h-3" />Add GLSL shader</button>}
      listTop={<div className="p-3 space-y-2 text-xs text-ink-400 border-b border-ink-800">
        <p>Stack shaders in chain order. Standard processing supports CPU encoding, preview, AI models and VS filters. Compatible shader-only NVIDIA encodes use GPU routing automatically.</p>
        {runtime && !runtime.installed && <button type="button" disabled={busy} className="text-accent-400" onClick={() => { setBusy(true); void window.electronAPI.installShaderRuntime().then(setRuntime).catch(e => setError(String(e))).finally(() => setBusy(false)); }}>Install standard shader support (CPU/NVIDIA encoders and preview)</button>}
        {native?.supported && <button type="button" disabled={busy} className="block text-accent-400" onClick={() => { setBusy(true); void window.electronAPI.installNvencRuntime().then(setNative).catch(e => setError(String(e))).finally(() => setBusy(false)); }}>{native.installed ? 'Repair NVIDIA shader acceleration' : `Install optional NVIDIA shader acceleration (${(native.downloadBytes / 1e9).toFixed(1)} GB)`}</button>}
        {busy && <p role="status">Working…</p>}{error && <p role="alert" className="text-bad-400">{error}</p>}
      </div>}
      showPinned={false} favorites={[]} recents={[]} items={entries.filter(e => (category === 'All' || e.categories.includes(category)) && [e.name,e.description,...e.categories].join(' ').toLowerCase().includes(query.toLowerCase()))}
      itemsTitle="Shaders" emptyText="No matching shaders" noun="shaders"
      renderItem={entry => <PickerRow key={entry.id} title={entry.name} noun="shader" isSelected={false} description={entry.description} badges={<PickerChip>{entry.scale}×</PickerChip>}
        details={<span className="text-[10px] text-ink-500">{entry.categories.join(' · ')}{entry.builtin ? ' · Bundled' : ' · Library copy'}</span>}
        onSelect={() => void choose(entry)} onEdit={() => { void window.electronAPI.readShaderLibrary(entry.id).then(setEditing).catch(e => setError(String(e))); }} />}
      footerExtra="Bundled sources and licenses are included with the app." />
  </>;
}
