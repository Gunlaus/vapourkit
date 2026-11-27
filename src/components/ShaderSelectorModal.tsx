import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { ModalShell } from './ModalShell';
import { SHADER_PRESETS, type ShaderSettings } from '../../electron/shaderTypes';

export function ShaderSelectorModal({ onClose, onSelect }: { onClose: () => void; onSelect: (settings: ShaderSettings) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const choose = async (presetId?: string) => {
    setBusy(true); setError('');
    try {
      const value = await window.electronAPI.chooseShader(presetId);
      if (active.current && value) { active.current = false; onSelect(value); onClose(); }
    } catch (err) { if (active.current) setError(String(err)); }
    finally { if (active.current) setBusy(false); }
  };
  const close = () => { active.current = false; onClose(); };
  return <ModalShell title="Choose GLSL shader" icon={Sparkles} onClose={close} closeLabel="Close shader selector" className="w-full max-w-xl" panelProps={{ role: 'dialog', 'aria-modal': true }}>
    <div className="p-4 space-y-3 text-xs">
      <p>Shaders process video on the GPU. This first version uses one shader step with NVEncC execution and Simple NVIDIA encoding. Shader preview and combinations with AI models or VS filters are not available yet.</p>
      <fieldset disabled={busy} className="space-y-2">
        {SHADER_PRESETS.map(preset => <button key={preset.id} type="button" className="block w-full rounded border border-ink-700 p-3 text-left hover:border-accent-500 disabled:opacity-50" onClick={() => void choose(preset.id)}>
          <strong className="block text-ink-100">{preset.name}</strong><span className="text-ink-400">{preset.description}</span>
        </button>)}
        <button type="button" className="text-accent-400 disabled:opacity-50" onClick={() => void choose()}>Import custom .glsl shader…</button>
      </fieldset>
      <p className="text-ink-500">Bundled Anime4K shaders by bloc97, MIT license, from release 4.0.1. Imports accept compatible mpv/libplacebo hook shaders. Custom imports initially keep the source size; set the intended scale on the card.</p>
      {busy && <p role="status">Importing shader…</p>}
      {error && <p role="alert" className="text-bad-400">{error}</p>}
    </div>
  </ModalShell>;
}
