import * as fs from 'fs-extra';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from './constants';
import { getBundledBasePath } from './utils';
import { SHADER_PRESETS, type ShaderLibraryEntry, type ShaderSettings } from './shaderTypes';
import { inspectShader, prepareShader } from './shaders';
import { JsonFileWriter } from './jsonFile';
const store = () => path.join(PATHS.APP_DATA, 'shaders', 'library.json');
const writer = new JsonFileWriter(store);
async function custom(): Promise<ShaderLibraryEntry[]> {
  try { const data = await fs.readJson(store()); return Array.isArray(data) ? data : []; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export async function listShaders(): Promise<ShaderLibraryEntry[]> {
  const saved = await custom();
  return [...SHADER_PRESETS.filter(p => !saved.some(s => s.id === p.id)).map(p => ({ id: p.id, path: path.join(getBundledBasePath(), 'include', 'shaders', p.file), name: p.name, description: p.description, scale: p.scale, categories: p.categories, builtin: true })), ...saved];
}
export async function readLibraryShader(id: string): Promise<ShaderLibraryEntry> {
  const entry = (await listShaders()).find(s => s.id === id);
  if (!entry) throw new Error('This shader is no longer in the library.');
  return { ...entry, code: await fs.readFile(entry.path, 'utf8') };
}
let writes = Promise.resolve();
export function saveLibraryShader(value: ShaderLibraryEntry): Promise<ShaderLibraryEntry> {
  const job = writes.catch(() => {}).then(async () => {
    if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) throw new Error('Give the shader a name of up to 200 characters.');
    if (typeof value.code !== 'string' || Buffer.byteLength(value.code) > 8 * 1024 * 1024) throw new Error('Shader code must be text, up to 8 MiB.');
    if (!Array.isArray(value.categories) || value.categories.some(c => typeof c !== 'string' || c.length > 100)) throw new Error('Invalid shader categories.');
    if (typeof value.description !== 'string' || value.description.length > 4000) throw new Error('Shader description must be at most 4000 characters.');
    inspectShader(value.code, value.name);
    const id = value.id || randomUUID();
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('Invalid shader identity.');
    const source = path.join(PATHS.APP_DATA, 'shaders', 'imports', id + '.glsl');
    await fs.ensureDir(path.dirname(source));
    const stage = source + '.' + randomUUID() + '.tmp';
    try { await fs.writeFile(stage, value.code); await fs.rename(stage, source); } finally { await fs.remove(stage); }
    const prepared = await prepareShader({ path: source, scale: value.scale, parameters: {} });
    const entry: ShaderLibraryEntry = { id, path: prepared.file, name: value.name.trim(), description: value.description.trim(), categories: [...new Set(value.categories.map(c => c.trim()).filter(Boolean))], scale: value.scale, builtin: false };
    const all = (await custom()).filter(s => s.id !== id);
    await writer.write([...all, entry]);
    return entry;
  });
  writes = job.then(() => {});
  return job;
}
export async function chooseLibraryShader(id: string): Promise<ShaderSettings> {
  const entry = (await listShaders()).find(s => s.id === id);
  if (!entry) throw new Error('Choose a shader from the library.');
  const prepared = await prepareShader({ path: entry.path, scale: entry.scale, parameters: {} });
  return { path: prepared.file, name: entry.name, description: entry.description, categories: entry.categories, libraryId: id,
    ...(entry.builtin ? { presetId: entry.id } : {}), scale: entry.scale, parameters: Object.fromEntries(prepared.info.parameters.map(p => [p.name, p.default])) };
}
