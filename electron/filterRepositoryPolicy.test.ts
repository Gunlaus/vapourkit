
import { describe, expect, it } from 'vitest';
import { pkg, safePath, chooseArtifact, checkedArtifact, indexRepository, planInstall, RepositoryBlock } from './filterRepositoryPolicy';
const binary = (api?: number) => ({ url: 'https://github.com/test/repo/releases/download/1/plugin.zip', ...(api === undefined ? {} : { api }), files: { 'plugin.dll': ['x64/plugin.dll', 'a'.repeat(64)] } });
const model = (asset: unknown) => pkg.parse({ name: 'Plugin', identifier: 'test.plugin', type: 'VSPlugin', description: 'test', releases: [{ version: '1', win64: asset }] });
describe('VSRepo compatibility', () => {
  it('supports API3 and API4 on R79, including the VSRepo API3 default', () => {
    expect(chooseArtifact(model(binary(3)), 'win32', 'x64')?.api).toBe(3);
    expect(chooseArtifact(model(binary()), 'win32', 'x64')?.api).toBe(3);
    expect(chooseArtifact(model(binary(4)), 'win32', 'x64')?.api).toBe(4);
    expect(chooseArtifact(model(binary(5)), 'win32', 'x64')).toBeNull();
    expect(chooseArtifact(model(binary(3)), 'win32', 'x64', 80)).toBeNull();
  });
  it('does not offer Windows binaries to Linux or other architectures', () => {
    expect(chooseArtifact(model(binary(4)), 'linux', 'x64')).toBeNull();
    expect(chooseArtifact(model(binary(4)), 'win32', 'arm64')).toBeNull();
  });
  it('rejects unsafe destinations and unsupported hash metadata', () => {
    for (const bad of ['../outside.dll', '/absolute.dll', 'D:/absolute.dll', 'x/../../out.dll', '*.dll', '-oelsewhere']) expect(safePath.safeParse(bad).success).toBe(false);
    const asset = binary(4); asset.files['plugin.dll'][1] = 'not-a-hash';
    expect(chooseArtifact(model(asset), 'win32', 'x64')).toBeNull();
  });
});

const sha = 'b'.repeat(64);
const plugin = (identifier: string, extra: Record<string, unknown> = {}) => ({
  name: identifier.toUpperCase(), identifier, type: 'VSPlugin', namespace: identifier,
  releases: [{ version: 'r1', published: '2024-01-02T03:04:05Z', win64: { url: 'https://github.com/test/' + identifier + '/r1.7z', files: { [identifier + '.dll']: [identifier + '.dll', sha] } } }],
  ...extra,
});
const blockOf = (fn: () => unknown) => { try { fn(); } catch (error) { return error as RepositoryBlock; } throw new Error('expected a block'); };

describe('VSRepo registry schema', () => {
  it('keeps packages whose display fields are empty or loose, as the live registry has them', () => {
    // The live NNEDI3 weights entry has website "", which used to drop it.
    const parsed = pkg.parse(plugin('com.deinterlace.nnedi3.weights', { website: '', github: 'not a url', category: 42, description: null, doom9: 'https://forum.doom9.org/' }));
    expect(parsed.website).toBeUndefined();
    expect(parsed.github).toBeUndefined();
    expect(parsed.category).toBeUndefined();
    expect(parsed.description).toBe('');
    expect(pkg.parse(plugin('x', { website: 'https://example.com', category: 'Denoising' }))).toMatchObject({ website: 'https://example.com', category: 'Denoising' });
    expect(pkg.parse(plugin('x')).releases[0].published).toBe('2024-01-02T03:04:05Z');
  });
  it('lists PyWheel packages but never installs them', () => {
    const wheel = pkg.parse({ name: 'vs-util', identifier: 'vsutil', type: 'PyWheel', modulename: 'vsutil', releases: [{ version: '1', wheel: { url: 'https://files.pythonhosted.org/x.whl', hash: sha } }] });
    expect(chooseArtifact(wheel, 'win32', 'x64')).toBeNull();
    expect(blockOf(() => checkedArtifact(wheel)).blocker).toBe('type');
  });
  it('remembers entries that still fail the schema by identifier', () => {
    const index = indexRepository([plugin('good'), { identifier: 'broken', releases: 'nope' }, 'junk']);
    expect(index.packages.map(p => p.identifier)).toEqual(['good']);
    expect([...index.unreadable]).toEqual(['broken']);
  });
});

describe('VSRepo dependency planning', () => {
  const win = (fn: () => unknown) => { const platform = Object.getOwnPropertyDescriptor(process, 'platform')!; const arch = Object.getOwnPropertyDescriptor(process, 'arch')!; Object.defineProperty(process, 'platform', { value: 'win32' }); Object.defineProperty(process, 'arch', { value: 'x64' }); try { return fn(); } finally { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch); } };
  it('resolves a dependency that has an empty website (the vsTAAmbk -> NNEDI3 -> weights chain)', () => win(() => {
    const index = indexRepository([plugin('weights', { website: '' }), plugin('nnedi3', { dependencies: ['weights'] }), plugin('taa', { dependencies: ['nnedi3'] })]);
    expect(planInstall(index.packages[2], index, new Set()).map(p => p.identifier)).toEqual(['weights', 'nnedi3', 'taa']);
  }));
  it('tells a dependency missing from the registry from one that cannot be installed here', () => win(() => {
    const missing = indexRepository([plugin('a', { dependencies: ['nowhere'] })]);
    const missingBlock = blockOf(() => planInstall(missing.packages[0], missing, new Set()));
    expect(missingBlock.blocker).toBe('dependency');
    expect(missingBlock.message).toBe('A: dependency is not in VSRepo: nowhere');

    const wheel = { name: 'vs-util', identifier: 'vsutil', type: 'PyWheel', modulename: 'vsutil', releases: [{ version: '1', wheel: {} }] };
    const unsupported = indexRepository([plugin('a', { dependencies: ['vsutil'] }), wheel]);
    const unsupportedBlock = blockOf(() => planInstall(unsupported.packages[0], unsupported, new Set()));
    expect(unsupportedBlock.blocker).toBe('dependency');
    expect(unsupportedBlock.message).toContain('dependency vs-util is in VSRepo but cannot be installed here');
    expect(unsupportedBlock.message).toContain('Python wheel');

    const unreadable = indexRepository([plugin('a', { dependencies: ['broken'] }), { identifier: 'broken' }]);
    expect(blockOf(() => planInstall(unreadable.packages[0], unreadable, new Set())).message).toContain('is in VSRepo, but its registry entry could not be read');
  }));
  it('treats a dependency already in the runtime as satisfied, even one this browser cannot install', () => win(() => {
    const index = indexRepository([plugin('a', { dependencies: ['io.github.amusementclub.vszip'] }), plugin('io.github.amusementclub.vszip')]);
    expect(blockOf(() => planInstall(index.packages[0], index, new Set())).message).toContain('Managed by Vapourkit');
    expect(planInstall(index.packages[0], index, new Set(['io.github.amusementclub.vszip'])).map(p => p.identifier)).toEqual(['a']);
  }));
  it('reports dependency cycles', () => win(() => {
    const index = indexRepository([plugin('a', { dependencies: ['b'] }), plugin('b', { dependencies: ['a'] })]);
    expect(blockOf(() => planInstall(index.packages[0], index, new Set())).message).toContain('dependency cycle');
  }));
});
