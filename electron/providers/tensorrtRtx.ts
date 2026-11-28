import * as path from 'path';
import { PATHS } from '../constants';
import { getBackendDescriptor } from './descriptors';
import { resolveOnnxPath } from './onnxPath';
import type { InferenceProvider } from './types';

export const RTX_SPECS = [
  'vapoursynth-mlrt-trt-rtx==17.1',
  'tensorrt-rtx-cu13==1.7.1.116',
  'tensorrt-rtx-cu13-bindings==1.7.1.116',
  'tensorrt-rtx-cu13-libs==1.7.1.116',
];
const pyPath = (file: string) => JSON.stringify(file.replace(/\\/g, '/'));
export const rtxProvider: InferenceProvider = {
  descriptor: getBackendDescriptor('tensorrt-rtx'),
  resolveModelFile: resolveOnnxPath,
  modelCallCode(inputExpr, modelFile, opts) {
    return [
      'import vk_rtx_runtime as _vk_rtx',
      `clip = _vk_rtx.load_model(${inputExpr}, ${pyPath(modelFile)}, streams=${opts.numStreams}, precision="${opts.useFp32 ? 'fp32' : 'fp16'}", use_cuda_graph=${opts.useCudaGraph ? 'True' : 'False'},`,
      `    builder=${pyPath(path.join(PATHS.APP_DATA, 'build_trt_engine.py'))}, python=${pyPath(PATHS.PYTHON)}, cache=${pyPath(path.join(PATHS.APP_DATA, 'tensorrt-rtx', 'engines'))})`,
      '',
    ].join('\n');
  },
  // Optional installation only; the mandatory setup keeps classic TensorRT.
  pipPackages: () => [...RTX_SPECS],
  pluginHealthPaths: () => [[path.join(PATHS.PLUGINS, 'trt_rtx', 'vstrt_rtx.dll')]],
};
