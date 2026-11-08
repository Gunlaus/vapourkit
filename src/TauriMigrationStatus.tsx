import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

type HostStatus = { host: string; migrationStage: string; platform: string };
type DependencyProbe = { tool: string; available: boolean; detail: string; source: string; path: string };
type MediaInfo = { path: string; durationSeconds: number | null; formatName: string | null; streams: { index: number; codecType: string; codecName: string | null; language: string | null }[] };
type EncodeEvent = { status: string; detail: string; outTimeMs: number | null; speed: string | null };
const tools = ['ffmpeg', 'ffprobe', 'vspipe', 'python'] as const;

export default function TauriMigrationStatus() {
  const [host, setHost] = useState<HostStatus | null>(null);
  const [results, setResults] = useState<DependencyProbe[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [progress, setProgress] = useState<EncodeEvent | null>(null);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void listen<EncodeEvent>('native-encode-progress', event => {
      if (active) setProgress(event.payload);
    }).then(unlisten => {
      if (active) stop = unlisten;
      else unlisten();
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; stop?.(); };
  }, []);

  async function inspect() {
    setError('');
    setMedia(null);
    try {
      setMedia(await invoke<MediaInfo>('inspect_media', { path: input }));
    } catch (e) { setError(String(e)); }
  }

  async function encode() {
    setError('');
    setProgress(null);
    setEncoding(true);
    try {
      await invoke('encode_sample', { input, output });
    } catch (e) { setError(String(e)); }
    finally { setEncoding(false); }
  }


  useEffect(() => {
    void invoke<HostStatus>('host_status').then(setHost).catch((e: unknown) => setError(String(e)));
  }, []);

  async function runProbes() {
    setBusy(true);
    setError('');
    try {
      const next = await Promise.all(tools.map(tool => invoke<DependencyProbe>('discover_dependency', { tool })));
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
              <p className="text-xs text-zinc-500 break-all">{result.source}: {result.path || 'not found'}</p>
            </li>
          ))}
        </ul>
        <section className="border-t border-zinc-700 pt-6 space-y-3">
          <h2 className="text-xl font-semibold">Experimental native video test</h2>
          <p className="text-zinc-400">Enter absolute paths to a small local video and a new output file. Encodes H.264/AAC without VapourSynth filters. Existing outputs are never overwritten.</p>
          <label className="block">Input video
            <input aria-label="Input video" className="block w-full rounded bg-zinc-900 border border-zinc-700 p-2 mt-1" value={input} onChange={e => setInput(e.target.value)} placeholder="C:\\Videos\\test.mkv" />
          </label>
          <label className="block">Output video
            <input aria-label="Output video" className="block w-full rounded bg-zinc-900 border border-zinc-700 p-2 mt-1" value={output} onChange={e => setOutput(e.target.value)} placeholder="C:\\Videos\\test-output.mp4" />
          </label>
          <div className="flex flex-wrap gap-3">
            <button className="rounded bg-zinc-700 px-4 py-2" onClick={() => void inspect()} disabled={!input || encoding}>Inspect tracks</button>
            <button className="rounded bg-indigo-600 px-4 py-2 disabled:opacity-50" onClick={() => void encode()} disabled={!input || !output || encoding}>Start test encode</button>
            <button className="rounded bg-red-700 px-4 py-2 disabled:opacity-50" onClick={() => void invoke('cancel_sample').catch(e => setError(String(e)))} disabled={!encoding}>Cancel</button>
          </div>
          {media && <div className="rounded border border-zinc-700 p-3">
            <p>Format: {media.formatName || 'Unknown'} | Duration: {media.durationSeconds ?? 'Unknown'} seconds</p>
            <ul>{media.streams.map(stream => <li key={stream.index}>#{stream.index}: {stream.codecType} / {stream.codecName || 'unknown'} {stream.language || ''}</li>)}</ul>
          </div>}
          {progress && <p role="status">{progress.status}: {progress.detail} {progress.outTimeMs !== null ? `| ${(progress.outTimeMs / 1000).toFixed(1)}s` : ''} {progress.speed || ''}</p>}
        </section>
      </div>
    </main>
  );
}
