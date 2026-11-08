import { useState, useEffect, useRef } from 'react';
import { nativeHost } from './native/host';

export default function NativeMediaPreview({ path }: { path: string }) {
  const [seconds, setSeconds] = useState(0);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => { generation.current++; setUrl(''); setError(''); setBusy(false); }, [path]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => () => { generation.current++; }, []);
  async function preview() {
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      const frame = await nativeHost.frame(path, seconds);
      if (current === generation.current) setUrl(URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' })));
    } catch (e) { if (current === generation.current) setError(String(e)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  return <div className="space-y-2 rounded border border-zinc-700 p-3">
    <h3 className="font-semibold">Video frame preview</h3>
    <div className="flex flex-wrap items-center gap-3">
      <label>Time (seconds) <input type="number" min="0" max="604800" step="0.1" className="w-24 bg-zinc-900 border border-zinc-700 rounded p-1" value={seconds} onChange={e => setSeconds(Number(e.target.value))} /></label>
      <button className="bg-zinc-700 rounded px-3 py-2 disabled:opacity-50" disabled={!path || busy || !Number.isFinite(seconds) || seconds < 0} onClick={() => void preview()}>{busy ? 'Loading frame...' : 'Preview frame'}</button>
    </div>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {url && <img className="max-w-full" src={url} alt={`Video frame at ${seconds} seconds`} />}
  </div>;
}
