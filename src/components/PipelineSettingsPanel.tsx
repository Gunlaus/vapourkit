import { useEffect, useState } from 'react';
import { DEFAULT_PIPELINE_SETTINGS } from '../../electron/pipelineSettings';
export function PipelineSettingsPanel() {
  const [settings, setSettings] = useState(DEFAULT_PIPELINE_SETTINGS);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { let active = true; window.electronAPI.getPipelineSettings().then(value => { if (active) { setSettings(value); setReady(true); } }).catch(error => setMessage(String(error))); return () => { active = false; }; }, []);
  const save = async () => { try { await window.electronAPI.setPipelineSettings(settings); setMessage('Saved for the next render.'); } catch (error) { setMessage(String(error)); } };
  return <section className="p-4 border-b border-ink-800 text-xs space-y-3" aria-label="Encoding preview">
    <strong>Encoding preview</strong>
    <fieldset disabled={!ready} className="space-y-3">
      <label className="block">Preview height <select aria-label="Encoding preview height" className="ml-2 bg-ink-900" value={settings.previewHeight} onChange={e => setSettings({ ...settings, previewHeight: Number(e.target.value) })}>{[180,360,480,720,1080].map(n => <option key={n} value={n}>{n} pixels</option>)}</select></label>
      <label className="block">Preview frames per second <input aria-label="Encoding preview frames per second" type="number" className="ml-2 w-16 bg-ink-900" min="0.1" max="5" step="0.1" value={settings.previewFps} onChange={e => setSettings({ ...settings, previewFps: Number(e.target.value) })} /></label>
      <p>Changes the encoding preview only. Disable preview before rendering to omit its output branch.</p>
      <button type="button" className="text-accent-400" onClick={() => void save()}>Save preview settings</button>
    </fieldset>
    {message && <p role="status">{message}</p>}
  </section>;
}
