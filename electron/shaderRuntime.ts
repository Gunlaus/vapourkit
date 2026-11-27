import * as fs from 'fs-extra';
import * as path from 'path';
import { PATHS } from './constants';
import { pipInstall, throwIfFailed, withPipLock } from './pip';
const pluginPath = () => path.join(PATHS.PLUGINS, process.platform === 'win32' ? 'libvs_placebo.dll' : 'libvs_placebo.so');
let busy = false;
export async function shaderRuntimeStatus() { return { installed: await fs.pathExists(pluginPath()), busy }; }
export async function installShaderRuntime() {
  if (busy) throw new Error('Shader support installation is already running.');
  if ((await shaderRuntimeStatus()).installed) return shaderRuntimeStatus();
  busy = true;
  try {
    await withPipLock(async () => {
      throwIfFailed(await pipInstall(['vs-placebo==2.0.5'], { step: 'Installing shader support', extraArgs: ['--no-deps'], timeoutMs: 600000 }), 'Installing shader support');
    }, { label: 'shader runtime installation' });
    if (!(await shaderRuntimeStatus()).installed) throw new Error('The shader plugin was not installed. Repair plugins and try again.');
  } finally { busy = false; }
  return shaderRuntimeStatus();
}
