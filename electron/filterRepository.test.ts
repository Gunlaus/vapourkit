
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
const mocks = vi.hoisted(() => ({ download: vi.fn(), exec: vi.fn(), cmd: vi.fn(), list: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock('child_process', () => ({ execFile: mocks.exec }));
vi.mock('./download', () => ({ downloadToFile: mocks.download }));
vi.mock('7zip-min', () => ({ default: { cmd: mocks.cmd, list: mocks.list } }));
vi.mock('./constants', async () => {
  const p = await import('path'); const o = await import('os');
  const root = p.join(o.tmpdir(), 'vk-vsrepo-' + process.pid);
  return { PATHS: { PYTHON: 'python', CONFIG: p.join(root,'config'), SCRIPTS: p.join(root,'scripts'), PLUGINS: p.join(root,'plugins'), SITE_PACKAGES: p.join(root,'site') } };
});
vi.mock('./utils', () => ({ setupVSEnvironment: () => ({}) }));
vi.mock('./logger', () => ({ logger: { model: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./templateManager', () => ({ TemplateManager: class { async loadTemplates() { return []; } saveTemplate = mocks.save; rollbackCreatedTemplate = mocks.remove; } }));
const root = path.join(os.tmpdir(), 'vk-vsrepo-' + process.pid);
const content = Buffer.from('verified native plugin fixture');
const sha = createHash('sha256').update(content).digest('hex');
const filename = process.platform === 'win32' ? 'newblur.dll' : 'newblur.so';
const binary = { api: 4, url: 'https://github.com/test/plugin/releases/download/1/plugin.zip', files: { [filename]: [filename, sha] } };
const entry = { name: 'New blur', identifier: 'test.newblur', type: 'VSPlugin', namespace: 'newblur', api: 4, releases: [{ version:'1', win64:binary, 'linux-glibc-x86_64':binary }] };
let registry: unknown;
beforeEach(async () => {
  vi.resetModules(); await fs.remove(root);
  registry = { 'file-format': 3, packages: [entry] };
  mocks.download.mockReset().mockImplementation(async (_url, file) => { await fs.outputFile(file, 'archive'); });
  mocks.cmd.mockReset().mockImplementation(async args => {
    const folder = args.find((a: string) => a.startsWith('-o')).slice(2);
    if (args.includes('vspackages3.json')) await fs.outputJson(path.join(folder, 'vspackages3.json'), registry);
    else await fs.outputFile(path.join(folder, filename), content);
    return '';
  });
  mocks.list.mockReset().mockResolvedValue([{ name: filename, size: String(content.length) }]);
  mocks.exec.mockReset().mockImplementation((_python, args, _options, done) => done(null, args[2].includes('result=[]') ? JSON.stringify([{ namespace:'newblur', functions:[{name:'Blur',signature:'clip:vnode;radius:int:opt;',returns:'clip:vnode;'}] }]) : '[]', ''));
  mocks.save.mockReset().mockResolvedValue(undefined); mocks.remove.mockReset().mockResolvedValue(undefined);
});
afterAll(async () => { await fs.remove(root); });
describe('staged VSRepo installation', () => {
  it('verifies files and plugin loading before publishing a usable filter template', async () => {
    const service = await import('./filterRepository');
    const entries = await service.listRepository(true);
    expect(entries[0].compatible).toBe(true);
    await service.installRepositoryPackage('test.newblur');
    expect(await fs.readFile(path.join(root,'plugins',filename))).toEqual(content);
    expect(mocks.save.mock.calls[0][0].code).toBe('clip = core.newblur.Blur(clip)');
  });
  it('keeps an existing plugin and refuses overwriting it', async () => {
    await fs.outputFile(path.join(root,'plugins',filename), 'user plugin');
    const service = await import('./filterRepository'); await service.listRepository(true);
    await expect(service.installRepositoryPackage('test.newblur')).rejects.toThrow('overwritten');
    expect(await fs.readFile(path.join(root,'plugins',filename), 'utf8')).toBe('user plugin');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('does not publish failed checksum downloads', async () => {
    const service = await import('./filterRepository'); await service.listRepository(true);
    mocks.cmd.mockImplementation(async args => { const folder=args.find((a: string)=>a.startsWith('-o')).slice(2); await fs.outputFile(path.join(folder,filename), 'corrupt'); return ''; });
    await expect(service.installRepositoryPackage('test.newblur')).rejects.toThrow('Checksum');
    expect(await fs.pathExists(path.join(root,'plugins',filename))).toBe(false);
  });
  it('blocks unresolved dependencies before starting any plugin download', async () => {
    registry = { 'file-format': 3, packages: [{ ...entry, dependencies:['missing.plugin'] }] };
    const service = await import('./filterRepository'); const rows=await service.listRepository(true);
    expect(rows[0].compatible).toBe(false);
    const before=mocks.download.mock.calls.length;
    await expect(service.installRepositoryPackage('test.newblur')).rejects.toThrow('dependency is not in VSRepo');
    expect(mocks.download.mock.calls.length).toBe(before);
  });
  it('installs direct Python script assets with the same checksum and load checks', async () => {
    const script = { name:'New script', identifier:'newscript', type:'PyScript', modulename:'newscript', releases:[{version:'1',script:{url:'https://raw.githubusercontent.com/test/repo/commit/newscript.py',files:{'newscript.py':['newscript.py',sha]}}}] };
    registry = { 'file-format':3, packages:[script] };
    mocks.download.mockImplementation(async (url,file) => { await fs.outputFile(file, url.endsWith('newscript.py') ? content : Buffer.from('archive')); });
    mocks.exec.mockImplementation((_python,_args,_options,done) => done(null,'[]',''));
    const service=await import('./filterRepository');
    await service.listRepository(true);
    await service.installRepositoryPackage('newscript');
    expect(await fs.readFile(path.join(root,'scripts','newscript.py'))).toEqual(content);
    expect(mocks.list).not.toHaveBeenCalled();
  });

});

describe('VSRepo dependency and package layout regressions', () => {
  const support = (id: string, name: string) => ({ ...entry, name, namespace: undefined, identifier: id,
    releases: [{ version: '1', win64: { ...binary, files: { [name]: [name, sha] } }, 'linux-glibc-x86_64': { ...binary, files: { [name]: [name, sha] } } }] });
  function archiveFiles(names: string[]) {
    mocks.list.mockResolvedValue(names.map(name => ({ name, size: String(content.length) })));
    mocks.cmd.mockImplementation(async args => {
      const folder = args.find((a: string) => a.startsWith('-o')).slice(2);
      if (args.includes('vspackages3.json')) await fs.outputJson(path.join(folder, 'vspackages3.json'), registry);
      else for (const name of args.filter((a: string) => names.includes(a))) await fs.outputFile(path.join(folder, name), content);
      return '';
    });
  }
  it('checks only the root plugin and reuses verified DLL/weight dependencies after a fresh module load', async () => {
    const deps = [support('org.fftw.fftw3','libfftw3.dll'), support('test.weights','weights.bin')];
    registry = { 'file-format': 3, packages: [...deps, { ...entry, dependencies: deps.map(p => p.identifier) }] };
    archiveFiles(['libfftw3.dll','weights.bin',filename]);
    let service = await import('./filterRepository'); await service.listRepository(true);
    await service.installRepositoryPackage(entry.identifier);
    const health = mocks.exec.mock.calls.find(c => c[1][2].includes('result=[]'))!;
    expect(JSON.parse(health[1][3]).requiredIds).toEqual([entry.identifier]);
    await fs.remove(path.join(root, 'plugins', filename));
    vi.resetModules(); service = await import('./filterRepository');
    await service.listRepository(false);
    const downloads = mocks.download.mock.calls.length;
    await service.installRepositoryPackage(entry.identifier);
    expect(mocks.download.mock.calls.length - downloads).toBe(1);
  });
  it('stages multi-file scripts using target paths and recognizes the installed package on refresh', async () => {
    const files = { 'pkg/__init__.py': ['archive-1/src/init.py',sha], 'pkg/helper.py': ['archive-1/lib.py',sha] };
    registry = { 'file-format':3, packages:[{ name:'Package script', identifier:'test.pkg', type:'PyScript', modulename:'pkg', releases:[{ version:'1',script:{url:binary.url,files} }] }] };
    archiveFiles(['archive-1/src/init.py','archive-1/lib.py']);
    mocks.exec.mockImplementation((_python,args,_options,done) => {
      if (args[2].includes('result=[]')) {
        const spec = JSON.parse(args[3]);
        expect(fs.existsSync(path.join(spec.stagedScripts,'pkg','__init__.py'))).toBe(true);
        expect(fs.existsSync(path.join(spec.stagedScripts,'pkg','helper.py'))).toBe(true);
      }
      done(null,'[]','');
    });
    const service = await import('./filterRepository'); await service.listRepository(true);
    await service.installRepositoryPackage('test.pkg');
    expect((await service.listRepository(false))[0].installed).toBe(true);
    expect(await fs.readFile(path.join(root,'scripts','pkg','helper.py'))).toEqual(content);
  });
  it('resolves exact identifiers before a different package with the same namespace', async () => {
    registry = { 'file-format':3, packages:[{ ...entry,identifier:'another.descale',namespace:'descale',dependencies:['missing'] },{ ...entry,identifier:'descale' }] };
    const service = await import('./filterRepository'); await service.listRepository(true);
    await expect(service.installRepositoryPackage('descale')).resolves.toHaveProperty('message');
  });
  it('marks unsupported hosts and app-managed packages/dependencies incompatible before downloading', async () => {
    const managed = ['io.github.amusementclub.vsmlrt-cuda','com.vapoursynth.bestsource'];
    registry = { 'file-format':3,packages:[...managed.map(identifier => ({ ...entry,identifier })), { ...entry,identifier:'dependent',dependencies:[managed[0]] }, { ...entry,identifier:'untrusted',releases:[{version:'1',win64:{...binary,url:'https://codeberg.org/a/file.zip'},'linux-glibc-x86_64':{...binary,url:'https://codeberg.org/a/file.zip'}}] }] };
    const service = await import('./filterRepository');
    const rows = await service.listRepository(true);
    expect(rows.every(r => !r.compatible && r.reason)).toBe(true);
    const downloads = mocks.download.mock.calls.length;
    for (const row of rows) await expect(service.installRepositoryPackage(row.id)).rejects.toThrow();
    expect(mocks.download.mock.calls.length).toBe(downloads);
  });
  it('uses an already installed app-managed dependency without offering to install or replace it', async () => {
    const managed = 'com.vapoursynth.bestsource';
    registry = { 'file-format':3,packages:[{...entry,identifier:managed},{...entry,identifier:'dependent',dependencies:[managed]}] };
    mocks.exec.mockImplementation((_python,args,_options,done) => done(null,args[2].includes('result=[]') ? '[]' : JSON.stringify([managed]),''));
    const service = await import('./filterRepository');
    const rows = await service.listRepository(true);
    expect(rows.find(row => row.id === managed)?.compatible).toBe(false);
    expect(rows.find(row => row.id === 'dependent')?.compatible).toBe(true);
    const before = mocks.download.mock.calls.length;
    await service.installRepositoryPackage('dependent');
    expect(mocks.download.mock.calls.length - before).toBe(1);
  });
  it('does not turn non-video return values into single-clip filter templates', async () => {
    mocks.exec.mockImplementation((_python,args,_options,done) => done(null,args[2].includes('result=[]') ? JSON.stringify([{namespace:'newblur',functions:[{name:'Measure',signature:'clip:vnode;',returns:'value:int;'}]}]) : '[]',''));
    const service = await import('./filterRepository'); await service.listRepository(true);
    await service.installRepositoryPackage(entry.identifier);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('rolls back a failed template publication without recording user deletion', async () => {
    mocks.save.mockRejectedValue(new Error('Cannot write template'));
    const service = await import('./filterRepository'); await service.listRepository(true);
    await expect(service.installRepositoryPackage(entry.identifier)).rejects.toThrow('Cannot write');
    expect(mocks.remove).toHaveBeenCalledWith('VSRepo newblur Blur');
    expect(await fs.pathExists(path.join(root,'plugins',filename))).toBe(false);
  });
});
