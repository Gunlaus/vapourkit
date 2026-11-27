import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

const control = vi.hoisted(() => ({ failDownload: false, failPublish: false, download: vi.fn() }));
vi.mock('./constants', async () => {
  const os = await import('os'), path = await import('path');
  return { PATHS: { APP_DATA: path.join(os.tmpdir(), `vk-native-runtime-${process.pid}`) } };
});
vi.mock('fs/promises', () => ({ statfs: async () => ({ bavail: 20, bsize: 1024 ** 3 }) }));
vi.mock('child_process', () => ({ spawn: () => {
  const proc = Object.assign(new EventEmitter(), { kill: vi.fn() });
  setImmediate(() => proc.emit('close', 0)); return proc;
} }));
vi.mock('fs-extra', async importOriginal => {
  const actual = await importOriginal<typeof import('fs-extra')>();
  const api = ('default' in actual ? actual.default : actual) as typeof import('fs-extra');
  return { ...api, stat: async (source: string) => {
    const value = await api.stat(source);
    if (source.endsWith('.7z')) value.size = source.includes('onnx_dlls') ? 1872359145 : 284319314;
    return value;
  }, move: async (source: string, dest: string, options?: object) => {
    if (control.failPublish && source.includes('.stage-') && source.endsWith('runtime')) throw new Error('publication failed');
    return api.move(source, dest, options);
  } };
});
vi.mock('./download', () => ({ downloadToFile: async (url: string, destination: string, options: { expectedSha256: string }) => {
  control.download(url, options.expectedSha256);
  if (control.failDownload) throw new Error('checksum failed');
  await fs.writeFile(destination, 'synthetic archive'); // Metadata is mocked; no large files or payload download.
} }));
vi.mock('./archive', () => ({ extract7z: async (archive: string, dir: string) => {
  const nested = path.join(dir, 'upstream-package'); await fs.ensureDir(nested);
  const names = archive.includes('onnx_dlls') ? ['onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'onnxruntime_providers_cuda.dll', 'onnxruntime_providers_tensorrt.dll', 'nvinfer_10.dll'] : ['NVEncC64.exe'];
  for (const name of names) await fs.writeFile(path.join(nested, name), 'verified fixture');
} }));
import { acquireNvencRuntime, clearNvencEngineCache, installNvencRuntime, nvencRuntimeStatus, NVENC_ASSETS } from './nvencRuntime';
const root = path.join(os.tmpdir(), `vk-native-runtime-${process.pid}`);
const executable = path.join(root, 'nvencc', '9.41', 'NVEncC64.exe');
beforeEach(async () => { await fs.remove(root); control.failDownload = false; control.failPublish = false; control.download.mockClear(); });
afterAll(async () => { await fs.remove(root); });

describe('private native runtime installation', () => {
  it('passes pinned hashes to downloads, publishes a complete private runtime and cleans stages', async () => {
    const installed = await installNvencRuntime('win32', 'x64');
    expect(installed.installed).toBe(true); expect(installed.busy).toBe(false);
    expect(control.download.mock.calls.map(c => c[1])).toEqual(NVENC_ASSETS.map(a => a.sha256));
    expect(await fs.readFile(executable, 'utf8')).toBe('verified fixture');
    expect((await fs.readdir(path.dirname(path.dirname(executable)))).some(n => n.startsWith('.stage-'))).toBe(false);
  });
  it('keeps an existing install on download or publication failure', async () => {
    await installNvencRuntime('win32', 'x64'); await fs.writeFile(executable, 'old working executable');
    control.failDownload = true;
    await expect(installNvencRuntime('win32', 'x64')).rejects.toThrow('checksum failed');
    expect(await fs.readFile(executable, 'utf8')).toBe('old working executable');
    control.failDownload = false; control.failPublish = true;
    await expect(installNvencRuntime('win32', 'x64')).rejects.toThrow('publication failed');
    expect(await fs.readFile(executable, 'utf8')).toBe('old working executable');
    expect((await nvencRuntimeStatus()).busy).toBe(false);
  });
  it('refuses repair while a runtime lease is active and releases idempotently', async () => {
    await installNvencRuntime('win32', 'x64');
    const release = await acquireNvencRuntime();
    await expect(installNvencRuntime('win32', 'x64')).rejects.toThrow(/Finish the current/);
    release(); release();
    await expect(installNvencRuntime('win32', 'x64')).resolves.toMatchObject({ installed: true });
  });
  it('explains unsupported platforms before starting a download', async () => {
    await expect(installNvencRuntime('linux', 'x64')).rejects.toThrow(/Windows x64/);
    expect(control.download).not.toHaveBeenCalled();
  });
  it('resets only the native engine cache and refuses to reset during a render', async () => {
    await installNvencRuntime('win32', 'x64');
    const cache = path.join(root, 'nvencc', 'engine-cache');
    const model = path.join(root, 'models', 'original.onnx');
    await fs.outputFile(path.join(cache, 'cached.engine'), 'cached');
    await fs.outputFile(model, 'original');
    const release = await acquireNvencRuntime();
    await expect(clearNvencEngineCache()).rejects.toThrow(/Finish the current/);
    expect(await fs.pathExists(path.join(cache, 'cached.engine'))).toBe(true);
    release();
    await clearNvencEngineCache();
    expect(await fs.readdir(cache)).toEqual([]);
    expect(await fs.readFile(model, 'utf8')).toBe('original');
    expect(await fs.readFile(executable, 'utf8')).toBe('verified fixture');
  });
});
