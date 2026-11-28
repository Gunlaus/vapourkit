import { useState } from 'react';
import { Edit3 } from 'lucide-react';
import { ModalShell } from './ModalShell';
import type { ShaderLibraryEntry } from '../../electron/shaderTypes';
const input = 'w-full bg-ink-850 border border-ink-700 rounded px-2 py-1.5 text-xs';
export function ShaderEditDialog({ entry, onClose, onSaved }: { entry: ShaderLibraryEntry; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(entry), [saving, setSaving] = useState(false), [error, setError] = useState(''), [showCode, setShowCode] = useState(false);
  return <ModalShell title={entry.id ? 'Edit shader' : 'Add GLSL shader'} icon={Edit3} layer={60} onClose={onClose} closeDisabled={saving} className="w-[720px] max-w-[95vw] max-h-[90vh] flex flex-col">
    <div className="p-4 space-y-3 overflow-y-auto text-xs">
      <label className="block">Name<input aria-label="Shader name" autoFocus className={input} value={value.name} maxLength={200} onChange={e => setValue({ ...value, name: e.target.value })} /></label>
      <label className="block">Description (optional)<textarea aria-label="Shader description" className={input} rows={2} value={value.description} onChange={e => setValue({ ...value, description: e.target.value })} /></label>
      <label className="block">Categories (comma-separated)<input aria-label="Shader categories" className={input} value={value.categories.join(', ')} onChange={e => setValue({ ...value, categories: e.target.value.split(',').map(v => v.trim()) })} /></label>
      <label className="block">Default output scale<select aria-label="Default shader scale" className={input} value={value.scale} onChange={e => setValue({ ...value, scale: Number(e.target.value) })}>{[1,2,3,4].map(n => <option key={n} value={n}>{n}×</option>)}</select></label>
      <button type="button" className="text-accent-400" onClick={() => setShowCode(!showCode)}>{showCode ? 'Hide shader code' : 'Edit shader code'}</button>
      {showCode && <textarea aria-label="GLSL shader code" spellCheck={false} className={input + ' font-mono'} rows={14} value={value.code ?? ''} onChange={e => setValue({ ...value, code: e.target.value })} />}
      <p className="text-ink-500">Saves a copy inside Vapourkit. Library edits affect future selections; choose the edited shader again to update an existing step.</p>
      {error && <p role="alert" className="text-bad-400">{error}</p>}
    </div>
    <div className="flex justify-end gap-3 p-3 border-t border-ink-800">
      <button type="button" disabled={saving} onClick={onClose}>Cancel</button>
      <button type="button" disabled={saving || !value.name.trim()} className="text-accent-400" onClick={() => {
        setSaving(true); setError('');
        void window.electronAPI.saveShaderLibrary(value).then(() => { onSaved(); onClose(); }).catch(e => setError(String(e))).finally(() => setSaving(false));
      }}>{saving ? 'Saving…' : 'Save shader'}</button>
    </div>
  </ModalShell>;
}
