import { useEffect, useState } from 'react';
import { Section } from './Section';
import { DEFAULT_HDR, hdrSettingsSchema, type HdrSettings } from '../../electron/hdrSettings';
import type { ColorimetrySettings } from '../electron';

export function HdrPanel({ settings, disabled, onChange }: {
  settings: ColorimetrySettings; disabled: boolean; onChange: (value: ColorimetrySettings) => void;
}) {
  const hdr = { ...DEFAULT_HDR, ...settings.hdr };
  const ai = hdr.method === 'hdrtvnet';
  const aiLook = hdr.preset === 'custom' ? 'custom' : (hdr.aiExposure ?? 0) !== 0 || (hdr.aiShoulder ?? .75) !== .75 ? 'custom'
    : hdr.referenceWhite === 203 ? 'natural' : hdr.referenceWhite === 144 ? 'animation' : 'custom';
  const [open, setOpen] = useState(hdr.enabled);
  const [error, setError] = useState('');
  const update = (patch: Partial<HdrSettings>) => {
    const result = hdrSettingsSchema.safeParse({ ...hdr, ...patch });
    if (!result.success) { setError(result.error.issues[0].message); return; }
    setError(''); onChange({ ...settings, hdr: result.data });
  };
  const input = 'ml-2 bg-ink-850 border border-ink-750 rounded px-2 py-1';
  return <Section title="SDR → HDR" meta={hdr.enabled ? 'PQ · 10-bit · experimental' : 'off'}
    collapsible open={open && hdr.enabled} onToggle={() => setOpen(!open)}
    actions={<input type="checkbox" aria-label="Enable SDR to HDR" disabled={disabled} checked={hdr.enabled} onChange={e => { setOpen(e.target.checked); update({ enabled: e.target.checked }); }} />}>
    <fieldset disabled={disabled || !hdr.enabled} className="px-3 py-3 space-y-3 text-xs disabled:opacity-50">
      <label className="block">Method<select aria-label="HDR conversion method" className={input} value={hdr.method ?? 'mathematical'} onChange={e => update({ method: e.target.value as HdrSettings['method'] })}>
        <option value="mathematical">Mathematical</option><option value="hdrtvnet">HDRTVNet++ (NVIDIA, experimental)</option>
      </select></label>
      <label className="block">Look<select className={input} value={ai ? aiLook : hdr.preset} onChange={e => {
        const preset = e.target.value as HdrSettings['preset'];
        update({ preset, ...(ai ? (preset === 'custom' ? {} : { referenceWhite: preset === 'animation' ? 144 : 203, aiExposure: 0, aiShoulder: .75 })
          : preset === 'natural' ? { strength: 0.35 } : preset === 'animation' ? { strength: 0.2 } : {}) });
      }}><option value="natural">Natural</option><option value="animation">Animation</option><option value="custom">Custom</option></select></label>
      <label className="block">Target peak<NumericInput aria-label="HDR target peak" className={input + ' w-24'} type="number" min="400" max="4000" step="1" list="hdr-peak-presets" value={hdr.peakNits} onCommit={value => update({ peakNits: value })} /> nits</label>
      <datalist id="hdr-peak-presets">{[600,1000,2000,4000].map(value => <option key={value} value={value} />)}</datalist>
      {hdr.method !== 'hdrtvnet' && hdr.preset === 'custom' && <label className="block">Highlight expansion<input aria-label="HDR highlight expansion" className="ml-2 align-middle" type="range" min="0" max="1" step="0.01" value={hdr.strength} onChange={e => update({ strength: Number(e.target.value), preset: 'custom' })} /> {Math.round(hdr.strength * 100)}%</label>}
      <label className="flex items-center gap-2"><input type="checkbox" checked={hdr.chroma === 'auto'} onChange={e => update({ chroma: e.target.checked ? 'auto' : 'off' })} />Reconstruct subsampled chroma</label>
      <label className="block" title={ai ? 'Remaps 203-nit tones to this luminance before highlight compression.' : undefined}>{ai ? 'Diffuse white' : 'Reference white'}<NumericInput aria-label="HDR reference white" className={input + ' w-20'} type="number" min="80" max="300" value={hdr.referenceWhite} onCommit={value => update({ referenceWhite: value, preset: 'custom' })} /> nits</label>
      {hdr.method === 'hdrtvnet' && <label className="block">Exposure<NumericInput aria-label="HDRTVNet exposure" className={input + ' w-20'} type="number" min="-2" max="2" step="0.1" value={hdr.aiExposure ?? 0} onCommit={value => update({ aiExposure: value, preset: 'custom' })} /> stops</label>}
      {ai && <label className="block">Highlight roll-off<NumericInput aria-label="HDRTVNet highlight roll-off" className={input + ' w-20'} type="number" min="40" max="95" step="1" value={Math.round((hdr.aiShoulder ?? .75) * 100)} onCommit={value => update({ aiShoulder: value / 100, preset: 'custom' })} /> % of peak</label>}
      {error && <p role="alert" className="text-bad-400">{error}</p>}
    </fieldset>
  </Section>;
}

// Commit complete numbers on blur/Enter so typing e.g. 850 does not reject the
// intermediate "8" against the configured range and reset the input.
function NumericInput({ value, onCommit, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number; onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <input {...props} value={text} onChange={e => setText(e.target.value)}
    onBlur={() => { if (text.trim()) onCommit(Number(text)); setText(String(value)); }}
    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
}
