import { useEffect, useState } from 'react';
import type { ShaderInfo, ShaderSettings } from '../../electron/shaderTypes';

export function ShaderSettingsCard({ value, disabled, onChange, onChoose }: {
  value?: ShaderSettings; disabled: boolean; onChange: (value: ShaderSettings) => void; onChoose: () => void;
}) {
  const [info, setInfo] = useState<ShaderInfo | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let active = true; setInfo(null); setError('');
    if (value) window.electronAPI.getShaderInfo(value).then(result => { if (active) setInfo(result); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [value?.path, value?.presetId]);
  return <fieldset disabled={disabled} className="space-y-3 text-xs">
    <button type="button" onClick={onChoose} className="text-accent-400">{info?.name ?? value?.name ?? 'Choose GLSL shader'} · Change…</button>
    {info && <p className="text-ink-400">{info.description}</p>}
    <p>Requires <strong>NVEncC execution</strong> in Settings → Processing, Simple NVIDIA encoding, and one main-chain shader. Shader preview is unavailable; test a short source video to inspect the result.</p>
    {value && <>
      <label className="block">Output scale <select aria-label="Shader output scale" className="ml-2 bg-ink-850" disabled={disabled || !!value.presetId} value={value.scale} onChange={e => onChange({ ...value, scale: Number(e.target.value) })}>
        {[1,2,3,4].map(scale => <option key={scale} value={scale}>{scale === 1 ? '1× — keep source size' : `${scale}×`}</option>)}
      </select></label>
      {value.presetId && <p className="text-ink-500">This preset is designed for 2× upscaling.</p>}
      {info?.parameters.map(parameter => <label key={parameter.name} className="block">{parameter.description}
        {parameter.choices ? <select aria-label={parameter.name} className="ml-2 bg-ink-850" value={value.parameters[parameter.name] ?? parameter.default} onChange={e => onChange({ ...value, parameters: { ...value.parameters, [parameter.name]: Number(e.target.value) } })}>{parameter.choices.map((choice, index) => <option key={index} value={index}>{choice}</option>)}</select> : parameter.type === 'bool'
          ? <input aria-label={parameter.name} type="checkbox" className="ml-2" checked={!!(value.parameters[parameter.name] ?? parameter.default)} onChange={e => onChange({ ...value, parameters: { ...value.parameters, [parameter.name]: e.target.checked ? 1 : 0 } })} />
          : <input aria-label={parameter.name} type="number" className="ml-2 w-24 bg-ink-850" min={parameter.minimum} max={parameter.maximum} step={parameter.type === 'float' ? 'any' : 1} value={value.parameters[parameter.name] ?? parameter.default} onChange={e => {
            const number = Number(e.target.value);
            if (Number.isFinite(number)) onChange({ ...value, parameters: { ...value.parameters, [parameter.name]: number } });
          }} />}
      </label>)}
      {!!info?.parameters.length && <button type="button" className="text-accent-400" onClick={() => onChange({ ...value, parameters: Object.fromEntries(info.parameters.map(p => [p.name, p.default])) })}>Reset shader parameters</button>}
    </>}
    {error && <p role="alert" className="text-bad-400">{error}</p>}
  </fieldset>;
}
