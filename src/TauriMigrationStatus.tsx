import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import NativeBatchQueue from './NativeBatchQueue';

type HostStatus = { host: string; migrationStage: string; platform: string };
type DependencyProbe = { tool: string; available: boolean; detail: string; source: string; path: string };
type MediaInfo = { path: string; durationSeconds: number | null; formatName: string | null; streams: { index: number; codecType: string; codecName: string | null; language: string | null }[] };
type EncodeEvent = { status: string; detail: string; outTimeMs: number | null; speed: string | null };
type EncodeOptions = { encoder: string; quality: number; preset: string; audioTracks: number[]; subtitleTracks: number[]; copyAudio: boolean };
type NativeProfile = { name: string; options: EncodeOptions };
type VsPreflight = { available: boolean; python: string; version: string; detail: string };
const tools = ['ffmpeg', 'ffprobe', 'vspipe', 'python'] as const;

export default function TauriMigrationStatus() {
  const [host, setHost] = useState<HostStatus | null>(null);
  const [results, setResults] = useState<DependencyProbe[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [profiles, setProfiles] = useState<NativeProfile[]>([]);
  const [profileName, setProfileName] = useState('');
  const [vsStatus, setVsStatus] = useState<VsPreflight | null>(null);
  const [scriptPath, setScriptPath] = useState('');
  const [scriptResult, setScriptResult] = useState('');
  const [encoder, setEncoder] = useState('libx264');
  const [quality, setQuality] = useState(20);
  const [preset, setPreset] = useState('medium');
  const [audioTracks, setAudioTracks] = useState<number[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<number[]>([]);
  const [copyAudio, setCopyAudio] = useState(false);
  const nvenc = encoder.endsWith('_nvenc');
  function chooseEncoder(next: string) {
    setEncoder(next);
    setPreset(next.endsWith('_nvenc') ? 'p5' : 'medium');
  }
  function toggleTrack(index: number, type: 'audio' | 'subtitle') {
    const update = (old: number[]) => old.includes(index) ? old.filter(i => i !== index) : [...old, index];
    if (type === 'audio') setAudioTracks(update);
    else setSubtitleTracks(update);
  }
  const [progress, setProgress] = useState<EncodeEvent | null>(null);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void listen<EncodeEvent>('native-encode-progress', event => {
      if (active) setProgress(event.payload);
    }).then(unlisten => {
      if (active) stop = unlisten;
      else unlisten();
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; stop?.(); };
  }, []);

  async function refreshProfiles() {
    try { setProfiles(await invoke<NativeProfile[]>('list_native_profiles')); }
    catch (e) { setError(String(e)); }
  }
  useEffect(() => { void refreshProfiles(); }, []);
  async function saveProfile() {
    try {
      await invoke('save_native_profile', { profile: { name: profileName, options: { encoder, quality, preset, audioTracks, subtitleTracks, copyAudio } } });
      await refreshProfiles();
    } catch (e) { setError(String(e)); }
  }
  async function removeProfile() {
    try {
      await invoke('delete_native_profile', { name: profileName });
      await refreshProfiles();
    } catch (e) { setError(String(e)); }
  }
  function applyProfile(profile: NativeProfile) {
    setProfileName(profile.name);
    setEncoder(profile.options.encoder);
    setQuality(profile.options.quality);
    setPreset(profile.options.preset);
    setAudioTracks(profile.options.audioTracks);
    setSubtitleTracks(profile.options.subtitleTracks);
    setCopyAudio(profile.options.copyAudio);
  }

  async function inspect() {
    setError('');
    setMedia(null);
    try {
      const info = await invoke<MediaInfo>('inspect_media', { path: input });
      setMedia(info);
      setAudioTracks(info.streams.filter(s => s.codecType === 'audio').map(s => s.index));
      setSubtitleTracks([]);
    } catch (e) { setError(String(e)); }
  }

  async function encode() {
    setError('');
    setProgress(null);
    setEncoding(true);
    try {
      await invoke('encode_sample', { input, output, options: { encoder, quality, preset, audioTracks, subtitleTracks, copyAudio } });
    } catch (e) { setError(String(e)); }
    finally { setEncoding(false); }
  }


  useEffect(() => {
    void invoke<HostStatus>('host_status').then(setHost).catch((e: unknown) => setError(String(e)));
  }, []);

  async function runProbes() {
    setBusy(true);
    setError('');
    try {
      const next = await Promise.all(tools.map(tool => invoke<DependencyProbe>('discover_dependency', { tool })));
      setResults(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-3xl font-semibold">Vapourkit: Tauri migration preview</h1>
        <p className="text-zinc-400">This is an isolated Rust host diagnostic screen, not the video processing application. Continue using Electron for encoding and preview.</p>
        <p>Host: {host ? `${host.host} / ${host.platform} / ${host.migrationStage}` : 'Connecting...'}</p>
        <button className="rounded bg-indigo-600 px-4 py-2 disabled:opacity-50" disabled={busy} onClick={() => void runProbes()}>
          {busy ? 'Checking tools...' : 'Check native tools'}
        </button>
        {error && <p role="alert" className="text-red-400">{error}</p>}
        <ul className="space-y-3">
          {results.map(result => (
            <li key={result.tool} className="rounded border border-zinc-700 p-4">
              <strong>{result.tool}: {result.available ? 'Available' : 'Unavailable'}</strong>
              <p className="text-zinc-400 break-words">{result.detail}</p>
              <p className="text-xs text-zinc-500 break-all">{result.source}: {result.path || 'not found'}</p>
            </li>
          ))}
        </ul>
        <section className="border-t border-zinc-700 pt-6 space-y-3">
          <h2 className="text-xl font-semibold">Experimental native video test</h2>
          <p className="text-zinc-400">Enter absolute paths to a small local video and a new output file. Encodes H.264/AAC without VapourSynth filters. Existing outputs are never overwritten.</p>
          <label className="block">Input video
            <input aria-label="Input video" className="block w-full rounded bg-zinc-900 border border-zinc-700 p-2 mt-1" value={input} onChange={e => setInput(e.target.value)} placeholder="C:\\Videos\\test.mkv" />
          </label>
          <label className="block">Output video
            <input aria-label="Output video" className="block w-full rounded bg-zinc-900 border border-zinc-700 p-2 mt-1" value={output} onChange={e => setOutput(e.target.value)} placeholder="C:\\Videos\\test-output.mp4" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label>Video encoder
              <select className="block w-full bg-zinc-900 border border-zinc-700 p-2" value={encoder} onChange={e => chooseEncoder(e.target.value)}>
                {['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'av1_nvenc'].map(v => <option key={v}>{v}</option>)}
              </select>
            </label>
            <label>Preset
              <select className="block w-full bg-zinc-900 border border-zinc-700 p-2" value={preset} onChange={e => setPreset(e.target.value)}>
                {(nvenc ? ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] : ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']).map(v => <option key={v}>{v}</option>)}
              </select>
            </label>
            <label>Quality ({nvenc ? 'CQ' : 'CRF'}): {quality}
              <input className="block w-full" type="range" min="0" max="51" value={quality} onChange={e => setQuality(Number(e.target.value))} />
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={copyAudio} onChange={e => setCopyAudio(e.target.checked)} /> Copy selected audio without re-encoding</label>
          </div>
          <div className="rounded border border-zinc-700 p-3 space-y-2">
            <h3 className="font-semibold">Encoding profiles</h3>
            <div className="flex flex-wrap gap-2">
              <input aria-label="Profile name" className="bg-zinc-900 border border-zinc-700 rounded p-2" placeholder="Profile_Name" value={profileName} onChange={e => setProfileName(e.target.value)} />
              <button className="bg-zinc-700 rounded px-3" onClick={() => void saveProfile()}>Save profile</button>
              <button className="bg-zinc-700 rounded px-3" onClick={() => void removeProfile()}>Delete profile</button>
            </div>
            <div className="flex flex-wrap gap-2">{profiles.map(p => <button key={p.name} className="rounded border border-zinc-600 px-3 py-1" onClick={() => applyProfile(p)}>{p.name}</button>)}</div>
            <button className="bg-zinc-700 rounded px-3 py-2" onClick={() => void invoke<VsPreflight>('vapoursynth_preflight').then(setVsStatus).catch(e => setError(String(e)))}>Check VapourSynth runtime</button>
            {vsStatus && <p className="text-sm break-words">{vsStatus.available ? 'Available' : 'Unavailable'}: {vsStatus.detail} ({vsStatus.python})</p>}
            <label className="block text-sm">Trusted VapourSynth script (.vpy)
              <input className="block w-full bg-zinc-900 border border-zinc-700 rounded p-2 mt-1" value={scriptPath} onChange={e => setScriptPath(e.target.value)} placeholder="Absolute path to trusted .vpy script" />
            </label>
            <button className="bg-zinc-700 rounded px-3 py-2" disabled={!scriptPath} onClick={() => void invoke<{valid:boolean;details:string}>('inspect_vapoursynth_script', {script:scriptPath}).then(r => setScriptResult(`${r.valid ? 'Valid' : 'Failed'}: ${r.details}`)).catch(e => setScriptResult(String(e)))}>Validate script</button>
            <p className="text-xs text-zinc-400">Validation executes the selected script through VSPipe. Only use scripts you trust.</p>
            {scriptResult && <pre className="text-xs whitespace-pre-wrap break-all">{scriptResult}</pre>}
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="rounded bg-zinc-700 px-4 py-2" onClick={() => void inspect()} disabled={!input || encoding}>Inspect tracks</button>
            <button className="rounded bg-indigo-600 px-4 py-2 disabled:opacity-50" onClick={() => void encode()} disabled={!input || !output || encoding}>Start test encode</button>
            <button className="rounded bg-red-700 px-4 py-2 disabled:opacity-50" onClick={() => void invoke('cancel_sample').catch(e => setError(String(e)))} disabled={!encoding}>Cancel</button>
          </div>
          {media && <div className="rounded border border-zinc-700 p-3">
            <p>Format: {media.formatName || 'Unknown'} | Duration: {media.durationSeconds ?? 'Unknown'} seconds</p>
            <ul className="space-y-1">{media.streams.map(stream => <li key={stream.index}>
              {stream.codecType === 'audio' || stream.codecType === 'subtitle' ?
                <label className="flex gap-2 items-center"><input type="checkbox" checked={(stream.codecType === 'audio' ? audioTracks : subtitleTracks).includes(stream.index)} onChange={() => toggleTrack(stream.index, stream.codecType as 'audio' | 'subtitle')} />
                  #{stream.index}: {stream.codecType} / {stream.codecName || 'unknown'} {stream.language || ''}</label> :
                <span>#{stream.index}: {stream.codecType} / {stream.codecName || 'unknown'}</span>}
            </li>)}</ul>
          </div>}
          {progress && <p role="status">{progress.status}: {progress.detail} {progress.outTimeMs !== null ? `| ${(progress.outTimeMs / 1000).toFixed(1)}s` : ''} {progress.speed || ''}</p>}
        </section>
        <NativeBatchQueue options={{ encoder, quality, preset, audioTracks, subtitleTracks, copyAudio }} />
      </div>
    </main>
  );
}
