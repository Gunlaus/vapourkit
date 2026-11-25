import * as fs from 'fs-extra';
import * as path from 'path';
import { statfs } from 'fs/promises';
import { app } from 'electron';
import { PATHS } from './constants';
import { catalogSchema, type ComponentEntry, type ComponentSnapshot } from './componentCatalog';
import { getBundledBasePath } from './utils';
import { downloadToFile } from './download';
import { fileDigest, importModelPackage, modelPackageFiles, packageIdentity } from './modelPackage';
import { inspectResolvedOnnxGraph } from './modelGraphResolver';
import { describeModel } from './modelContract';
import { configManager } from './configManager';
import { modelMetadataKey } from './modelIdentity';
import { readLedger, writeLedger } from './installLedger';

let busy = false;
function compatible(entry: ComponentEntry): boolean {
  return entry.platforms.includes(process.platform as 'win32' | 'linux') && entry.vendors.includes(configManager.getPluginsGpuVendor() ?? 'unknown');
}
async function shippedCatalog() {
  // Deliberately never reads the old cached/remote catalog or selection file.
  return catalogSchema.parse(await fs.readJson(path.join(getBundledBasePath(), 'include', 'component-catalog.json')));
}
export async function listCatalogModels(): Promise<ComponentSnapshot> {
  const catalog = await shippedCatalog();
  const installed: Record<string,string> = {};
  for (const [id, entry] of Object.entries((await readLedger()).models ?? {})) {
    const present = await Promise.all(entry.files.map(async file => {
      const target = path.resolve(PATHS.MODELS, file.path);
      if (!target.startsWith(path.resolve(PATHS.MODELS) + path.sep)) return false;
      return await fs.pathExists(target) && await fileDigest(target) === file.sha256;
    }));
    if (present.length && present.every(Boolean)) installed[id] = entry.version;
  }
  return { catalog: { ...catalog, components: catalog.components.filter(compatible) }, installed };
}
export async function installCatalogModel(id: string, version: string, experimental: boolean, accepted: boolean): Promise<{ message: string }> {
  if (!accepted) throw new Error('Review and accept the model source, licence, size and hashes before installing.');
  if (busy) throw new Error('A model installation is already running.');
  busy = true;
  let stage = '', createdPackage = '', createdMetadata = '';
  try {
    const entry = (await shippedCatalog()).components.find(model => model.id === id && model.version === version);
    if (!entry || !compatible(entry)) throw new Error('This model is not offered by this application release for the selected platform/GPU.');
    if (entry.channel === 'experimental' && !experimental) throw new Error('Enable experimental models explicitly before installing.');
    await fs.ensureDir(PATHS.APP_DATA); await fs.ensureDir(PATHS.MODELS);
    const needed = entry.files.reduce((sum,file) => sum + file.bytes,0);
    for (const root of [PATHS.APP_DATA, PATHS.MODELS]) {
      const disk = await statfs(root);
      if (Number(disk.bavail) * Number(disk.bsize) < needed * 2 + 64 * 1024 ** 2) throw new Error('Not enough free space to stage and import this model while keeping existing versions.');
    }
    stage = await fs.mkdtemp(path.join(PATHS.APP_DATA,'model.staging-'));
    for (const asset of entry.files) {
      const target = path.join(stage,asset.path);
      await fs.ensureDir(path.dirname(target));
      await downloadToFile(asset.url,target,{ expectedSha256: asset.sha256, minBytes: asset.bytes, retries: 1 });
      if ((await fs.stat(target)).size !== asset.bytes || await fileDigest(target) !== asset.sha256) throw new Error('Model download size or checksum disagrees with the shipped catalog: ' + asset.path);
    }
    const source = path.join(stage,entry.model.file);
    const weights = await modelPackageFiles(source);
    const declared = new Set(entry.files.map(file => file.path));
    const required = [entry.model.file,...weights.map(file => path.posix.join(path.posix.dirname(entry.model.file),file.replace(/\\/g,'/')))];
    if (required.length !== declared.size || required.some(file => !declared.has(file))) throw new Error('The model graph and shipped weight manifest disagree.');
    const graph = await inspectResolvedOnnxGraph(source);
    if (!graph) throw new Error('Downloaded model is not a readable ONNX graph.');
    describeModel(graph,{ modelType: entry.model.type, temporalFrames: entry.model.frames, spatialMultiple: entry.model.spatialMultiple, catalog: true });
    const name = entry.id + '-' + entry.version;
    const identity = await packageIdentity(source);
    const destination = path.join(PATHS.MODELS,'packages',name + '-' + identity.slice(0,16));
    const existed = await fs.pathExists(destination);
    const installed = await importModelPackage(source,PATHS.MODELS,name);
    if (!existed) createdPackage = destination;
    const contract = await fs.readJson(installed + '.contract.json');
    await fs.writeJson(installed + '.contract.json',{ ...contract, spatialMultiple: entry.model.spatialMultiple, scale: entry.model.scale, catalog: entry.id + '@' + entry.version, semantics: 'catalog' });
    const key = modelMetadataKey(installed,PATHS.MODELS);
    if (!configManager.getModelMetadata(key)) {
      createdMetadata = key;
      await configManager.setModelMetadata(key,false,entry.model.type,entry.name,undefined,false,entry.model.frames);
    }
    const files = [];
    for (const asset of entry.files) {
      const target = asset.path === entry.model.file ? installed : path.join(path.dirname(installed),path.posix.relative(path.posix.dirname(entry.model.file),asset.path));
      files.push({ path: path.relative(PATHS.MODELS,target).replace(/\\/g,'/'), sha256: asset.sha256, bytes: asset.bytes });
    }
    const ledger = await readLedger();
    ledger.models = { ...ledger.models, [entry.id + '@' + entry.version]: { version: entry.version, appVersion: app.getVersion(), installedAt: new Date().toISOString(), author: entry.author, source: entry.source, license: entry.license, licenseUrl: entry.licenseUrl, files } };
    await writeLedger(ledger);
    return { message: 'Model installed alongside existing versions. It is now in the model picker. With TensorRT, build its engine once from the build notification before first use.' };
  } catch (error) {
    if (createdMetadata) await configManager.deleteModelMetadata(createdMetadata).catch(() => {});
    if (createdPackage) await fs.remove(createdPackage).catch(() => {});
    throw error;
  } finally { if (stage) await fs.remove(stage); busy = false; }
}
