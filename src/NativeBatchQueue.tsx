import { useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type QueueOptions = {
  encoder: string; quality: number; preset: string;
  audioTracks: number[]; subtitleTracks: number[]; copyAudio: boolean;
};
type Job = { id: number; input: string; output: string; options: QueueOptions; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; error?: string };
export default function NativeBatchQueue({ options }: { options: QueueOptions }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const nextId = useRef(1);
  const update = (id: number, patch: Partial<Job>) => setJobs(current => current.map(j => j.id === id ? { ...j, ...patch } : j));
  function add() {
    if (!input || !output || input === output) return;
    setJobs(current => [...current, { id: nextId.current++, input, output,
      options: { ...options, audioTracks: [...options.audioTracks], subtitleTracks: [...options.subtitleTracks] },
      status: 'queued' }]);
    setInput(''); setOutput('');
  }
  async function run() {
    if (running) return;
    stop.current = false;
    setRunning(true);
    try {
      // Snapshot pending jobs so subsequent UI changes cannot mutate running jobs.
      const pending = jobs.filter(j => j.status === 'queued');
      for (const job of pending) {
        if (stop.current) break;
        update(job.id, { status: 'running' });
        try {
          await invoke('encode_sample', { input: job.input, output: job.output, options: job.options });
          update(job.id, { status: stop.current ? 'cancelled' : 'completed' });
        } catch (error) {
          update(job.id, { status: stop.current ? 'cancelled' : 'failed', error: String(error) });
        }
      }
    } finally { setRunning(false); }
  }
  async function cancel() {
    stop.current = true;
    try { await invoke('cancel_sample'); } catch { /* Job may have finished. */ }
  }
  return <section className="space-y-3 rounded border border-zinc-700 p-4">
    <h2 className="text-xl font-semibold">Native batch queue (sequential)</h2>
    <p className="text-sm text-zinc-400">Each job snapshots the current encoding settings. Outputs must be new files. Track selections are copied; inspect each source before selecting stream indices.</p>
    <input aria-label="Batch input path" className="w-full rounded bg-zinc-900 border border-zinc-700 p-2" value={input} onChange={e => setInput(e.target.value)} placeholder="Absolute input path" />
    <input aria-label="Batch output path" className="w-full rounded bg-zinc-900 border border-zinc-700 p-2" value={output} onChange={e => setOutput(e.target.value)} placeholder="Absolute output path" />
    <div className="flex gap-2">
      <button className="rounded bg-zinc-700 px-3 py-2" onClick={add}>Add job</button>
      <button className="rounded bg-indigo-600 px-3 py-2 disabled:opacity-50" disabled={running || !jobs.some(j => j.status === 'queued')} onClick={() => void run()}>Run queue</button>
      <button className="rounded bg-red-700 px-3 py-2 disabled:opacity-50" disabled={!running} onClick={() => void cancel()}>Stop queue</button>
      <button className="rounded bg-zinc-700 px-3 py-2" disabled={running} onClick={() => setJobs([])}>Clear</button>
    </div>
    <ul className="space-y-2">{jobs.map(j => <li className="rounded border border-zinc-700 p-2 text-sm" key={j.id}>
      <strong>{j.status}</strong> | {j.options.encoder} | {j.input} → {j.output}
      {j.error && <p className="text-red-400">{j.error}</p>}
    </li>)}</ul>
  </section>;
}
