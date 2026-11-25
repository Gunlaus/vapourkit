// Filtering, sorting and labels for the VSRepo package browser.
import type { RepositoryBlocker, RepositoryEntry } from '../../electron/filterRepositoryTypes';
import { matchesQuery } from './pickerFilters';

export type RepositoryStatus = 'installed' | 'available' | 'incompatible';
export type RepositoryKind = 'plugins' | 'scripts';
export type RepositorySort = 'compatible' | 'name' | 'updated' | 'installed';

export interface RepositoryFilters {
  status: 'all' | RepositoryStatus;
  kind: 'all' | RepositoryKind;
  /** A VSRepo category, or 'all'. */
  category: string;
  /** Search text as typed. */
  query: string;
}

export const DEFAULT_FILTERS: RepositoryFilters = { status: 'all', kind: 'all', category: 'all', query: '' };
export const DEFAULT_SORT: RepositorySort = 'compatible';
export const SORT_STORAGE_KEY = 'vapourkit_repository_sort';

export const SORT_OPTIONS: { key: RepositorySort; label: string }[] = [
  { key: 'compatible', label: 'Compatible first' },
  { key: 'name', label: 'Name (A-Z)' },
  { key: 'updated', label: 'Recently updated' },
  { key: 'installed', label: 'Installed first' },
];

/** Installed wins over incompatible: a package already in the runtime is usable. */
export function statusOf(entry: RepositoryEntry): RepositoryStatus {
  if (entry.installed) return 'installed';
  return entry.compatible ? 'available' : 'incompatible';
}

/** Native plugins, or Python packages (scripts and wheels). */
export function kindOf(entry: RepositoryEntry): RepositoryKind {
  return entry.kind === 'VSPlugin' ? 'plugins' : 'scripts';
}

export function categoryOf(entry: RepositoryEntry): string {
  return entry.category || 'Other';
}

export function kindLabel(kind: string): string {
  if (kind === 'VSPlugin') return 'Plugin';
  if (kind === 'PyScript') return 'Script';
  if (kind === 'PyWheel') return 'Wheel';
  return kind;
}

const BLOCKER_LABELS: Record<RepositoryBlocker, string> = {
  managed: 'Managed by Vapourkit',
  type: 'Unsupported type',
  platform: 'No build for this runtime',
  source: 'Unsupported host',
  dependency: 'Dependency issue',
  other: 'Invalid metadata',
};

/** The short chip text for why a package cannot be installed. */
export function blockerLabel(entry: RepositoryEntry): string {
  if (entry.blocker === 'type' && entry.kind === 'PyWheel') return 'Python wheel';
  return BLOCKER_LABELS[entry.blocker ?? 'other'];
}

function matchesFacet(entry: RepositoryEntry, filters: RepositoryFilters, skip?: 'status' | 'kind' | 'category'): boolean {
  if (skip !== 'status' && filters.status !== 'all' && statusOf(entry) !== filters.status) return false;
  if (skip !== 'kind' && filters.kind !== 'all' && kindOf(entry) !== filters.kind) return false;
  if (skip !== 'category' && filters.category !== 'all' && categoryOf(entry) !== filters.category) return false;
  const query = filters.query.trim().toLowerCase();
  return !query || matchesQuery(query, entry.name, entry.description, entry.namespace, entry.id, entry.category);
}

export function filterEntries(entries: RepositoryEntry[], filters: RepositoryFilters): RepositoryEntry[] {
  return entries.filter(entry => matchesFacet(entry, filters));
}

export interface RepositoryCounts {
  status: Record<'all' | RepositoryStatus, number>;
  kind: Record<'all' | RepositoryKind, number>;
  /** Categories by name, sorted, with 'all' first. */
  categories: { key: string; count: number }[];
}

/**
 * Sidebar counts. Each section counts the entries that pass every other
 * section's filter and the search, so a count is what selecting it shows.
 */
export function countEntries(entries: RepositoryEntry[], filters: RepositoryFilters): RepositoryCounts {
  const status = { all: 0, installed: 0, available: 0, incompatible: 0 };
  const kind = { all: 0, plugins: 0, scripts: 0 };
  const categories = new Map<string, number>();
  for (const entry of entries) {
    if (matchesFacet(entry, filters, 'status')) { status.all++; status[statusOf(entry)]++; }
    if (matchesFacet(entry, filters, 'kind')) { kind.all++; kind[kindOf(entry)]++; }
    if (matchesFacet(entry, filters, 'category')) categories.set(categoryOf(entry), (categories.get(categoryOf(entry)) ?? 0) + 1);
  }
  const total = [...categories.values()].reduce((sum, count) => sum + count, 0);
  // A selected category stays listed even when nothing else matches it.
  if (filters.category !== 'all' && !categories.has(filters.category)) categories.set(filters.category, 0);
  return {
    status,
    kind,
    categories: [{ key: 'all', count: total }, ...[...categories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => ({ key, count }))],
  };
}

const byName = (a: RepositoryEntry, b: RepositoryEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const STATUS_RANK: Record<RepositoryStatus, number> = { available: 0, installed: 1, incompatible: 2 };

/** Milliseconds since the epoch, or -Infinity for a missing or unreadable date. */
function updatedTime(entry: RepositoryEntry): number {
  const time = entry.updated ? Date.parse(entry.updated) : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

/** A sorted copy. Ties fall back to name order. */
export function sortEntries(entries: RepositoryEntry[], sort: RepositorySort): RepositoryEntry[] {
  const compare: (a: RepositoryEntry, b: RepositoryEntry) => number = {
    name: byName,
    // Two missing dates give NaN, which falls through to the name.
    updated: (a: RepositoryEntry, b: RepositoryEntry) => (updatedTime(b) - updatedTime(a)) || byName(a, b),
    installed: (a: RepositoryEntry, b: RepositoryEntry) => Number(b.installed) - Number(a.installed) || byName(a, b),
    compatible: (a: RepositoryEntry, b: RepositoryEntry) => STATUS_RANK[statusOf(a)] - STATUS_RANK[statusOf(b)] || byName(a, b),
  }[sort];
  return [...entries].sort(compare);
}

export function isRepositorySort(value: unknown): value is RepositorySort {
  return SORT_OPTIONS.some(option => option.key === value);
}

/** The stored sort, or the default when storage is empty, invalid or unavailable. */
export function loadSort(storage: Pick<Storage, 'getItem'> | undefined): RepositorySort {
  try {
    const value = storage?.getItem(SORT_STORAGE_KEY);
    return isRepositorySort(value) ? value : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

export function saveSort(storage: Pick<Storage, 'setItem'> | undefined, sort: RepositorySort): void {
  try { storage?.setItem(SORT_STORAGE_KEY, sort); } catch { /* Storage may be unavailable. */ }
}

/** A release date as YYYY-MM-DD, or '' when there is none. */
export function formatUpdated(entry: RepositoryEntry): string {
  const time = updatedTime(entry);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
}

/** A size in MiB with one decimal, or '' when the registry gives none. */
export function formatSize(bytes: number | undefined): string {
  return bytes === undefined ? '' : (bytes / 1024 / 1024).toFixed(1) + ' MiB';
}
