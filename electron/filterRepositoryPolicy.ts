import { z } from 'zod';
import { VAPOURSYNTH_VERSION } from './vapoursynthCore';
import type { RepositoryBlocker } from './filterRepositoryTypes';
export const safePath = z.string().min(1).refine(p => !p.startsWith('/') && !p.startsWith('-') && !p.startsWith('@') && !p.includes('\\') && !p.includes(':') && !p.includes('*') && !p.includes('?') && !p.split('/').some(x => !x || x === '.' || x === '..'));
export const artifact = z.object({ url: z.string().url(), api: z.number().optional(), size: z.number().int().positive().optional(), files: z.record(z.string(), z.tuple([z.string(), z.string().regex(/^[a-f0-9]{64}$/)])) });
/** Package types the browser can install. Other types, such as PyWheel, are listed but not installable. */
export const INSTALLABLE_TYPES: readonly string[] = ['VSPlugin', 'PyScript'];
// Display-only fields never decide whether a package is kept: VSRepo uses
// empty strings and other loose values for them.
const webLink = z.string().regex(/^https?:\/\//i).optional().catch(undefined);
const optionalText = z.string().min(1).optional().catch(undefined);
export const pkg = z.object({
  name: z.string(), identifier: z.string(), description: z.string().default('').catch(''), type: z.string(),
  github: webLink, website: webLink, category: optionalText,
  namespace: z.string().optional(), modulename: z.string().optional(), api: z.number().optional(),
  dependencies: z.array(z.string()).default([]),
  releases: z.array(z.object({ version: z.string(), published: optionalText }).passthrough()),
});
export type Package = z.infer<typeof pkg>;
export type Artifact = z.infer<typeof artifact>;
export function chooseArtifact(p: Package, platform = process.platform, arch = process.arch, core = Number(VAPOURSYNTH_VERSION)): { version: string; published?: string; asset: Artifact; api: number | null } | null {
  if (!INSTALLABLE_TYPES.includes(p.type)) return null;
  if (p.type === 'PyScript' && (!p.modulename || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.modulename))) return null;
  const target = p.type === 'PyScript' ? 'script' : arch !== 'x64' ? '' : platform === 'win32' ? 'win64' : platform === 'linux' ? 'linux-glibc-x86_64' : '';
  for (const release of p.releases) {
    const parsed = artifact.safeParse(release[target]);
    if (!parsed.success) continue;
    // VSRepo defaults omitted native API metadata to API3. R79 supports both;
    // R80 is the release that removed API3. Actual loading is still tested.
    const api = p.type === 'PyScript' ? null : parsed.data.api ?? p.api ?? 3;
    if (p.type === 'VSPlugin' && (api! < (core >= 80 ? 4 : 3) || api! > 4)) continue;
    return { version: release.version, published: release.published, asset: parsed.data, api };
  }
  return null;
}

export function packageBlockReason(p: Package): string {
  return p.identifier.startsWith('io.github.amusementclub.') || p.identifier === 'com.vapoursynth.bestsource'
    ? 'Managed by Vapourkit. Use Plugins to install or repair this package; VSRepo must not replace the pinned version.' : '';
}
export function allowedRepositoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'www.vapoursynth.com'].includes(url.hostname);
  } catch { return false; }
}

/** A reason a package cannot be installed, with its kind for the browser's chip. */
export class RepositoryBlock extends Error {
  constructor(readonly blocker: RepositoryBlocker, message: string) { super(message); }
}

/** The artifact to install for a package. Throws a RepositoryBlock when there is none. */
export function checkedArtifact(p: Package) {
  const blocked = packageBlockReason(p);
  if (blocked) throw new RepositoryBlock('managed', p.name + ': ' + blocked);
  if (!INSTALLABLE_TYPES.includes(p.type)) {
    throw new RepositoryBlock('type', p.name + ': ' + (p.type === 'PyWheel' ? 'Python wheel (PyWheel)' : p.type) + ' packages cannot be installed here.');
  }
  const chosen = chooseArtifact(p);
  if (!chosen) throw new RepositoryBlock('platform', p.name + ': no compatible binary/API declaration for this runtime.');
  if (!allowedRepositoryUrl(chosen.asset.url)) throw new RepositoryBlock('source', p.name + ': unsupported repository download host: ' + new URL(chosen.asset.url).hostname);
  const entries = Object.entries(chosen.asset.files);
  if (!entries.length || entries.length > 512) throw new RepositoryBlock('other', p.name + ': invalid package file count.');
  for (const [target, [member]] of entries) {
    if (!safePath.safeParse(target).success || !safePath.safeParse(member).success) throw new RepositoryBlock('other', p.name + ': unsafe file path in the registry.');
  }
  return chosen;
}

export interface RepositoryIndex {
  packages: Package[];
  /** Identifiers of registry entries that failed the schema. */
  unreadable: Set<string>;
}

/** Reads registry packages. Entries that fail the schema are remembered by identifier. */
export function indexRepository(raw: unknown[]): RepositoryIndex {
  const packages: Package[] = [];
  const unreadable = new Set<string>();
  for (const entry of raw) {
    const parsed = pkg.safeParse(entry);
    if (parsed.success) packages.push(parsed.data);
    else {
      const id = (entry as { identifier?: unknown } | null)?.identifier;
      if (typeof id === 'string') unreadable.add(id);
    }
  }
  return { packages, unreadable };
}

export function findPackage(packages: Package[], id: string): Package | undefined {
  return packages.find(p => p.identifier === id) ?? packages.find(p => p.namespace === id || p.modulename === id);
}

/**
 * The packages to install for `root`, dependencies first. Throws a
 * RepositoryBlock when `root` or a dependency cannot be installed. A
 * dependency already available in the runtime counts as satisfied.
 */
export function planInstall(root: Package, index: RepositoryIndex, installed: Set<string>): Package[] {
  const result: Package[] = []; const visiting = new Set<string>(); const done = new Set<string>();
  const visit = (p: Package) => {
    // The browser never installs or replaces an available dependency, pinned ones included.
    if (p !== root && installed.has(p.identifier)) return;
    checkedArtifact(p);
    if (done.has(p.identifier) || installed.has(p.identifier)) return;
    if (visiting.has(p.identifier)) throw new RepositoryBlock('dependency', 'The registry contains a dependency cycle.');
    visiting.add(p.identifier);
    for (const dependency of p.dependencies) {
      const child = findPackage(index.packages, dependency);
      if (!child) {
        if (installed.has(dependency)) continue;
        if (index.unreadable.has(dependency)) throw new RepositoryBlock('dependency', p.name + ': dependency ' + dependency + ' is in VSRepo, but its registry entry could not be read.');
        throw new RepositoryBlock('dependency', p.name + ': dependency is not in VSRepo: ' + dependency);
      }
      try { visit(child); }
      catch (error) {
        if (!(error instanceof RepositoryBlock) || error.blocker === 'dependency') throw error;
        throw new RepositoryBlock('dependency', p.name + ': dependency ' + child.name + ' is in VSRepo but cannot be installed here. ' + error.message);
      }
    }
    visiting.delete(p.identifier); done.add(p.identifier); result.push(p);
  };
  visit(root); return result;
}
