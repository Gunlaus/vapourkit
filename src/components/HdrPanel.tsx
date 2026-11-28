import { useState } from 'react';
import { Section } from './Section';
import { DEFAULT_HDR, hdrSettingsSchema, type HdrSettings } from '../../electron/hdrSettings';
import type { ColorimetrySettings } from '../electron';

export function HdrPanel({ settings, disabled, onChange }: {
  settings: ColorimetrySettings; disabled: boolean; onChange: (value: ColorimetrySettings) => void;
}) {
  const hdr = { ...DEFAULT_HDR, ...settings.hdr };
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
      <label className="block">Look<select className={input} value={hdr.preset} onChange={e => {
        const preset = e.target.value as HdrSettings['preset'];
        update({ preset, ...(preset === 'natural' ? { strength: 0.35 } : preset === 'animation' ? { strength: 0.2 } : {}) });
      }}><option value="natural">Natural</option><option value="animation">Animation</option><option value="custom">Custom</option></select></label>
      <label className="block">Target peak<select aria-label="HDR target peak" className={input} value={hdr.peakNits} onChange={e => update({ peakNits: Number(e.target.value) })}>
        {[600,1000,2000,4000,...(![600,1000,2000,4000].includes(hdr.peakNits) ? [hdr.peakNits] : [])].map(value => <option key={value} value={value}>{value} nits</option>)}
      </select></label>
      <label className="block">Highlight expansion<input aria-label="HDR highlight expansion" className="ml-2 align-middle" type="range" min="0" max="1" step="0.01" value={hdr.strength} onChange={e => update({ strength: Number(e.target.value), preset: 'custom' })} /> {Math.round(hdr.strength * 100)}%</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={hdr.chroma === 'auto'} onChange={e => update({ chroma: e.target.checked ? 'auto' : 'off' })} />Reconstruct subsampled chroma</label>
      <p className="text-ink-500">HEVC/AV1 · PQ / BT.2020 · 10-bit. Preview is tone-mapped to SDR.</p>
      <details><summary className="cursor-pointer">Advanced</summary><div className="mt-2 space-y-2">
        <label className="block">Reference white<input aria-label="HDR reference white" className={input + ' w-20'} type="number" min="80" max="300" value={hdr.referenceWhite} onChange={e => update({ referenceWhite: Number(e.target.value), preset: 'custom' })} /> nits</label>

      </div></details>
      {error && <p role="alert" className="text-bad-400">{error}</p>}
    </fieldset>
  </Section>;
}
