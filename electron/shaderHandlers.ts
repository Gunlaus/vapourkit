import { dialog, ipcMain } from 'electron';
import * as fs from 'fs-extra';
import * as path from 'path';
import { shaderInfo, inspectShader } from './shaders';
import { listShaders, readLibraryShader, saveLibraryShader, chooseLibraryShader } from './shaderLibrary';
import { installShaderRuntime, shaderRuntimeStatus } from './shaderRuntime';
import type { ShaderSettings, ShaderLibraryEntry } from './shaderTypes';
export function registerShaderHandlers(): void {
  ipcMain.handle('shader-info', (_event, settings: ShaderSettings) => shaderInfo(settings));
  ipcMain.handle('shader-library-list', () => listShaders());
  ipcMain.handle('shader-library-read', (_event, id: string) => readLibraryShader(id));
  ipcMain.handle('shader-library-save', (_event, value: ShaderLibraryEntry) => saveLibraryShader(value));
  ipcMain.handle('shader-choose', (_event, id: string) => chooseLibraryShader(id));
  ipcMain.handle('shader-runtime-status', () => shaderRuntimeStatus());
  ipcMain.handle('shader-runtime-install', () => installShaderRuntime());
  ipcMain.handle('shader-library-import', async () => {
    const result = await dialog.showOpenDialog({ title: 'Add GLSL shader', properties: ['openFile'], filters: [{ name: 'mpv/libplacebo shaders', extensions: ['glsl', 'hook'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if ((await fs.stat(file)).size > 8 * 1024 * 1024) throw new Error('Shader files must be at most 8 MiB.');
    const code = await fs.readFile(file, 'utf8');
    inspectShader(code, path.basename(file));
    return { id: '', path: '', name: path.basename(file).replace(/\.(glsl|hook)$/i, ''), description: '', categories: ['Custom'], scale: 1, builtin: false, code } satisfies ShaderLibraryEntry;
  });
}
