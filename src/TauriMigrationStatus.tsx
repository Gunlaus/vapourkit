import { useEffect, useRef, useState } from 'react';
import NativeBatchQueue from './NativeBatchQueue';
import NativeMediaPreview from './NativeMediaPreview';
import { nativeHost, type EncodeOptions, type EncodeEvent, type MediaInfo, type NativeProfile, type EncoderCheck } from './native/host';

const encoders = ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'av1_nvenc'];
const softwarePresets = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
const initialOptions: EncodeOptions = { encoder: 'libx264', quality: 20, preset: 'medium', audioTracks: [], subtitleTracks: [], copyAudio: false };
const inputStyle = 'block w-full rounded bg-zinc-900 border border-zinc-700 p-2 mt-1';
const buttonStyle = 'rounded bg-zinc-700 px-3 py-2 disabled:opacity-50';

export default function TauriMigrationStatus() {
  const [host, setHost] = useState<Awaited<ReturnType<typeof nativeHost.status>> | null>(null);
  const [tools, setTools] = useState<Awaited<ReturnType<typeof nativeHost.discover>>[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [probing, setProbing] = useState(false);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [queueRunning, setQueueRunning] = useState(false);
  const [options, setOptions] = useState(initialOptions);
  const [profiles, setProfiles] = useState<NativeProfile[]>([]);
  const [profileName, setProfileName] = useState('');
  const [script, setScript] = useState('');
  const [useScript, setUseScript] = useState(false);
  const [scriptResult, setScriptResult] = useState('');
  const [checkingScript, setCheckingScript] = useState(false);
  const [preflight, setPreflight] = useState<Awaited<ReturnType<typeof nativeHost.preflight>> | null>(null);
  const [encoderCheck, setEncoderCheck] = useState<EncoderCheck | null>(null);
  const [checkingEncoder, setCheckingEncoder] = useState(false);
  const [progress, setProgress] = useState<EncodeEvent | null>(null);
  const inspection = useRef(0);
  const busy = encoding || queueRunning;
  const nvenc = options.encoder.endsWith('_nvenc');

  useEffect(() => {
    let active = true;
    const stops: (() => void)[] = [];
    let progressReceived = false;
    const register = (promise: Promise<() => void>) => {
      void promise.then(stop => { if (active) stops.push(stop); else stop(); }).catch(e => { if (active) setError(String(e)); });
    };
    register(nativeHost.onProgress(event => {
      if (!active) return;
      progressReceived = true;
      setProgress(event);
      setEncoding(event.status === 'preparing' || event.status === 'running');
    }));
    register(nativeHost.onCloseBlocked(message => { if (active) setError(message); }));
    void nativeHost.status().then(value => { if (active) setHost(value); }).catch(e => { if (active) setError(String(e)); });
    void nativeHost.processing().then(value => { if (active && !progressReceived) setEncoding(value); }).catch(e => { if (active) setError(String(e)); });
    void nativeHost.profiles().then(value => { if (active) setProfiles(value); }).catch(e => { if (active) setError(String(e)); });
    void nativeHost.loadSettings().then(settings => {
      if (active && encoders.includes(settings.preferredVideoEncoder)) {
        const encoder = settings.preferredVideoEncoder;
        setOptions(old => ({ ...old, encoder, preset: encoder.endsWith('_nvenc') ? 'p5' : 'medium' }));
      }
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; stops.forEach(stop => stop()); };
  }, []);

  function changeInput(path: string) {
    inspection.current++;
    setInput(path); setMedia(null);
    setOptions(old => ({ ...old, audioTracks: [], subtitleTracks: [] }));
  }
  async function pick(kind: 'video' | 'script' | 'output') {
    try {
      const selected = await (kind === 'output' ? nativeHost.pickOutput() : nativeHost.pick(kind));
      if (selected === null) return;
      if (kind === 'video') changeInput(selected);
      else if (kind === 'script') { setScript(selected); setScriptResult(''); }
      else setOutput(selected);
    } catch (e) { setError(String(e)); }
  }
  async function inspect() {
    const current = ++inspection.current;
    setError('');
    try {
      const info = await nativeHost.inspect(input);
      if (inspection.current !== current) return;
      setMedia(info);
      setOptions(old => ({ ...old, audioTracks: info.streams.filter(s => s.codecType === 'audio').map(s => s.index), subtitleTracks: [] }));
    } catch (e) { if (inspection.current === current) setError(String(e)); }
  }
  async function encode() {
    setError(''); setProgress(null); setEncoding(true);
    try {
      const status = await nativeHost.encode({ input, output, options, script: useScript ? script : null });
      setNotice(status === 'completed' ? 'Output saved successfully.' : 'Encoding cancelled. No output published.');
    } catch (e) { setError(String(e)); }
    finally { setEncoding(false); }
  }
  async function refreshTools() {
    setProbing(true); setError('');
    try { setTools(await Promise.all(['ffmpeg', 'ffprobe', 'vspipe', 'python'].map(nativeHost.discover))); }
    catch (e) { setError(String(e)); }
    finally { setProbing(false); }
  }
  async function saveProfile() {
    try { await nativeHost.saveProfile({ name: profileName, options }); setProfiles(await nativeHost.profiles()); }
    catch (e) { setError(String(e)); }
  }
  async function deleteProfile() {
    try { await nativeHost.deleteProfile(profileName); setProfiles(await nativeHost.profiles()); }
    catch (e) { setError(String(e)); }
  }
  async function checkScript() {
    setCheckingScript(true); setScriptResult('');
    try { const result = await nativeHost.checkScript(script); setScriptResult(`${result.valid ? 'Valid' : 'Failed'}: ${result.details}`); }
    catch (e) { setScriptResult(String(e)); }
    finally { setCheckingScript(false); }
  }
  async function checkEncoder() {
    setCheckingEncoder(true); setError('');
    try { setEncoderCheck(await nativeHost.checkEncoder(options.encoder)); }
    catch (e) { setError(String(e)); }
    finally { setCheckingEncoder(false); }
  }
  async function saveDefaults() {
    try {
      const lastInputDirectory = input.replace(/[\\/][^\\/]*$/, '');
      await nativeHost.saveSettings({ lastInputDirectory, preferredVideoEncoder: options.encoder });
      setNotice('Defaults saved.');
    } catch (e) { setError(String(e)); }
  }
  function toggleTrack(index: number, kind: 'audioTracks' | 'subtitleTracks') {
    setOptions(old => ({ ...old, [kind]: old[kind].includes(index) ? old[kind].filter(i => i !== index) : [...old[kind], index] }));
  }

  return <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
    <div className="max-w-4xl mx-auto space-y-6">
      <h1 className="text-3xl font-semibold">Vapourkit native processing preview</h1>
      <p className="text-zinc-400">Encode video or render a trusted VapourSynth script with the Rust host. The full graphical filter, AI model, and setup workflows are still being migrated; use the Electron application for those features.</p>
      <p className="text-sm">Host: {host ? `${host.host} / ${host.platform}` : 'Connecting...'}</p>
      {error && <p role="alert" className="text-red-400 whitespace-pre-wrap break-words">{error}</p>}
      {notice && <p role="status" className="text-emerald-400">{notice}</p>}
      <details className="border border-zinc-700 rounded p-3">
        <summary>Native runtime diagnostics</summary>
        <div className="space-y-3 mt-3">
          <button className={buttonStyle} disabled={probing || busy} onClick={() => void refreshTools()}>{probing ? 'Checking...' : 'Locate native tools'}</button>
          <ul>{tools.map(tool => <li key={tool.tool} className="py-2 break-all"><strong>{tool.tool}: {tool.available ? 'Available' : 'Unavailable'}</strong><p>{tool.detail}</p><p className="text-xs text-zinc-400">{tool.source}: {tool.path}</p></li>)}</ul>
          <button className={buttonStyle} disabled={busy} onClick={() => void nativeHost.preflight().then(setPreflight).catch(e => setError(String(e)))}>Check VapourSynth runtime</button>
          {preflight && <p className="text-sm break-all">{preflight.available ? 'Available' : 'Unavailable'}: {preflight.detail} ({preflight.python})</p>}
        </div>
      </details>
      <section className="border border-zinc-700 rounded p-4 space-y-4">
        <h2 className="text-xl font-semibold">Processing settings</h2>
        <fieldset disabled={busy} className="space-y-4 disabled:opacity-75">
          <label className="block">Input video<div className="flex items-end gap-2"><input className={inputStyle} value={input} onChange={e => changeInput(e.target.value)} placeholder="Absolute path to a source video" /><button className={buttonStyle} type="button" onClick={() => void pick('video')}>Browse</button></div></label>
          <label className="block">Output video<div className="flex items-end gap-2"><input className={inputStyle} value={output} onChange={e => setOutput(e.target.value)} placeholder="New .mkv, .mp4, or .mov file" /><button className={buttonStyle} type="button" onClick={() => void pick('output')}>Browse</button></div></label>
          <p className="text-sm text-zinc-400">Existing files are never overwritten. Failed or cancelled renders do not publish a partial output.</p>
          <div className="grid grid-cols-2 gap-3">
            <label>Video encoder<select className={inputStyle} value={options.encoder} onChange={e => { const encoder = e.target.value; setEncoderCheck(null); setOptions(old => ({ ...old, encoder, preset: encoder.endsWith('_nvenc') ? 'p5' : 'medium' })); }}>{encoders.map(value => <option key={value}>{value}</option>)}</select></label>
            <label>Preset<select className={inputStyle} value={options.preset} onChange={e => setOptions(old => ({ ...old, preset: e.target.value }))}>{(nvenc ? ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] : softwarePresets).map(value => <option key={value}>{value}</option>)}</select></label>
            <label>Quality ({nvenc ? 'CQ' : 'CRF'}): {options.quality}<input className="block w-full" type="range" min="0" max="51" value={options.quality} onChange={e => setOptions(old => ({ ...old, quality: Number(e.target.value) }))} /></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={options.copyAudio} onChange={e => setOptions(old => ({ ...old, copyAudio: e.target.checked }))} /> Copy selected audio</label>
          </div>
          <button className={buttonStyle} disabled={checkingEncoder} type="button" onClick={() => void checkEncoder()}>{checkingEncoder ? 'Testing encoder...' : 'Test selected encoder'}</button>
          {encoderCheck && encoderCheck.encoder === options.encoder && <p className={`text-sm whitespace-pre-wrap ${encoderCheck.available ? 'text-emerald-400' : 'text-red-400'}`}>{encoderCheck.encoder}: {encoderCheck.detail}</p>}
          <div className="rounded border border-zinc-700 p-3 space-y-2">
            <label className="flex gap-2 items-center"><input type="checkbox" checked={useScript} onChange={e => setUseScript(e.target.checked)} /> Render a trusted VapourSynth script</label>
            {useScript && <>
              <label className="block">VapourSynth script<div className="flex items-end gap-2"><input className={inputStyle} value={script} onChange={e => { setScript(e.target.value); setScriptResult(''); }} placeholder="Absolute path to a .vpy script" /><button className={buttonStyle} type="button" onClick={() => void pick('script')}>Browse</button></div></label>
              <p className="text-sm text-zinc-400">Validation and rendering execute the script and its imports. Use scripts you trust. Output 0 supplies video; selected audio and subtitles come from the source video. The script must preserve their timing.</p>
              <button className={buttonStyle} type="button" disabled={!script || checkingScript} onClick={() => void checkScript()}>{checkingScript ? 'Validating...' : 'Validate script'}</button>
              {scriptResult && <pre className="text-xs whitespace-pre-wrap break-all">{scriptResult}</pre>}
            </>}
          </div>
          <div className="flex flex-wrap gap-2">
            <input aria-label="Profile name" className="bg-zinc-900 border border-zinc-700 rounded p-2" placeholder="Profile_Name" value={profileName} onChange={e => setProfileName(e.target.value)} />
            <button className={buttonStyle} type="button" disabled={!profileName} onClick={() => void saveProfile()}>Save profile</button>
            <button className={buttonStyle} type="button" disabled={!profileName} onClick={() => void deleteProfile()}>Delete profile</button>
            <button className={buttonStyle} type="button" onClick={() => void saveDefaults()}>Save defaults</button>
          </div>
          <div className="flex flex-wrap gap-2">{profiles.map(profile => <button className={buttonStyle} key={profile.name} type="button" onClick={() => { setProfileName(profile.name); setOptions(profile.options); setEncoderCheck(null); }}>{profile.name}</button>)}</div>
          <button className={buttonStyle} type="button" disabled={!input} onClick={() => void inspect()}>Inspect tracks</button>
          {media && <div className="space-y-2"><p>Format: {media.formatName ?? 'Unknown'} | Duration: {media.durationSeconds ?? 'Unknown'} seconds</p>
            <ul className="space-y-1">{media.streams.map(stream => <li key={stream.index}>{stream.codecType === 'audio' || stream.codecType === 'subtitle' ?
              <label className="flex gap-2 items-center"><input type="checkbox" checked={options[stream.codecType === 'audio' ? 'audioTracks' : 'subtitleTracks'].includes(stream.index)} onChange={() => toggleTrack(stream.index, stream.codecType === 'audio' ? 'audioTracks' : 'subtitleTracks')} />#{stream.index}: {stream.codecType} / {stream.codecName} {stream.language} {stream.title}</label> : <span>#{stream.index}: {stream.codecType} / {stream.codecName} {stream.width ? `${stream.width}×${stream.height}` : ''}</span>}</li>)}</ul>
          </div>}
        </fieldset>
        <div className="flex gap-3">
          <button className="rounded bg-indigo-600 px-4 py-2 disabled:opacity-50" disabled={!input || !output || busy || checkingScript || checkingEncoder || (useScript && !script) || (encoderCheck?.encoder === options.encoder && !encoderCheck.available)} onClick={() => void encode()}>Start encoding</button>
          <button className="rounded bg-red-700 px-4 py-2 disabled:opacity-50" disabled={!encoding || queueRunning} onClick={() => void nativeHost.cancel().catch(e => setError(String(e)))}>Cancel encoding</button>
        </div>
        {progress && <p role="status" className="text-sm whitespace-pre-wrap break-words">{progress.status}: {progress.detail} {progress.outTimeMs !== null ? `| ${(progress.outTimeMs / 1000).toFixed(1)}s` : ''} {progress.speed}</p>}
        <NativeMediaPreview path={input} />
      </section>
      <NativeBatchQueue options={options} script={useScript ? script : null} busy={busy} onRunningChange={setQueueRunning} />
      <NativeMediaPreview path={output} />
    </div>
  </main>;
}
