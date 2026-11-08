import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type EncodeOptions = {
  encoder: string; quality: number; preset: string;
  audioTracks: number[]; subtitleTracks: number[]; copyAudio: boolean;
};
export type NativeSettings = { lastInputDirectory: string; preferredVideoEncoder: string };
export type NativeProfile = { name: string; options: EncodeOptions };
export type EncodeEvent = { status: string; detail: string; outTimeMs: number | null; speed: string | null };
export type MediaInfo = {
  path: string; durationSeconds: number | null; formatName: string | null;
  streams: { index: number; codecType: string; codecName: string | null; language: string | null; title: string | null; width: number | null; height: number | null }[];
};
export type JobRequest = { input: string; output: string; options: EncodeOptions; script: string | null };
export type Job = JobRequest & { id: number; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; error: string | null };
export type QueueSnapshot = { jobs: Job[]; running: boolean; stopRequested: boolean; revision: number };
export type QueueEdit = { type: 'add'; request: JobRequest } | { type: 'remove' | 'retry'; id: number } | { type: 'clearFinished' } | { type: 'applyOptions'; options: EncodeOptions };
export type EncoderCheck = { encoder: string; available: boolean; detail: string };

// This is a typed native contract, not an electronAPI shim. Unported production
// APIs must not return dummy success values or mount the production UI.
export const nativeHost = {
  status: () => invoke<{ host: string; migrationStage: string; platform: string }>('host_status'),
  processing: () => invoke<boolean>('native_processing_status'),
  discover: (tool: string) => invoke<{ tool: string; available: boolean; detail: string; source: string; path: string }>('discover_dependency', { tool }),
  inspect: (path: string) => invoke<MediaInfo>('inspect_media', { path }),
  encode: (request: JobRequest) => invoke<'completed' | 'cancelled'>('encode_sample', request),
  cancel: () => invoke<boolean>('cancel_sample'),
  loadSettings: () => invoke<NativeSettings>('load_native_settings'),
  saveSettings: (settings: NativeSettings) => invoke<void>('save_native_settings', { settings }),
  profiles: () => invoke<NativeProfile[]>('list_native_profiles'),
  saveProfile: (profile: NativeProfile) => invoke<void>('save_native_profile', { profile }),
  deleteProfile: (name: string) => invoke<void>('delete_native_profile', { name }),
  preflight: () => invoke<{ available: boolean; python: string; version: string; detail: string }>('vapoursynth_preflight'),
  checkScript: (script: string) => invoke<{ valid: boolean; details: string; script: string }>('inspect_vapoursynth_script', { script }),
  queue: () => invoke<QueueSnapshot>('native_queue_snapshot'),
  editQueue: (edit: QueueEdit) => invoke<QueueSnapshot>('edit_native_queue', { edit }),
  runQueue: () => invoke<void>('run_native_queue'),
  stopQueue: () => invoke<QueueSnapshot>('stop_native_queue'),
  pick: (kind: 'video' | 'script') => invoke<string | null>('select_native_file', { kind }),
  pickOutput: () => invoke<string | null>('select_native_output'),
  frame: (path: string, seconds: number, width = 960) => invoke<ArrayBuffer>('read_native_frame', { path, seconds, width }),
  checkEncoder: (encoder: string) => invoke<EncoderCheck>('check_native_encoder', { encoder }),
  onProgress: (callback: (event: EncodeEvent) => void) => listen<EncodeEvent>('native-encode-progress', e => callback(e.payload)),
  onQueue: (callback: (queue: QueueSnapshot) => void) => listen<QueueSnapshot>('native-queue-changed', e => callback(e.payload)),
  onCloseBlocked: (callback: (message: string) => void) => listen<string>('native-close-blocked', e => callback(e.payload)),
};
