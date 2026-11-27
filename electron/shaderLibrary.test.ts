import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
vi.mock('./constants', async () => { const p = await import('path'), o = await import('os'); return { PATHS: { APP_DATA: p.join(o.tmpdir(), `vk-library-${process.pid}`) } }; });
vi.mock('./utils', () => ({ getBundledBasePath: () => process.cwd() }));
import { chooseLibraryShader, listShaders, readLibraryShader, saveLibraryShader } from './shaderLibrary';
const root = path.join(os.tmpdir(), `vk-library-${process.pid}`);
beforeEach(async () => { await fs.remove(root); }); afterAll(async () => { await fs.remove(root); });
it('persists a named imported copy, edits metadata/code, and preserves existing selected snapshots', async () => {
  const code = '//!HOOK MAIN\n//!BIND HOOKED\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }';
  const entry = await saveLibraryShader({ id: '', name: 'My shader', path: '', description: 'Optional description', categories: ['General','Custom'], scale: 1, builtin: false, code });
  expect(entry.path.startsWith(root)).toBe(true);
  const selected = await chooseLibraryShader(entry.id);
  const edited = await saveLibraryShader({ ...entry, name: 'Renamed', description: 'Edited', code: code.replace('return HOOKED', 'return 0.5 * HOOKED') });
  expect(edited.path).not.toBe(selected.path);
  expect(await fs.readFile(selected.path, 'utf8')).toBe(code);
  expect((await listShaders()).find(s => s.id === entry.id)?.name).toBe('Renamed');
  expect((await readLibraryShader(entry.id)).code).toContain('0.5 * HOOKED');
});
it('offers anime, live-action, color and effect defaults with descriptions', async () => {
  const entries = await listShaders();
  expect(entries.length).toBeGreaterThanOrEqual(10);
  for (const category of ['Anime','Live action','Color correction','Upscaling','Effects']) expect(entries.some(e => e.categories.includes(category))).toBe(true);
  expect(entries.every(e => !!e.description)).toBe(true);
});


it('relocates imported snapshots when the portable data folder moves', async () => {
  const code = '//!HOOK MAIN\n//!BIND HOOKED\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }';
  const entry = await saveLibraryShader({ id: '', name: 'Portable', path: '', description: '', categories: ['Custom'], scale: 1, builtin: false, code });
  const oldPath = entry.path.replace(root, '/previous-install/data');
  const data = await fs.readJson(path.join(root, 'shaders', 'library.json'));
  data[0].path = oldPath;
  await fs.writeJson(path.join(root, 'shaders', 'library.json'), data);
  expect((await chooseLibraryShader(entry.id)).path).toBe(entry.path);
});
