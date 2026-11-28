import { checkNvencEncoder } from './encodingSupport';
import type { EncodingSupport, NvencEncoder } from './encodingSupportTypes';

/** A default-options capability probe may warn, but cannot veto real settings. */
export async function nvencPreflight(ffmpeg: string, encoder: NvencEncoder, pixelFormat: string,
  isCancelled: () => boolean, confirm: (support: EncodingSupport) => Promise<boolean>): Promise<void> {
  const support = await checkNvencEncoder(ffmpeg, encoder, pixelFormat, isCancelled);
  if (isCancelled()) throw new Error('Canceled');
  if (!support.available && !await confirm(support)) throw new Error('Canceled');
  if (isCancelled()) throw new Error('Canceled');
}
