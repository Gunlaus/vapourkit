import * as path from 'path';
import * as fs from 'fs-extra';
import { PATHS } from './constants';
import { pipInstall, runPython, throwIfFailed, withPipLock } from './pip';
import { RTX_SPECS } from './providers/tensorrtRtx';
import { ensureEngineBuilderScript } from './trtexecShim';
import type { RtxRuntimeStatus } from './rtxTypes';

const VERSION = '1.7.1.116';
let busy = false;
let message = '';
export async function rtxRuntimeStatus(platform: NodeJS.Platform = process.platform, architecture = process.arch): Promise<RtxRuntimeStatus> {
  const supported = platform === 'win32' && architecture === 'x64';
  const required = [
    path.join(PATHS.PLUGINS, 'trt_rtx', 'vstrt_rtx.dll'),
    path.join(PATHS.SITE_PACKAGES, 'tensorrt_rtx', '__init__.py'),
    path.join(PATHS.SITE_PACKAGES, 'tensorrt_rtx_bindings', '__init__.py'),
    path.join(PATHS.SITE_PACKAGES, 'tensorrt_rtx_libs', 'tensorrt_rtx_1_7.dll'),
  ];
  const marker = await fs.readJson(path.join(PATHS.APP_DATA, 'tensorrt-rtx', 'installed.json')).catch(() => null);
  const installed = supported && marker?.version === VERSION && (await Promise.all(required.map(file => fs.pathExists(file)))).every(Boolean);
  return { supported, installed, busy, message, version: VERSION };
}

/** No upgrades/repairs of an installed runtime while previews may use it. */
export async function installRtxRuntime(platform: NodeJS.Platform = process.platform, architecture = process.arch): Promise<RtxRuntimeStatus> {
  const current = await rtxRuntimeStatus(platform, architecture);
  if (!current.supported) throw new Error('The optional TensorRT-RTX backend currently supports Windows x64.');
  if (busy) throw new Error('TensorRT-RTX installation is already running.');
  if (current.installed) return current;
  busy = true;
  message = 'Installing the optional RTX SDK and plugin…';
  try {
    await withPipLock(async () => {
      // Every dependency in this optional addition is pinned explicitly. Avoid
      // resolving/upgrading VapourSynth, classic TensorRT or the CUDA stack.
      throwIfFailed(await pipInstall(RTX_SPECS, {
        step: 'Installing TensorRT-RTX', extraArgs: ['--no-deps'], timeoutMs: 15 * 60 * 1000,
      }), 'Installing TensorRT-RTX');
      await ensureEngineBuilderScript();
      message = 'Checking the RTX SDK and VapourSynth plugin…';
      const probe = `import sys; sys.path.insert(0, ${JSON.stringify(PATHS.APP_DATA)}); from vk_rtx_runtime import ensure_plugin; print(ensure_plugin())`;
      throwIfFailed(await runPython(['-c', probe], {
        step: 'Checking TensorRT-RTX', timeoutMs: 60000,
      }), 'Checking TensorRT-RTX');
    }, { label: 'optional TensorRT-RTX installation' });
    const folder = path.join(PATHS.APP_DATA, 'tensorrt-rtx');
    await fs.ensureDir(folder);
    await fs.writeJson(path.join(folder, 'installed.json'), { version: VERSION });
    message = 'TensorRT-RTX installed. Select it as the inference backend; leave execution backend on VapourSynth.';
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
    throw error;
  } finally { busy = false; }
  return rtxRuntimeStatus(platform, architecture);
}
