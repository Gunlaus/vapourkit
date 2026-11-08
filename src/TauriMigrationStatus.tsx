import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type HostStatus = { host: string; migrationStage: string; platform: string };
type DependencyProbe = { tool: string; available: boolean; detail: string };
const tools = ['ffmpeg', 'ffprobe', 'vspipe', 'python'] as const;

export default function TauriMigrationStatus() {
  const [host, setHost] = useState<HostStatus | null>(null);
  const [results, setResults] = useState<DependencyProbe[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void invoke<HostStatus>('host_status').then(setHost).catch((e: unknown) => setError(String(e)));
  }, []);

  async function runProbes() {
    setBusy(true);
    setError('');
    try {
      const next = await Promise.all(tools.map(tool => invoke<DependencyProbe>('probe_dependency', { tool })));
      setResults(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-3xl font-semibold">Vapourkit: Tauri migration preview</h1>
        <p className="text-zinc-400">This is an isolated Rust host diagnostic screen, not the video processing application. Continue using Electron for encoding and preview.</p>
        <p>Host: {host ? `${host.host} / ${host.platform} / ${host.migrationStage}` : 'Connecting...'}</p>
        <button className="rounded bg-indigo-600 px-4 py-2 disabled:opacity-50" disabled={busy} onClick={() => void runProbes()}>
          {busy ? 'Checking tools...' : 'Check native tools'}
        </button>
        {error && <p role="alert" className="text-red-400">{error}</p>}
        <ul className="space-y-3">
          {results.map(result => (
            <li key={result.tool} className="rounded border border-zinc-700 p-4">
              <strong>{result.tool}: {result.available ? 'Available' : 'Unavailable'}</strong>
              <p className="text-zinc-400 break-words">{result.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
