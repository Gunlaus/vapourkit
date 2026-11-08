import { useState, useEffect, useCallback, useRef } from 'react';
import { nativeHost, type EncodeOptions, type QueueSnapshot, type QueueEdit } from './native/host';

export default function NativeBatchQueue({ options, script, busy, onRunningChange }: {
  options: EncodeOptions; script: string | null; busy: boolean; onRunningChange: (running: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [starting, setStarting] = useState(false);
  const revision = useRef(-1);
  const apply = useCallback((next: QueueSnapshot) => {
    if (next.revision < revision.current) return;
    revision.current = next.revision;
    setSnapshot(next);
    onRunningChange(next.running);
    if (next.running) setStarting(false);
  }, [onRunningChange]);
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    // Listen before taking the initial snapshot to avoid missing a transition.
    void nativeHost.onQueue(next => { if (active) apply(next); }).then(async unlisten => {
      if (!active) { unlisten(); return; }
      stop = unlisten;
      const next = await nativeHost.queue();
      if (active) apply(next);
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; stop?.(); };
  }, [apply]);

  async function edit(edit: QueueEdit) {
    setError(''); setPending(true);
    try { apply(await nativeHost.editQueue(edit)); }
    catch (e) { setError(String(e)); }
    finally { setPending(false); }
  }
  async function add() {
    setError(''); setPending(true);
    try {
      apply(await nativeHost.editQueue({ type: 'add', request: {
        input, output, script,
        options: { ...options, audioTracks: [...options.audioTracks], subtitleTracks: [...options.subtitleTracks] },
      } }));
      setInput(''); setOutput('');
    } catch (e) { setError(String(e)); }
    finally { setPending(false); }
  }
  async function run() {
    setError(''); setStarting(true); onRunningChange(true);
    try { await nativeHost.runQueue(); }
    catch (e) { setError(String(e)); }
    finally {
      try { apply(await nativeHost.queue()); } catch (e) { setError(String(e)); }
      setStarting(false);
    }
  }
  async function stop() {
    try { apply(await nativeHost.stopQueue()); }
    catch (e) { setError(String(e)); }
  }
  async function pick(outputFile: boolean) {
    try {
      const path = await (outputFile ? nativeHost.pickOutput() : nativeHost.pick('video'));
      if (path !== null) { if (outputFile) setOutput(path); else setInput(path); }
    } catch (e) { setError(String(e)); }
  }
  const running = snapshot?.running ?? false;
  return <section className="space-y-3 rounded border border-zinc-700 p-4">
    <h2 className="text-xl font-semibold">Batch queue</h2>
    <p className="text-sm text-zinc-400">Jobs and settings are saved before processing. Interrupted jobs require an explicit retry. Each job copies the encoding options and trusted script selected above; track indices must match its source.</p>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    <div className="flex gap-2"><input aria-label="Batch input path" className="w-full rounded bg-zinc-900 border border-zinc-700 p-2" value={input} onChange={e => setInput(e.target.value)} placeholder="Absolute input path" /><button onClick={() => void pick(false)}>Browse</button></div>
    <div className="flex gap-2"><input aria-label="Batch output path" className="w-full rounded bg-zinc-900 border border-zinc-700 p-2" value={output} onChange={e => setOutput(e.target.value)} placeholder="New output file" /><button onClick={() => void pick(true)}>Browse</button></div>
    {script && <p className="text-sm break-all">Trusted script for new jobs: {script}</p>}
    <div className="flex flex-wrap gap-2">
      <button className="rounded bg-zinc-700 px-3 py-2 disabled:opacity-50" disabled={!snapshot || pending || !input || !output} onClick={() => void add()}>Add job</button>
      <button className="rounded bg-indigo-600 px-3 py-2 disabled:opacity-50" disabled={busy || running || starting || pending || !snapshot?.jobs.some(j => j.status === 'queued')} onClick={() => void run()}>Run queue</button>
      <button className="rounded bg-red-700 px-3 py-2 disabled:opacity-50" disabled={!running || snapshot?.stopRequested} onClick={() => void stop()}>{snapshot?.stopRequested ? 'Stopping...' : 'Stop queue'}</button>
      <button className="rounded bg-zinc-700 px-3 py-2 disabled:opacity-50" disabled={!snapshot || pending} onClick={() => void edit({ type: 'clearFinished' })}>Clear finished</button>
      <button className="rounded bg-zinc-700 px-3 py-2 disabled:opacity-50" disabled={!snapshot || pending} onClick={() => void edit({ type: 'applyOptions', options })}>Apply current options to pending jobs</button>
    </div>
    <ul className="space-y-2">{snapshot?.jobs.map(j => <li className="rounded border border-zinc-700 p-2 text-sm break-all" key={j.id}>
      <strong>{j.status}</strong> | {j.options.encoder} | {j.input} → {j.output}
      {j.script && <p>Script: {j.script}</p>}
      {j.error && <p className="text-red-400 whitespace-pre-wrap">{j.error}</p>}
      <div className="flex gap-3">
        {(j.status === 'failed' || j.status === 'cancelled') && <button disabled={pending} onClick={() => void edit({ type: 'retry', id: j.id })}>Retry</button>}
        {j.status !== 'running' && <button disabled={pending} onClick={() => void edit({ type: 'remove', id: j.id })}>Remove</button>}
      </div>
    </li>)}</ul>
    {!snapshot && !error && <p role="status">Loading saved queue...</p>}
  </section>;
}
