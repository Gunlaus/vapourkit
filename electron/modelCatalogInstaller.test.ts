import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash } from 'crypto';
const state = vi.hoisted(() => {
  const p = require('path'); const o = require('os');
  return { root: p.join(o.tmpdir(),'vk-shipped-models-' + process.pid), download: vi.fn(), metadata: new Map(), disk: vi.fn() };
});
vi.mock('electron', () => ({ app: { getVersion: () => 'test-release' } }));
vi.mock('./constants', () => ({ PATHS: { APP_DATA: path.join(state.root,'data'), CONFIG: path.join(state.root,'data/config'), MODELS: path.join(state.root,'data/models') } }));
vi.mock('./utils', () => ({ getBundledBasePath: () => path.join(state.root,'bundle') }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), model: vi.fn() } }));
vi.mock('./download', () => ({ downloadToFile: state.download }));
vi.mock('fs/promises', async original => ({ ...await original<typeof import('fs/promises')>(), statfs: state.disk }));
vi.mock('./configManager', () => ({ configManager: {
  getPluginsGpuVendor: () => 'nvidia', getModelMetadata: (key: string) => state.metadata.get(key),
  setModelMetadata: vi.fn(async (key: string) => { state.metadata.set(key,{}); }), deleteModelMetadata: vi.fn(async (key: string) => { state.metadata.delete(key); }),
} }));
import { listCatalogModels, installCatalogModel } from './modelCatalogInstaller';
import * as ledger from './installLedger';
import { catalogSchema } from './componentCatalog';
const varint = (n: number): Buffer => { const b: number[] = []; do { b.push((n & 127) | (n > 127 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Buffer.from(b); };
const field = (n: number,b: Buffer) => Buffer.concat([varint(n*8+2),varint(b.length),b]);
const num = (n: number,v: number) => Buffer.concat([varint(n*8),varint(v)]);
const str = (n: number,v: string) => field(n,Buffer.from(v));
const binding = (name: string) => Buffer.concat([str(1,name),field(2,field(1,Buffer.concat([num(1,1),field(2,Buffer.concat([1,3,32,32].map(d => field(1,num(1,d)))))])))]);
const content = field(7,Buffer.concat([field(11,binding('input')),field(12,binding('output'))]));
const sha = createHash('sha256').update(content).digest('hex');
const model = { id:'example',version:'1',name:'Example model',author:'Fixture creator',source:'https://github.com/test/model',license:'CC BY-NC-SA 4.0',licenseUrl:'https://creativecommons.org/licenses/by-nc-sa/4.0/',kind:'model',platforms:['win32','linux'],vendors:['nvidia'],channel:'stable',notes:'Offline test fixture',files:[{ path:'model.onnx',url:'https://raw.githubusercontent.com/test/model/pin/model.onnx',sha256:sha,bytes:content.length }],model:{file:'model.onnx',adapter:'rgb-image-v1',type:'image',scale:1,frames:1,spatialMultiple:1} };
const catalogFile = path.join(state.root,'bundle/include/component-catalog.json');
async function writeCatalog(entry: unknown = model) { await fs.outputJson(catalogFile,{schema:1,client:1,revision:1,components:[entry]}); }
beforeEach(async () => {
  vi.restoreAllMocks(); await fs.remove(state.root); state.metadata.clear();
  state.disk.mockReset().mockResolvedValue({ bavail: 10_000_000, bsize:4096 });
  state.download.mockReset().mockImplementation(async (_url,file) => { await fs.outputFile(file,content); });
  await writeCatalog();
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.remove(state.root); });
describe('models-only shipped catalog', () => {
  it('ignores cached remote catalogs and never fetches a catalog from the network', async () => {
    const fetch = vi.fn(() => { throw new Error('Unexpected network'); }); vi.stubGlobal('fetch',fetch);
    await fs.outputJson(path.join(state.root,'data/config/component-catalog.json'),{revision:9999,components:[{kind:'runtime'}]});
    expect((await listCatalogModels()).catalog.components[0].name).toBe(model.name);
    expect(fetch).not.toHaveBeenCalled(); expect(state.download).not.toHaveBeenCalled();
  });
  it('requires consent and separate experimental opt-in before downloading', async () => {
    await expect(installCatalogModel('example','1',true,false)).rejects.toThrow('Review and accept');
    await writeCatalog({...model,channel:'experimental'});
    await expect(installCatalogModel('example','1',false,true)).rejects.toThrow('experimental');
    expect(state.download).not.toHaveBeenCalled();
  });
  it('installs a verified ONNX package and records attribution and hashes in the existing ledger', async () => {
    await installCatalogModel('example','1',false,true);
    const saved = await ledger.readLedger();
    expect(saved.models?.['example@1']).toMatchObject({version:'1',appVersion:'test-release',author:model.author,source:model.source,licenseUrl:model.licenseUrl});
    const file = saved.models!['example@1'].files[0];
    expect(file.sha256).toBe(sha);
    expect(await fs.readFile(path.join(state.root,'data/models',file.path))).toEqual(content);
    expect((await listCatalogModels()).installed).toEqual({'example@1':'1'});
    expect([...state.metadata.keys()][0]).toMatch(/^packages\/example-1-.*\/example-1$/);
  });
  it('retains earlier model versions and their ledger entries', async () => {
    await installCatalogModel('example','1',false,true);
    const previous = (await ledger.readLedger()).models!['example@1'].files[0].path;
    await writeCatalog({...model,version:'2'});
    await installCatalogModel('example','2',false,true);
    expect(Object.keys((await ledger.readLedger()).models!)).toEqual(['example@1','example@2']);
    expect(await fs.readFile(path.join(state.root,'data/models',previous))).toEqual(content);
  });
  it('rejects corrupted downloads without publishing a model or ledger entry', async () => {
    state.download.mockImplementation(async (_url,file) => { await fs.outputFile(file,Buffer.alloc(content.length)); });
    await expect(installCatalogModel('example','1',false,true)).rejects.toThrow('checksum');
    expect((await ledger.readLedger()).models).toBeUndefined(); expect(state.metadata.size).toBe(0);
  });
  it('rolls back a new package and metadata if recording the installation fails', async () => {
    vi.spyOn(ledger,'writeLedger').mockRejectedValue(new Error('Ledger write failed'));
    await expect(installCatalogModel('example','1',false,true)).rejects.toThrow('Ledger write failed');
    expect(await fs.readdir(path.join(state.root,'data/models/packages'))).toEqual([]);
    expect(state.metadata.size).toBe(0);
  });
  it('checks free space before starting any download', async () => {
    state.disk.mockResolvedValue({bavail:0,bsize:4096});
    await expect(installCatalogModel('example','1',false,true)).rejects.toThrow('free space');
    expect(state.download).not.toHaveBeenCalled();
  });
  it('rejects executable/filter kinds and requires source and licence information', () => {
    const wrap = (entry: unknown) => ({schema:1,client:1,revision:1,components:[entry]});
    for (const kind of ['runtime','ffmpeg','filters']) expect(catalogSchema.safeParse(wrap({...model,kind})).success).toBe(false);
    for (const key of ['author','source','licenseUrl']) expect(catalogSchema.safeParse(wrap({...model,[key]:undefined})).success).toBe(false);
    expect(catalogSchema.safeParse(wrap({...model,files:[{...model.files[0],path:'python.exe'}]})).success).toBe(false);
  });
});
