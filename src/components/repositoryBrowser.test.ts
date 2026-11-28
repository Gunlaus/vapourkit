import { describe, expect, it } from 'vitest';
import type { RepositoryEntry } from '../../electron/filterRepositoryTypes';
import {
  DEFAULT_FILTERS, DEFAULT_SORT, SORT_STORAGE_KEY, blockerLabel, countEntries, filterEntries, formatSize, formatUpdated,
  kindOf, loadSort, saveSort, sortEntries, statusOf,
} from './repositoryBrowser';

const entry = (id: string, extra: Partial<RepositoryEntry> = {}): RepositoryEntry => ({
  id, name: id, description: '', kind: 'VSPlugin', version: '1', api: 4, namespace: id,
  compatible: true, reason: '', installed: false, ...extra,
});

const entries = [
  entry('Bravo', { updated: '2024-01-01T00:00:00Z', category: 'Denoising' }),
  entry('alpha', { installed: true, updated: '2025-06-01T00:00:00Z', category: 'Denoising' }),
  entry('charlie', { compatible: false, reason: 'x', blocker: 'platform', updated: '2026-01-01T00:00:00Z' }),
  entry('delta', { kind: 'PyScript', api: null, description: 'Deband helper', category: 'Scripts' }),
  entry('echo', { kind: 'PyWheel', api: null, compatible: false, blocker: 'type', reason: 'wheel', installed: true }),
];
const ids = (list: RepositoryEntry[]) => list.map(item => item.id);

describe('repository status and kind', () => {
  it('counts an installed package as installed even when it cannot be installed here', () => {
    expect(entries.map(statusOf)).toEqual(['available', 'installed', 'incompatible', 'available', 'installed']);
  });
  it('groups scripts and wheels as scripts', () => {
    expect(entries.map(kindOf)).toEqual(['plugins', 'plugins', 'plugins', 'scripts', 'scripts']);
  });
  it('labels why a package is incompatible', () => {
    expect(blockerLabel(entries[2])).toBe('No build for this runtime');
    expect(blockerLabel(entries[4])).toBe('Python wheel');
    expect(blockerLabel(entry('x', { compatible: false, blocker: 'dependency' }))).toBe('Dependency issue');
    expect(blockerLabel(entry('x', { compatible: false }))).toBe('Invalid metadata');
  });
});

describe('filterEntries', () => {
  it('filters by status, type, category and search together', () => {
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, status: 'available' }))).toEqual(['Bravo', 'delta']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, kind: 'scripts' }))).toEqual(['delta', 'echo']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, category: 'Other' }))).toEqual(['charlie', 'echo']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, query: '  DEBAND ' }))).toEqual(['delta']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, status: 'installed', kind: 'plugins' }))).toEqual(['alpha']);
  });
});

describe('countEntries', () => {
  it('counts each section over the other sections and the search', () => {
    const counts = countEntries(entries, { ...DEFAULT_FILTERS, kind: 'plugins' });
    expect(counts.status).toEqual({ all: 3, installed: 1, available: 1, incompatible: 1 });
    // The type section ignores its own selection.
    expect(counts.kind).toEqual({ all: 5, plugins: 3, scripts: 2 });
    expect(counts.categories).toEqual([{ key: 'all', count: 3 }, { key: 'Denoising', count: 2 }, { key: 'Other', count: 1 }]);
  });
  it('keeps a selected category listed when nothing matches it', () => {
    const counts = countEntries(entries, { ...DEFAULT_FILTERS, category: 'Scripts', query: 'nothing' });
    expect(counts.categories).toEqual([{ key: 'all', count: 0 }, { key: 'Scripts', count: 0 }]);
  });
});

describe('sortEntries', () => {
  it('sorts by name without regard to case', () => {
    expect(ids(sortEntries(entries, 'name'))).toEqual(['alpha', 'Bravo', 'charlie', 'delta', 'echo']);
  });
  it('sorts newest releases first and undated packages last', () => {
    expect(ids(sortEntries(entries, 'updated'))).toEqual(['charlie', 'alpha', 'Bravo', 'delta', 'echo']);
  });
  it('puts installed packages first', () => {
    expect(ids(sortEntries(entries, 'installed'))).toEqual(['alpha', 'echo', 'Bravo', 'charlie', 'delta']);
  });
  it('puts installable packages first and incompatible ones last', () => {
    expect(ids(sortEntries(entries, 'compatible'))).toEqual(['Bravo', 'delta', 'alpha', 'echo', 'charlie']);
  });
  it('does not change its input', () => {
    const copy = [...entries];
    sortEntries(entries, 'name');
    expect(entries).toEqual(copy);
  });
});

describe('sort storage', () => {
  const store = (initial: Record<string, string> = {}) => {
    const data = { ...initial };
    return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value; } };
  };
  it('round-trips a sort and falls back for missing, invalid or failing storage', () => {
    const storage = store();
    expect(loadSort(storage)).toBe(DEFAULT_SORT);
    saveSort(storage, 'updated');
    expect(storage.data[SORT_STORAGE_KEY]).toBe('updated');
    expect(loadSort(storage)).toBe('updated');
    expect(loadSort(store({ [SORT_STORAGE_KEY]: 'bogus' }))).toBe(DEFAULT_SORT);
    expect(loadSort(undefined)).toBe(DEFAULT_SORT);
    expect(loadSort({ getItem: () => { throw new Error('blocked'); } })).toBe(DEFAULT_SORT);
    expect(() => saveSort({ setItem: () => { throw new Error('blocked'); } }, 'name')).not.toThrow();
  });
});

describe('formatting', () => {
  it('formats release dates and sizes only when known', () => {
    expect(formatUpdated(entries[0])).toBe('2024-01-01');
    expect(formatUpdated(entries[3])).toBe('');
    expect(formatUpdated(entry('x', { updated: 'not a date' }))).toBe('');
    expect(formatSize(undefined)).toBe('');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MiB');
  });
});
