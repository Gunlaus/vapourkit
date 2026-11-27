import * as fs from 'fs-extra';
import * as path from 'path';
import type { VideoProbe } from './videoUtils';

const entries = new Map<string, { expires: number; signature: string; value: Promise<VideoProbe> }>();
const MAX_ENTRIES = 32;
const TTL_MS = 5 * 60 * 1000;

/** Reuse only metadata, never a graph, frames, or a validation result. */
export async function cachedSourceProbe(file: string, executable: string, load: () => Promise<VideoProbe>): Promise<VideoProbe> {
  let signature: string;
  try {
    const stat = await fs.stat(file);
    signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return load(); // Preserve diagnostics for inaccessible files.
  }
  const key = JSON.stringify([path.resolve(file), executable]);
  const previous = entries.get(key);
  if (previous && previous.signature === signature && previous.expires > Date.now()) {
    return structuredClone(await previous.value);
  }
  const entry = { signature, expires: Date.now() + TTL_MS, value: Promise.resolve().then(load) };
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  try {
    const value = await entry.value;
    // Do not pin an unsuccessful probe or one which raced a source replacement.
    let changed = true;
    try {
      const after = await fs.stat(file);
      changed = signature !== `${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
    } catch { /* Do not cache a source that disappeared during the probe. */ }
    if ((!value.streams || changed) && entries.get(key) === entry) entries.delete(key);
    return structuredClone(value);
  } catch (error) {
    if (entries.get(key) === entry) entries.delete(key);
    throw error;
  }
}
