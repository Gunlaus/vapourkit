import { useEffect, useMemo, useState } from 'react';
import { Check, Download, ExternalLink, Info, Loader2, Package, RefreshCw } from 'lucide-react';
import type { RepositoryEntry } from '../../electron/filterRepositoryTypes';
import { VAPOURSYNTH_VERSION } from '../../electron/vapoursynthCore';
import { ask } from '../utils/dialogs';
import { PickerChip, PickerModal, PickerRow, PickerSidebarSection } from './PickerModal';
import {
  DEFAULT_FILTERS, SORT_OPTIONS, blockerLabel, countEntries, filterEntries, formatSize, formatUpdated,
  kindLabel, loadSort, saveSort, sortEntries, statusOf,
} from './repositoryBrowser';
import type { RepositoryFilters, RepositorySort } from './repositoryBrowser';

const API_SUPPORT = Number(VAPOURSYNTH_VERSION) >= 80 ? 'API4' : 'API3 and API4';
const HINT_DETAILS = 'Missing native API metadata follows the VSRepo API3 default, and installation tests that the plugin loads. '
  + 'Installing adds filter templates for single-clip functions whose other arguments are optional; they appear in the filter picker afterward. '
  + 'Other functions and Python scripts are available through Custom/New Filter. Existing plugins and custom files are kept.';
const HEADER_BUTTON = 'h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-accent-500/10 border border-accent-500/40 text-accent-300 hover:bg-accent-500/20 transition-colors disabled:opacity-50 disabled:pointer-events-none';
const ROW_BUTTON = 'h-6 px-2 rounded inline-flex items-center gap-1 text-[11px] font-semibold border transition-colors flex-shrink-0';
const WARN_CHIP = 'inline-flex items-center h-[18px] px-1.5 rounded border border-warn-500/40 bg-warn-500/10 text-warn-400 text-[10px] flex-shrink-0';

const storage = () => (typeof window === 'undefined' ? undefined : window.localStorage);

export function FilterRepositoryModal({ onClose, onInstalled }: { onClose: () => void; onInstalled?: () => Promise<void> }) {
  const [entries, setEntries] = useState<RepositoryEntry[]>([]);
  const [filters, setFilters] = useState<RepositoryFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<RepositorySort>(() => loadSort(storage()));
  const [loading, setLoading] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const busy = loading || installingId !== null;

  const load = async (refresh: boolean) => {
    setLoading(true);
    try { setEntries(await window.electronAPI.listFilterRepository(refresh)); setMessage(null); }
    catch (error) { setMessage({ text: errorText(error), tone: 'error' }); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(false); }, []);

  const install = async (entry: RepositoryEntry) => {
    if (busy) return;
    if (!await ask({ title: 'Install VapourSynth filter', message: 'Download and verify ' + entry.name + ' and its compatible dependencies from VSRepo? Existing plugins and custom files will be kept.', confirmLabel: 'Install' })) return;
    setInstallingId(entry.id); setMessage({ text: 'Installing ' + entry.name + ': downloading, checking hashes and testing plugin loading…', tone: 'info' });
    try {
      const result = await window.electronAPI.installRepositoryFilter(entry.id);
      await onInstalled?.();
      setMessage({ text: result.message, tone: 'info' });
      setEntries(current => current.map(p => p.id === entry.id ? { ...p, installed: true } : p));
    } catch (error) { setMessage({ text: errorText(error), tone: 'error' }); }
    finally { setInstallingId(null); }
  };

  const changeSort = (key: string) => {
    const next = key as RepositorySort;
    setSort(next); saveSort(storage(), next);
  };
  const setFilter = <K extends keyof RepositoryFilters>(key: K, value: RepositoryFilters[K]) => setFilters(current => ({ ...current, [key]: value }));

  const counts = useMemo(() => countEntries(entries, filters), [entries, filters]);
  const visible = useMemo(() => sortEntries(filterEntries(entries, filters), sort), [entries, filters, sort]);
  const installedCount = useMemo(() => entries.filter(entry => entry.installed).length, [entries]);

  return (
    <PickerModal
      title="Get More Filters"
      icon={Package}
      closeLabel="Close filter repository"
      onClose={() => { if (!busy) onClose(); }}
      closeDisabled={busy}
      layer={60}
      headerActions={
        <button type="button" onClick={() => void load(true)} disabled={busy} className={HEADER_BUTTON} title="Download the latest VSRepo catalog">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh Catalog
        </button>
      }
      searchQuery={filters.query}
      onSearchChange={query => setFilter('query', query)}
      searchPlaceholder="Search packages by name, description, namespace, or identifier..."
      sidebar={
        <>
          <PickerSidebarSection
            label="Status"
            className="mb-1"
            options={[
              { key: 'all', label: 'All', count: counts.status.all },
              { key: 'installed', label: 'Installed', count: counts.status.installed },
              { key: 'available', label: 'Available', count: counts.status.available },
              { key: 'incompatible', label: 'Incompatible', count: counts.status.incompatible },
            ]}
            selected={filters.status}
            onSelect={key => setFilter('status', key as RepositoryFilters['status'])}
          />
          <PickerSidebarSection
            label="Type"
            className="mb-1"
            options={[
              { key: 'all', label: 'All Types', count: counts.kind.all },
              { key: 'plugins', label: 'Plugins', count: counts.kind.plugins },
              { key: 'scripts', label: 'Scripts', count: counts.kind.scripts },
            ]}
            selected={filters.kind}
            onSelect={key => setFilter('kind', key as RepositoryFilters['kind'])}
          />
          <PickerSidebarSection
            label="Sort By"
            className="mb-1"
            options={SORT_OPTIONS}
            selected={sort}
            onSelect={changeSort}
          />
          <PickerSidebarSection
            label="Categories"
            options={counts.categories.map(category => ({ ...category, label: category.key === 'all' ? 'All Categories' : category.key }))}
            selected={filters.category}
            onSelect={key => setFilter('category', key)}
          />
        </>
      }
      listTop={
        <>
          <div className="flex items-center gap-2 min-h-[32px] px-3 py-1.5 border-b border-ink-800 text-[11px] text-ink-400">
            <span className="flex-1 min-w-0 truncate">
              Packages from the official VSRepo registry. This R{VAPOURSYNTH_VERSION} runtime supports {API_SUPPORT}.
            </span>
            <span className="flex-shrink-0 w-5 h-5 grid place-items-center text-ink-500 hover:text-ink-200 cursor-help" title={HINT_DETAILS} aria-label={HINT_DETAILS} role="img">
              <Info className="w-3.5 h-3.5" />
            </span>
          </div>
          {message && (
            <div role="status" className={`px-3 py-1.5 border-b text-[11px] whitespace-pre-wrap flex items-start gap-2 ${
              message.tone === 'error' ? 'border-bad-500/30 bg-bad-500/10 text-bad-400' : 'border-ink-800 bg-accent-500/10 text-ink-200'
            }`}>
              {installingId && <Loader2 className="w-3.5 h-3.5 mt-px flex-shrink-0 animate-spin" />}
              <span className="flex-1 min-w-0">{message.text}</span>
            </div>
          )}
        </>
      }
      showPinned={false}
      favorites={[]}
      recents={[]}
      items={visible}
      itemsTitle={filters.query ? 'Search Results' : 'VSRepo Packages'}
      emptyText={loading && !entries.length ? 'Loading the VSRepo catalog…' : entries.length ? 'No matching packages' : 'No packages loaded. Refresh the catalog or check the reported connection error.'}
      renderItem={entry => (
        <RepositoryItem
          key={entry.id}
          entry={entry}
          expanded={expandedId === entry.id}
          installing={installingId === entry.id}
          disabled={busy}
          onToggle={() => setExpandedId(current => current === entry.id ? null : entry.id)}
          onInstall={() => void install(entry)}
        />
      )}
      noun="packages"
      footerExtra={<><span>•</span><span>{installedCount} installed</span></>}
    />
  );
}

function errorText(error: unknown): string {
  // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*': /, '').replace(/^Error: /, '');
}

interface RepositoryItemProps {
  entry: RepositoryEntry;
  expanded: boolean;
  installing: boolean;
  disabled: boolean;
  onToggle: () => void;
  onInstall: () => void;
}

function RepositoryItem({ entry, expanded, installing, disabled, onToggle, onInstall }: RepositoryItemProps) {
  const status = statusOf(entry);
  const updated = formatUpdated(entry);
  const size = formatSize(entry.downloadBytes);

  let action;
  if (status === 'installed') {
    action = <span className={`${ROW_BUTTON} border-ok-700/50 bg-ok-900/40 text-ok-400`}><Check className="w-3 h-3" strokeWidth={3} />Installed</span>;
  } else if (installing) {
    action = <span className={`${ROW_BUTTON} border-accent-500/40 bg-accent-500/10 text-accent-300`}><Loader2 className="w-3 h-3 animate-spin" />Installing…</span>;
  } else {
    action = (
      <button
        type="button"
        onClick={event => { event.stopPropagation(); onInstall(); }}
        disabled={disabled || status === 'incompatible'}
        title={status === 'incompatible' ? entry.reason : 'Install ' + entry.name + ' and its dependencies'}
        className={`${ROW_BUTTON} border-accent-500/40 bg-accent-500/10 text-accent-300 hover:bg-accent-500/20 disabled:opacity-40 disabled:pointer-events-none`}
      >
        <Download className="w-3 h-3" />Install
      </button>
    );
  }

  return (
    <PickerRow
      title={<>{entry.name}{entry.version && <span className="ml-1.5 text-[11px] font-normal text-ink-500">{entry.version}</span>}</>}
      badges={
        <>
          <PickerChip className="text-ink-300">{kindLabel(entry.kind)}</PickerChip>
          {entry.api !== null && <PickerChip>API {entry.api}</PickerChip>}
          {entry.namespace && <PickerChip className="font-mono text-ink-400">{entry.namespace}</PickerChip>}
          {size && <PickerChip>{size}</PickerChip>}
          {updated && <span className="text-[10px] text-ink-500 tabular-nums flex-shrink-0" title="Release date">{updated}</span>}
          {!entry.compatible && <span className={WARN_CHIP} title={entry.reason}>{blockerLabel(entry)}</span>}
        </>
      }
      details={
        <>
          {entry.description && (
            <p className={`text-[11px] text-ink-500 mt-0.5 ${expanded ? 'whitespace-pre-wrap' : 'truncate'}`} title={expanded ? undefined : entry.description}>
              {entry.description}
            </p>
          )}
          {expanded && (
            <div className="mt-1 mb-0.5 pl-2 border-l-2 border-ink-800 space-y-0.5 text-[10.5px]">
              <div className="font-mono text-ink-500 break-all">{entry.id}{entry.category ? ' · ' + entry.category : ''}</div>
              {entry.reason && <div className="text-warn-400 whitespace-pre-wrap">{entry.reason}</div>}
            </div>
          )}
        </>
      }
      noun="package"
      isSelected={false}
      onSelect={onToggle}
      actions={
        <>
          {entry.website && (
            <button
              type="button"
              onClick={event => { event.stopPropagation(); void window.electronAPI.openReleaseUrl(entry.website!); }}
              className="w-6 h-6 rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
              title="Open package website"
              aria-label={'Open the ' + entry.name + ' website'}
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          )}
          {action}
        </>
      }
    />
  );
}
