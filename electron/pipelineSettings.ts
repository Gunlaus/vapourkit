import { z } from 'zod';
export const pipelineSettingsSchema = z.object({
  executionBackend: z.enum(['vapoursynth', 'nvencc']).default('vapoursynth'),
  previewHeight: z.number().int().min(180).max(1080).default(720),
  previewFps: z.number().min(0.1).max(5).default(1),
  trtCudaGraphs: z.boolean().default(true),
  frameRequests: z.number().int().min(0).max(32).default(0),
  cpuThreads: z.number().int().min(0).max(128).default(0),
  cacheMiB: z.number().int().min(0).max(65536).default(0),
});
export type PipelineSettings = z.infer<typeof pipelineSettingsSchema>;
export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = pipelineSettingsSchema.parse({});
