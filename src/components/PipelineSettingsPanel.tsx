import { useEffect, useState } from 'react';
import { DEFAULT_PIPELINE_SETTINGS } from '../../electron/pipelineSettings';
export function PipelineSettingsPanel() {
  const [settings, setSettings] = useState(DEFAULT_PIPELINE_SETTINGS);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { let active = true; window.electronAPI.getPipelineSettings().then(value => { if (active) { setSettings(value); setReady(true); } }).catch(error => setMessage(String(error))); return () => { active = false; }; }, []);
  const save = async () => { try { await window.electronAPI.setPipelineSettings(settings); setMessage('Saved for the next render.'); } catch (error) { setMessage(String(error)); } };
  return <section className="p-4 border-b border-ink-800 text-xs space-y-3" aria-label="Processing performance">
    <strong>Processing performance</strong>
    <fieldset disabled={!ready} className="space-y-3">
      <label className="block">Preview height <select aria-label="Encoding preview height" className="ml-2 bg-ink-900" value={settings.previewHeight} onChange={e => setSettings({ ...settings, previewHeight: Number(e.target.value) })}>{[180,360,480,720,1080].map(n => <option key={n} value={n}>{n} pixels</option>)}</select></label>
      <label className="block">Preview frames per second <input aria-label="Encoding preview frames per second" type="number" className="ml-2 w-16 bg-ink-900" min="0.1" max="5" step="0.1" value={settings.previewFps} onChange={e => setSettings({ ...settings, previewFps: Number(e.target.value) })} /></label>
      <p>Changes the encoding preview only. Disable preview before rendering to omit its output branch.</p>
      <p>Preview FPS is limited by elapsed time, so faster renders do not produce previews you cannot see.</p>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={settings.trtCudaGraphs} onChange={e => setSettings({ ...settings, trtCudaGraphs: e.target.checked })} />TensorRT CUDA Graphs</label>
      <p>Reduces GPU launch overhead without changing model precision. Falls back if graph setup fails. Turn off to compare speed or troubleshoot a model.</p>
      <details>
        <summary className="cursor-pointer">Advanced scheduling</summary>
        <div className="space-y-3 mt-3">
          <label className="block">Frames in flight <input aria-label="Frames in flight" type="number" className="ml-2 w-20 bg-ink-900" min="0" max="32" value={settings.frameRequests} onChange={e => setSettings({ ...settings, frameRequests: Number(e.target.value) })} /></label>
          <label className="block">CPU worker threads <input aria-label="CPU worker threads" type="number" className="ml-2 w-20 bg-ink-900" min="0" max="128" value={settings.cpuThreads} onChange={e => setSettings({ ...settings, cpuThreads: Number(e.target.value) })} /></label>
          <label className="block">Frame cache limit (MiB) <input aria-label="Frame cache limit" type="number" className="ml-2 w-20 bg-ink-900" min="0" max="65536" value={settings.cacheMiB} onChange={e => setSettings({ ...settings, cacheMiB: Number(e.target.value) })} /></label>
          <p>Zero keeps the existing runtime or template default. Higher values can use more memory and may reduce speed. Inference streams are configured above. The dedicated preview keeps its own cache limit.</p>
        </div>
      </details>
      <button type="button" className="text-accent-400" onClick={() => void save()}>Save performance settings</button>
    </fieldset>
    {message && <p role="status">{message}</p>}
  </section>;
}
