import { dialog, ipcMain } from 'electron';
import * as path from 'path';
import { getBundledBasePath } from './utils';
import { prepareShader, shaderInfo } from './shaders';
import { SHADER_PRESETS, type ShaderSettings } from './shaderTypes';
export function registerShaderHandlers(): void {
  ipcMain.handle('shader-info', (_event, settings: ShaderSettings) => shaderInfo(settings));
  ipcMain.handle('shader-choose', async (_event, presetId?: string) => {
    if (presetId !== undefined && !SHADER_PRESETS.some(p => p.id === presetId)) throw new Error('Unknown shader preset.');
    const preset = SHADER_PRESETS.find(p => p.id === presetId);
    let file = preset ? path.join(getBundledBasePath(), 'include', 'shaders', preset.file) : '';
    if (!preset) {
      const result = await dialog.showOpenDialog({ title: 'Import mpv/libplacebo GLSL shader', properties: ['openFile'], filters: [{ name: 'GLSL hook shaders', extensions: ['glsl'] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      file = result.filePaths[0];
    }
    const initial: ShaderSettings = { path: file, presetId: preset?.id, scale: preset?.scale ?? 1, parameters: {} };
    const prepared = await prepareShader(initial);
    return { ...initial, path: prepared.file, name: preset?.name ?? path.basename(file), parameters: Object.fromEntries(prepared.info.parameters.map(p => [p.name, p.default])) };
  });
}
