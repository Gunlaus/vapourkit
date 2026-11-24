import { z } from 'zod';
import { VAPOURSYNTH_VERSION } from './vapoursynthCore';
export const safePath = z.string().min(1).refine(p => !p.startsWith('/') && !p.startsWith('-') && !p.startsWith('@') && !p.includes('\\') && !p.includes(':') && !p.includes('*') && !p.includes('?') && !p.split('/').some(x => !x || x === '.' || x === '..'));
export const artifact = z.object({ url: z.string().url(), api: z.number().optional(), size: z.number().int().positive().optional(), files: z.record(z.string(), z.tuple([z.string(), z.string().regex(/^[a-f0-9]{64}$/)])) });
export const pkg = z.object({
  name: z.string(), identifier: z.string(), description: z.string().default(''), type: z.enum(['VSPlugin', 'PyScript']),
  github: z.string().url().optional(), website: z.string().url().optional(),
  namespace: z.string().optional(), modulename: z.string().optional(), api: z.number().optional(),
  dependencies: z.array(z.string()).default([]), releases: z.array(z.object({ version: z.string() }).passthrough()),
});
export type Package = z.infer<typeof pkg>;
export type Artifact = z.infer<typeof artifact>;
export function chooseArtifact(p: Package, platform = process.platform, arch = process.arch, core = Number(VAPOURSYNTH_VERSION)): { version: string; asset: Artifact; api: number | null } | null {
  if (p.type === 'PyScript' && (!p.modulename || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.modulename))) return null;
  const target = p.type === 'PyScript' ? 'script' : arch !== 'x64' ? '' : platform === 'win32' ? 'win64' : platform === 'linux' ? 'linux-glibc-x86_64' : '';
  for (const release of p.releases) {
    const parsed = artifact.safeParse(release[target]);
    if (!parsed.success) continue;
    // VSRepo defaults omitted native API metadata to API3. R79 supports both;
    // R80 is the release that removed API3. Actual loading is still tested.
    const api = p.type === 'PyScript' ? null : parsed.data.api ?? p.api ?? 3;
    if (p.type === 'VSPlugin' && (api! < (core >= 80 ? 4 : 3) || api! > 4)) continue;
    return { version: release.version, asset: parsed.data, api };
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
