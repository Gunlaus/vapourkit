import * as path from 'path';
import * as fs from 'fs-extra';
import { statfs } from 'fs/promises';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { PATHS } from './constants';
import { downloadToFile } from './download';
import { extract7z } from './archive';
import type { NvencRuntimeStatus } from './nvencTypes';

export const NVENC_VERSION = '9.41';
export const NVENC_ASSETS = [
  { name: 'NVEncC_9.41_x64.7z', url: 'https://github.com/rigaya/NVEnc/releases/download/9.41/NVEncC_9.41_x64.7z', size: 284319314, sha256: '718ce2084d45e56706149bb9cf5d96a5ea697c4c5f75a2f256ebf79918259da2' },
  { name: 'nvenc_vpp_onnx_dlls_20260627.7z', url: 'https://github.com/rigaya/HWEnc-onnx-models/releases/download/20260627/nvenc_vpp_onnx_dlls_20260627.7z', size: 1872359145, sha256: 'ebdfdc855c45e9bee070fa0a79c9240f5477f5dc3bc94e4730dfb7cd4065b144' },
] as const;
const REQUIRED = ['NVEncC64.exe', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'onnxruntime_providers_cuda.dll', 'onnxruntime_providers_tensorrt.dll', 'nvinfer_10.dll'];
let status = { busy: false, progress: 0, message: '' };
let inUse = 0;
const root = () => path.join(PATHS.APP_DATA, 'nvencc', NVENC_VERSION);
export const nvencExecutable = () => path.join(root(), 'NVEncC64.exe');
export async function nvencRuntimeStatus(): Promise<NvencRuntimeStatus> {
  const installed = (await Promise.all(REQUIRED.map(name => fs.pathExists(path.join(root(), name))))).every(Boolean);
  return { ...status, supported: process.platform === 'win32' && process.arch === 'x64', installed, version: NVENC_VERSION, downloadBytes: NVENC_ASSETS.reduce((sum, a) => sum + a.size, 0) };
}
export async function acquireNvencRuntime(): Promise<() => void> {
  if (status.busy) throw new Error('NVEncC installation is still running. Wait for it to finish.');
  inUse++;
  try {
    if (!(await nvencRuntimeStatus()).installed) throw new Error('Install the optional NVEncC GPU backend in Settings → Processing first.');
    let released = false;
    return () => { if (!released) { released = true; inUse--; } };
  } catch (error) { inUse--; throw error; }
}
export async function clearNvencEngineCache(): Promise<void> {
  if (status.busy || inUse) throw new Error('Finish the current NVEncC install or render before resetting its engine cache.');
  const cache = path.join(PATHS.APP_DATA, 'nvencc', 'engine-cache');
  status.busy = true;
  try { await fs.remove(cache); await fs.ensureDir(cache); }
  finally { status.busy = false; }
}
export async function findRuntimeFile(dir: string, name: string, depth = 0): Promise<string> {
  if (await fs.pathExists(path.join(dir, name))) return path.join(dir, name);
  if (depth < 5) for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const result = await findRuntimeFile(path.join(dir, entry.name), name, depth + 1);
    if (result) return result;
  }
  return '';
}

function smokeExecutable(executable: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, ['--version'], { windowsHide: true, cwd: path.dirname(executable), stdio: 'ignore' });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('NVEncC --version timed out.')); }, 15000);
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`NVEncC --version exited with code ${code}.`)); });
  });
}

/** Explicit optional install. Private versioned folder; never modifies Python, PATH or existing inference DLLs. */
export async function installNvencRuntime(platform: NodeJS.Platform = process.platform, architecture = process.arch): Promise<NvencRuntimeStatus> {
  if (platform !== 'win32' || architecture !== 'x64') throw new Error('The experimental NVEncC installer currently supports Windows x64 only.');
  if (status.busy || inUse) throw new Error('Finish the current NVEncC install or render before reinstalling.');
  status = { busy: true, progress: 0, message: 'Preparing optional backend…' };
  const parent = path.dirname(root());
  const stage = path.join(parent, '.stage-' + randomUUID());
  const backup = root() + '.old-' + randomUUID();
  let movedPrevious = false;
  try {
    await fs.ensureDir(parent);
    const space = await statfs(parent);
    if (space.bavail * space.bsize < 16 * 1024 ** 3) throw new Error('NVEncC installation requires 16 GiB of free disk space for downloads, extraction and publication.');
    await fs.ensureDir(stage);
    const runtime = path.join(stage, 'runtime');
    await fs.ensureDir(runtime);
    let downloaded = 0;
    const total = NVENC_ASSETS.reduce((sum, a) => sum + a.size, 0);
    for (const [index, asset] of NVENC_ASSETS.entries()) {
      const archive = path.join(stage, asset.name);
      status.message = `Downloading ${asset.name}…`;
      await downloadToFile(asset.url, archive, { expectedSha256: asset.sha256, label: asset.name, onProgress: p => {
        status.progress = Math.min(85, (downloaded + p.received) / total * 85);
      } });
      if ((await fs.stat(archive)).size !== asset.size) throw new Error(`Unexpected size for ${asset.name}.`);
      const unpacked = path.join(stage, 'unpacked-' + index);
      status.message = `Extracting ${asset.name}…`;
      await extract7z(archive, unpacked);
      const anchor = await findRuntimeFile(unpacked, index === 0 ? 'NVEncC64.exe' : 'onnxruntime.dll');
      if (!anchor) throw new Error(`Required runtime files are missing from ${asset.name}.`);
      // Both directories are on the same volume: move each entry rather than copying
      // several GiB of DLLs while the extracted archive still occupies disk space.
      const payload = path.dirname(anchor);
      for (const entry of await fs.readdir(payload)) {
        await fs.move(path.join(payload, entry), path.join(runtime, entry), { overwrite: true });
      }
      await fs.remove(unpacked); await fs.remove(archive);
      downloaded += asset.size;
    }
    for (const name of REQUIRED) if (!await fs.pathExists(path.join(runtime, name))) throw new Error(`Optional runtime is incomplete: ${name} is missing.`);
    status.message = 'Checking NVEncC…'; status.progress = 95;
    await smokeExecutable(path.join(runtime, 'NVEncC64.exe'));
    if (await fs.pathExists(root())) { await fs.move(root(), backup); movedPrevious = true; }
    try { await fs.move(runtime, root()); }
    catch (error) { if (movedPrevious) await fs.move(backup, root()); throw error; }
    await fs.remove(backup);
    status = { busy: false, progress: 100, message: 'NVEncC GPU backend installed.' };
  } catch (error) {
    status = { busy: false, progress: 0, message: error instanceof Error ? error.message : String(error) };
    throw error;
  } finally { await fs.remove(stage).catch(() => {}); }
  return nvencRuntimeStatus();
}
