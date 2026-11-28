import { useEffect, useState } from 'react';
import type { RtxRuntimeStatus } from '../../electron/rtxTypes';

export function RtxRuntimePanel() {
  const [runtime, setRuntime] = useState<RtxRuntimeStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const poll = () => window.electronAPI.getRtxRuntimeStatus().then(value => {
      if (active) setRuntime(value);
    }).catch(err => { if (active) setError(String(err)); });
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  if (!runtime?.supported) return null;
  return <div className="space-y-2 border border-ink-700 p-2">
    <strong>TensorRT-RTX inference (experimental)</strong>
    <p>Select TensorRT-RTX after installation. Engines compile on first use.</p>
    <button type="button" disabled={runtime.busy || runtime.installed} className="text-accent-400 disabled:opacity-50" onClick={() => {
      setError(''); setRuntime({ ...runtime, busy: true });
      void window.electronAPI.installRtxRuntime().then(setRuntime).catch(err => setError(String(err)));
    }}>{runtime.busy ? 'Installing TensorRT-RTX…' : runtime.installed ? 'TensorRT-RTX installed' : 'Install optional TensorRT-RTX backend'}</button>
    {runtime.message && <p role="status">{runtime.message}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
