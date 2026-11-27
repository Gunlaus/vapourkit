/** Status for the explicitly installed, optional TensorRT-RTX SDK/plugin. */
export interface RtxRuntimeStatus {
  supported: boolean;
  installed: boolean;
  busy: boolean;
  message: string;
  version: string;
}
