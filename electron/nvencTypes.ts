/** Shared renderer/main-process status, independent of native runtime modules. */
export interface NvencRuntimeStatus {
  supported: boolean;
  installed: boolean;
  busy: boolean;
  progress: number;
  message: string;
  downloadBytes: number;
  version: string;
}
