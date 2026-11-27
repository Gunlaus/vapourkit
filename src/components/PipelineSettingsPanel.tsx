import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PIPELINE_SETTINGS, pipelineSettingsSchema, type PipelineSettings } from '../../electron/pipelineSettings';
import type { NvencRuntimeStatus } from '../../electron/nvencTypes';

export function PipelineSettingsPanel() {
  const [settings, setSettings] = useState(DEFAULT_PIPELINE_SETTINGS);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('');
  const [runtime, setRuntime] = useState<NvencRuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState('');
  const active = useRef(true), dirty = useRef(false);
  const latest = useRef(settings);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writes = useRef(Promise.resolve());
  const persist = useCallback((value: PipelineSettings) => {
    writes.current = writes.current.catch(() => {}).then(() => window.electronAPI.setPipelineSettings(value)).then(() => {
      if (JSON.stringify(latest.current) === JSON.stringify(value)) {
        dirty.current = false;
        if (active.current) setMessage('Saved. Changes apply to the next render or preview session.');
      }
    }).catch(error => { if (active.current) setMessage(String(error)); });
  }, []);
  useEffect(() => {
    active.current = true;
    window.electronAPI.getPipelineSettings().then(value => {
      if (active.current) { latest.current = value; setSettings(value); setReady(true); }
    }).catch(error => { if (active.current) setMessage(String(error)); });
    const poll = () => window.electronAPI.getNvencRuntimeStatus().then(value => { if (active.current) setRuntime(value); }).catch(error => { if (active.current) setRuntimeError(String(error)); });
    void poll();
    const interval = setInterval(() => void poll(), 1000);
    return () => {
      active.current = false; clearInterval(interval);
      if (timer.current) clearTimeout(timer.current);
      const parsed = pipelineSettingsSchema.safeParse(latest.current);
      if (dirty.current && parsed.success) persist(parsed.data);
    };
  }, [persist]);
  useEffect(() => {
    if (!ready || !dirty.current) return;
    const parsed = pipelineSettingsSchema.safeParse(settings);
    if (!parsed.success) { setMessage('Enter a valid value to save this change.'); return; }
    timer.current = setTimeout(() => { timer.current = null; persist(parsed.data); }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [settings, ready, persist]);
  const update = (change: Partial<PipelineSettings>) => {
    const next = { ...latest.current, ...change };
    latest.current = next; dirty.current = true; setSettings(next); setMessage('Saving…');
  };
  const install = async () => {
    setRuntimeError('');
    if (runtime) setRuntime({ ...runtime, busy: true, message: 'Preparing download…' });
    try { const value = await window.electronAPI.installNvencRuntime(); if (active.current) setRuntime(value); }
    catch (error) { if (active.current) setRuntimeError(String(error)); }
  };
  return <section className="p-4 border-b border-ink-800 text-xs space-y-3" aria-label="Processing performance">
    <strong>Processing performance</strong>
    <fieldset disabled={!ready} className="space-y-3">
      <label className="block">Execution backend <select aria-label="Execution backend" className="ml-2 bg-ink-900" value={settings.executionBackend} onChange={e => update({ executionBackend: e.target.value as PipelineSettings['executionBackend'] })}>
        <option value="vapoursynth">VapourSynth (standard)</option>
        <option value="nvencc" disabled={!runtime?.supported || !runtime.installed || runtime.busy}>NVEncC GPU (experimental)</option>
      </select></label>
      <p>NVEncC runs one RGB image model and NVIDIA encoding in a GPU pipeline on Windows x64. This first version supports full progressive BT.709 SDR videos, Simple output settings, and no active VS filters or side chains. Use MKV to keep subtitles. Dedicated preview uses VapourSynth; live encoding preview is unavailable on this path.</p>
      {runtime?.supported && <div className="space-y-2 border border-ink-700 p-2">
        <button type="button" disabled={runtime.busy} className="text-accent-400 disabled:opacity-50" onClick={() => void install()}>{runtime.busy ? 'Installing…' : runtime.installed ? 'Repair NVEncC backend' : `Download optional NVEncC backend (${(runtime.downloadBytes / 1e9).toFixed(1)} GB)`}</button>
        <p>Requires 16 GiB free disk space during setup. Installs NVEncC {runtime.version} and its runtime separately from the existing Python/TensorRT environment. First use builds a separate engine cache.</p>
        {runtime.installed && <button type="button" disabled={runtime.busy} className="text-accent-400" onClick={() => { void window.electronAPI.clearNvencEngineCache().then(() => setRuntimeError('Native engine cache reset. The next run will rebuild it.')).catch(error => setRuntimeError(String(error))); }}>Reset NVEncC engine cache</button>}
        {runtime.busy && <progress className="w-full" max="100" value={runtime.progress} />}
        {runtime.message && <p role="status">{runtime.message}</p>}
      </div>}
      {runtimeError && <p role="alert">{runtimeError}</p>}
      <label className="block">Preview height <select aria-label="Encoding preview height" className="ml-2 bg-ink-900" value={settings.previewHeight} onChange={e => update({ previewHeight: Number(e.target.value) })}>{[180,360,480,720,1080].map(n => <option key={n} value={n}>{n} pixels</option>)}</select></label>
      <label className="block">Preview frames per second <input aria-label="Encoding preview frames per second" type="number" className="ml-2 w-16 bg-ink-900" min="0.1" max="5" step="0.1" value={settings.previewFps} onChange={e => update({ previewFps: Number(e.target.value) })} /></label>
      <p>Preview controls apply to VapourSynth encoding. Disable preview before rendering to omit its output branch.</p>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={settings.trtCudaGraphs} onChange={e => update({ trtCudaGraphs: e.target.checked })} />VapourSynth AI model CUDA Graphs</label>
      <p>Reduces GPU launch overhead without changing model precision. Falls back if graph setup fails.</p>
      <details>
        <summary className="cursor-pointer">Advanced VapourSynth scheduling</summary>
        <div className="space-y-3 mt-3">
          <label className="block">Frames in flight <input aria-label="Frames in flight" type="number" className="ml-2 w-20 bg-ink-900" min="0" max="32" value={settings.frameRequests} onChange={e => update({ frameRequests: Number(e.target.value) })} /></label>
          <label className="block">CPU worker threads <input aria-label="CPU worker threads" type="number" className="ml-2 w-20 bg-ink-900" min="0" max="128" value={settings.cpuThreads} onChange={e => update({ cpuThreads: Number(e.target.value) })} /></label>
          <label className="block">Frame cache limit (MiB) <input aria-label="Frame cache limit" type="number" className="ml-2 w-20 bg-ink-900" min="0" max="65536" value={settings.cacheMiB} onChange={e => update({ cacheMiB: Number(e.target.value) })} /></label>
          <p>Zero preserves runtime/template defaults. These controls do not apply to NVEncC. The dedicated preview keeps its own cache limit.</p>
        </div>
      </details>
    </fieldset>
    {message && <p role="status">{message}</p>}
  </section>;
}
