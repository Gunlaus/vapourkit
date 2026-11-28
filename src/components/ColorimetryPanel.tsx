import { DEFAULT_HDR, type HdrSettings } from '../../electron/hdrSettings';
// src/components/ColorimetryPanel.tsx
import { memo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ColorimetrySettings, VideoInfo } from '../electron';
import { Section } from './Section';

interface ColorimetryPanelProps {
  settings: ColorimetrySettings;
  isProcessing: boolean;
  videoInfo: VideoInfo | null;
  onSettingsChange: (settings: ColorimetrySettings) => void;
}

export const ColorimetryPanel = memo<ColorimetryPanelProps>(({
  settings,
  isProcessing,
  videoInfo,
  onSettingsChange,
}: ColorimetryPanelProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Check if video format is RGB
  const isRgbFormat = videoInfo?.pixelFormat?.toLowerCase().includes('rgb') || 
                      videoInfo?.pixelFormat?.toLowerCase().includes('gbr') ||
                      videoInfo?.pixelFormat?.toLowerCase().includes('bgr');

  // Auto-disable checkbox if RGB is detected
  const handleCheckboxChange = (checked: boolean) => {
    if (isRgbFormat && checked) {
      // Don't allow enabling for RGB
      return;
    }
    onSettingsChange({ ...settings, overwriteMatrix: checked });
  };

  if (settings.hdr?.enabled) {
    const hdr = { ...DEFAULT_HDR, ...settings.hdr };
    const update = (change: Partial<HdrSettings>) => onSettingsChange({ ...settings, hdr: { ...hdr, ...change } });
    const custom = [hdr.sourceMatrix, hdr.sourcePrimaries, hdr.sourceRange, hdr.sourceTransfer].some(value => value && value !== 'auto');
    const select = 'w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-xs';
    return <Section title="Source color" meta={custom ? 'overrides' : 'Auto'} collapsible open={isExpanded} onToggle={() => setIsExpanded(!isExpanded)}>
      <fieldset disabled={isProcessing} className="px-3 py-3 text-xs space-y-3">
        <p className="text-ink-400">{videoInfo?.colorSpace ? `Detected: ${videoInfo.colorSpace}` : 'Unspecified SDR tags use the configured BT.709/BT.601 defaults.'}</p>
        <p className="text-ink-500">Output is managed separately: PQ / BT.2020 / 10-bit.</p>
        <details open={custom || undefined}><summary className="cursor-pointer">Advanced source overrides</summary><div className="mt-2 space-y-2">
          <label className="block">Matrix<select aria-label="HDR source matrix" className={select} disabled={isProcessing || isRgbFormat} value={hdr.sourceMatrix ?? 'auto'} onChange={e => update({ sourceMatrix: e.target.value as HdrSettings['sourceMatrix'] })}>
            <option value="auto">Auto — metadata</option><option value="709">BT.709</option><option value="170m">BT.601 / SMPTE 170M</option><option value="470bg">BT.470BG</option>
          </select></label>
          <label className="block">Primaries<select aria-label="HDR source primaries" className={select} value={hdr.sourcePrimaries ?? 'auto'} onChange={e => update({ sourcePrimaries: e.target.value as HdrSettings['sourcePrimaries'] })}>
            <option value="auto">Auto — metadata</option><option value="709">BT.709</option><option value="170m">SMPTE 170M</option><option value="470bg">BT.470BG</option>
          </select></label>
          <label className="block">Transfer<select aria-label="HDR source transfer" className={select} value={hdr.sourceTransfer} onChange={e => update({ sourceTransfer: e.target.value as HdrSettings['sourceTransfer'] })}>
            <option value="auto">Auto — metadata</option><option value="709">BT.709</option><option value="gamma24">Display gamma 2.4</option><option value="srgb">sRGB</option>
          </select></label>
          <label className="block">Range<select aria-label="HDR source range" className={select} value={hdr.sourceRange ?? 'auto'} onChange={e => update({ sourceRange: e.target.value as HdrSettings['sourceRange'] })}>
            <option value="auto">Auto — metadata</option><option value="limited">Limited</option><option value="full">Full</option>
          </select></label>
          {custom && <button type="button" className="text-accent-400" onClick={() => update({ sourceMatrix: 'auto', sourcePrimaries: 'auto', sourceRange: 'auto', sourceTransfer: 'auto' })}>Reset to Auto</button>}
        </div></details>
      </fieldset>
    </Section>;
  }

  return (
    <Section
      title="Colorimetry"
      meta={settings.overwriteMatrix && !isRgbFormat ? (settings.matrix709 ? 'BT.709' : 'BT.601') : 'off'}
      actions={
        <input
          type="checkbox"
          id="colorimetry-override"
          checked={settings.overwriteMatrix && !isRgbFormat}
          onChange={(e) => handleCheckboxChange(e.target.checked)}
          disabled={isProcessing || isRgbFormat}
          title="Override the video’s colour matrix metadata"
          className="w-3.5 h-3.5 rounded border-ink-700 bg-ink-850 disabled:opacity-40 disabled:cursor-not-allowed"
        />
      }
      collapsible={settings.overwriteMatrix && !isRgbFormat}
      open={isExpanded}
      onToggle={() => setIsExpanded(!isExpanded)}
    >

      {/* RGB Warning */}
      {isRgbFormat && (
        <div className="px-3 py-2 border-b border-ink-900">
          <div className="flex items-start gap-2 p-3 bg-warn-500/10 border border-warn-500/30 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-warn-400 flex-shrink-0 mt-0.5" />
            <p className="text-[12px] text-warn-400">
              Colorimetry override is not available for RGB video formats
            </p>
          </div>
        </div>
      )}

      {/* Expandable Content */}
      {isExpanded && settings.overwriteMatrix && !isRgbFormat && (
        <div className="px-3 py-2.5 space-y-2 border-b border-ink-900">
          {/* Matrix Selection Dropdown */}
          <div className="space-y-2">
            <label className="text-[11px] uppercase tracking-wide text-ink-500 block">
              Select color matrix:
            </label>
            <select
              value={settings.matrix709 ? '709' : '601'}
              onChange={(e) => onSettingsChange({ ...settings, matrix709: e.target.value === '709' })}
              disabled={isProcessing}
              className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12px] focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="709">BT.709 (HD - 720p and above)</option>
              <option value="601">BT.601 (SD - below 720p)</option>
            </select>
            <p className="text-[11px] text-ink-500">
              Does not apply to RGB inputs. Allows you to override the video's color space metadata (e.g. if it's incorrectly tagged). 
            </p>
          </div>
        </div>
      )}
    </Section>
  );
});
