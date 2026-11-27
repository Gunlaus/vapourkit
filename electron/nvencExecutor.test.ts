import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import type { NvencRequest } from './nvencPlan';

const control = vi.hoisted(() => ({ spawn: vi.fn(), release: vi.fn(), hold: '', missingTracks: false, env: {} as NodeJS.ProcessEnv }));
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => control.spawn(...args) }));
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));
vi.mock('./constants', async () => {
  const os = await import('os'), path = await import('path');
  return { PATHS: { APP_DATA: path.join(os.tmpdir(), `vk-native executor, ${process.pid}`) } };
});
vi.mock('./logger', () => ({ logger: { upscale: vi.fn() } }));
vi.mock('./ffmpegManager', () => ({ FFmpegManager: { getFFprobePath: () => '/ffprobe' } }));
vi.mock('./gpuSelection', () => ({ getGpuChoice: () => undefined, findChosenGpu: vi.fn() }));
vi.mock('./utils', () => ({ fixAsarPath: (p: string) => p, setupVSEnvironment: () => ({}) }));
vi.mock('./nvencRuntime', () => ({ acquireNvencRuntime: async () => control.release, nvencExecutable: () => path.join(root, 'nvencc', '9.41', 'NVEncC64.exe') }));
vi.mock('./processLifecycle', () => ({ createWorkloadSpawnOptions: (o: unknown) => o,
  terminateProcessTree: (proc: EventEmitter) => setImmediate(() => proc.emit('close', 1)),
}));
import { NvencExecutor, parseNativeProgress } from './nvencExecutor';
const root = path.join(os.tmpdir(), `vk-native executor, ${process.pid}`);
const input = path.join(root, 'input.mkv'), output = path.join(root, 'output.mkv'), model = path.join(root, 'model.onnx');
const streams = [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', field_order: 'progressive', nb_frames: '240' },
  { codec_type: 'audio', codec_name: 'aac' }, { codec_type: 'subtitle', codec_name: 'ass' }, { codec_type: 'attachment', codec_name: 'ttf' }];
function request(): NvencRequest { return { inputPath: input, outputPath: output, processingFormat: 'vs.YUV420P8', defaultBackend: 'tensorrt',
  filters: [{ id: 'ai', enabled: true, order: 0, preset: 'AI Model', code: '', filterType: 'aiModel', modelPath: model }],
  encoding: { mode: 'simple', customArgs: '', simple: { codec: 'av1', encoder: 'nvidia', preset: 'p4', quality: 25 } } }; }
beforeEach(async () => {
  await fs.remove(root); await fs.ensureDir(root); await fs.writeFile(input, 'source'); await fs.writeFile(model, 'model');
  control.release.mockClear(); control.spawn.mockReset(); control.hold = ''; control.missingTracks = false;
  control.spawn.mockImplementation((exe: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 12345 });
    const phase = exe === '/ffprobe' ? 'probe' : exe.endsWith('NVEncC64.exe') ? 'encode' : 'prepare';
    if (phase === 'encode') {
      // Reproduce NVEncC 9.41's literal comma-delimited parser and filesystem lookup.
      const modelValue = args[args.indexOf('--vpp-onnx') + 1].split(',').find(p => p.startsWith('model='))!.slice(6);
      expect(path.isAbsolute(modelValue)).toBe(false);
      expect(fs.existsSync(path.resolve(opts.cwd, modelValue))).toBe(true);
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'encoded'); control.env = opts.env; }
    setImmediate(() => {
      if (control.hold === phase) return;
      if (phase === 'probe') {
        const result = args[args.length - 1] === input ? streams : streams.filter(s => !control.missingTracks || s.codec_type === 'video').map(s => s.codec_type === 'video' ? { ...s, codec_name: 'av1', width: 3840, height: 2160 } : s);
        proc.stdout.write(JSON.stringify({ streams: result }));
      } else if (phase === 'prepare') proc.stdout.write(JSON.stringify({ model, inputShape: [1, 3, 'h', 'w'], outputShape: [1, 3, 'h', 'w'] }));
      else proc.stderr.write('onnx: path cuda-zerocopy initialized\n[100.0%] 240 frames: 30.00 fps\nencoded 240 frames, 30.00 fps\n');
      proc.stdout.end(); proc.stderr.end(); proc.emit('close', 0);
    });
    return proc;
  });
});
afterAll(async () => { await fs.remove(root); });

describe('NVEncC native lifecycle', () => {
  it('publishes only after output checks and reports native completion', async () => {
    const send = vi.fn();
    const window = { isDestroyed: () => false, webContents: { send }, setProgressBar: vi.fn() } as unknown as BrowserWindow;
    const executor = new NvencExecutor(window, '/python', 'win32'); const log = vi.fn(); executor.onDiagnostic = log;
    await executor.execute(request(), () => false, () => 'image');
    expect(await fs.readFile(output, 'utf8')).toBe('encoded');
    expect(control.spawn.mock.calls.some(c => c[0].endsWith('NVEncC64.exe'))).toBe(true);
    expect(control.spawn.mock.calls.some(c => c[0].includes('vspipe'))).toBe(false);
    expect(send.mock.calls.some(c => c[0] === 'upscale-progress' && c[1].type === 'complete')).toBe(true);
    expect(log.mock.calls.some(c => c[0].includes('"gpuTensorSharingConfirmed":true'))).toBe(true);
    expect(control.release).toHaveBeenCalledTimes(1);
  });
  it.each(['probe', 'prepare', 'encode'])('cancels during %s and never publishes a partial output', async phase => {
    control.hold = phase;
    const executor = new NvencExecutor(null, '/python', 'win32');
    const run = executor.execute(request(), () => false, () => 'image');
    const assertion = expect(run).rejects.toThrow('Canceled');
    await vi.waitFor(() => expect(control.spawn.mock.calls.some(c => phase === 'probe' ? c[0] === '/ffprobe' : phase === 'prepare' ? c[0] === '/python' : c[0].endsWith('NVEncC64.exe'))).toBe(true));
    executor.cancel(); await assertion;
    expect(await fs.pathExists(output)).toBe(false);
    expect((await fs.readdir(root)).some(n => n.includes('.nvencc-'))).toBe(false);
    expect(control.release).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite an existing output', async () => {
    await fs.writeFile(output, 'original');
    await expect(new NvencExecutor(null, '/python', 'win32').execute(request(), () => false, () => 'image')).rejects.toThrow(/already exists/);
    expect(await fs.readFile(output, 'utf8')).toBe('original'); expect(control.spawn).not.toHaveBeenCalled();
  });
  it('rejects missing copied tracks before publishing', async () => {
    control.missingTracks = true;
    await expect(new NvencExecutor(null, '/python', 'win32').execute(request(), () => false, () => 'image')).rejects.toThrow(/selected audio tracks/);
    expect(await fs.pathExists(output)).toBe(false);
  });
});
describe('NVEncC progress text', () => {
  it('reads CR-style progress and the terminal result', () => {
    expect(parseNativeProgress('[34.5%] 123 frames: 29.97 fps, 1000 kb/s')).toEqual({ frames: 123, fps: 29.97, percentage: 34.5 });
    expect(parseNativeProgress('encoded 240 frames, 30.00 fps, 1000 kbps')).toEqual({ frames: 240, fps: 30, percentage: null });
    expect(parseNativeProgress('TensorRT: building engine…')).toBeNull();
  });
});
