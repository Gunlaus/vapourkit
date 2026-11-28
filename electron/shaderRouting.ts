import type { NvencRequest } from './nvencPlan';
import { nativeProcessingFilter } from './nvencPlan';
/** GPU-resident optimization only. Everything else stays on the normal chain. */
export function useNativeShaders(request: NvencRequest, installed: boolean, platform: string = process.platform): boolean {
  if (request.colorimetry?.hdr?.enabled) return false;
  if (platform !== 'win32' || !installed || request.benchmark) return false;
  const filters = request.filters.filter(f => f.enabled);
  if (!filters.length || filters.some(f => f.filterType !== 'shader' || f.chain)) return false;
  try { nativeProcessingFilter(request); return true; } catch { return false; }
}
