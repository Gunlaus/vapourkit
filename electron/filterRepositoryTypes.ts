/**
 * Why a package cannot be installed: a package Vapourkit pins, an unsupported
 * package type, no build for this runtime, a download host outside the allowed
 * list, a dependency, or invalid file metadata.
 */
export type RepositoryBlocker = 'managed' | 'type' | 'platform' | 'source' | 'dependency' | 'other';
export interface RepositoryEntry {
  id: string; name: string; description: string; kind: string; version: string; api: number | null; namespace: string;
  compatible: boolean; reason: string; installed: boolean;
  /** Set when the package cannot be installed. */
  blocker?: RepositoryBlocker;
  /** The VSRepo category, such as "Denoising". */
  category?: string;
  /** ISO date of the release offered, or of the newest release. */
  updated?: string;
  downloadBytes?: number; website?: string;
}
