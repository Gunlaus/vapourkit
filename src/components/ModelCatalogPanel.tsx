import { useEffect, useState } from 'react';
import type { ComponentEntry, ComponentSnapshot } from '../../electron/componentCatalog';
import { ModalShell } from './ModalShell';

export function ModelCatalogPanel({ onInstalled }: { onInstalled?: () => Promise<void> }) {
  const [snapshot, setSnapshot] = useState<ComponentSnapshot | null>(null);
  const [experimental, setExperimental] = useState(false);
  const [selected, setSelected] = useState<ComponentEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const refresh = async () => {
    try { setSnapshot(await window.electronAPI.listCatalogModels()); }
    catch (error) { setMessage(String(error)); }
  };
  useEffect(() => { void refresh(); }, []);
  const install = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.installCatalogModel({ id: selected.id, version: selected.version, experimental, accepted: true });
      await refresh();
      await onInstalled?.();
      setMessage(result.message); setSelected(null);
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  return <section className="p-4 border-b border-ink-800 text-xs space-y-3" aria-label="Model catalog">
    <div className="flex justify-between gap-3"><strong>Models available with this release</strong><button type="button" className="text-accent-400" disabled={busy} onClick={() => void refresh()}>Refresh installed models</button></div>
    <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={experimental} onChange={event => setExperimental(event.target.checked)} />Show experimental models (GPU validation pending)</label>
    {(snapshot?.catalog.components ?? []).filter(entry => experimental || entry.channel === 'stable').map(entry => <article key={entry.id + '@' + entry.version} className="border border-ink-750 rounded p-2 space-y-1">
      <div className="flex justify-between gap-3"><strong>{entry.name} {entry.version}</strong><button type="button" className="text-accent-400 disabled:text-ink-500" disabled={busy || snapshot?.installed[entry.id + '@' + entry.version] === entry.version} onClick={() => { setMessage(''); setSelected(entry); }}>{snapshot?.installed[entry.id + '@' + entry.version] === entry.version ? 'Installed' : 'Review installation'}</button></div>
      <p>{entry.notes}</p><p className="text-ink-400">{entry.author} · {entry.license} · {(entry.files.reduce((sum,file) => sum + file.bytes,0) / 1048576).toFixed(1)} MiB</p>
    </article>)}
    {message && <p role="status" className="whitespace-pre-wrap">{message}</p>}
    {selected && <ModelInstallConsent entry={selected} busy={busy} message={message} onClose={() => { if (!busy) setSelected(null); }} onAccept={() => void install()} />}
  </section>;
}

export function ModelInstallConsent({ entry, busy, message, onClose, onAccept }: {
  entry: ComponentEntry; busy: boolean; message: string; onClose: () => void; onAccept: () => void;
}) {
  return <ModalShell title="Review model installation" onClose={onClose} closeDisabled={busy} layer={80} className="w-[650px] max-w-full max-h-[85vh] overflow-auto" panelProps={{ role: 'dialog', 'aria-label': 'Review model installation', 'aria-modal': true }}>
      <div className="p-4 space-y-3">
        <strong>{entry.name} {entry.version}</strong>
        <p>Creator: {entry.author}</p>
        <p><button type="button" className="text-accent-400 underline" onClick={() => void window.electronAPI.openExternal(entry.source)}>Model source: {entry.source}</button></p>
        <p><button type="button" className="text-accent-400 underline" title={entry.licenseUrl} onClick={() => void window.electronAPI.openExternal(entry.licenseUrl)}>Licence: {entry.license}</button></p>
        <p>Total download: {entry.files.reduce((sum,file) => sum + file.bytes,0).toLocaleString()} bytes</p>
        {entry.files.map(file => <div key={file.path} className="break-all text-ink-400"><p>{file.path} · {file.bytes.toLocaleString()} bytes</p><p>SHA256: {file.sha256}</p></div>)}
        <p>Install this model under the linked licence? Existing models and saved workflows are kept.</p>
        {message && <p role="status" className="whitespace-pre-wrap">{message}</p>}
        <div className="flex justify-end gap-4"><button disabled={busy} onClick={onClose}>Cancel</button><button disabled={busy} className="text-accent-400" onClick={onAccept}>{busy ? 'Installing…' : 'Accept and install'}</button></div>
      </div>
    </ModalShell>;
}
