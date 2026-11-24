import { z } from 'zod';
export const pipelineSettingsSchema = z.object({
  previewHeight: z.number().int().min(180).max(1080).default(720),
  previewFps: z.number().min(0.1).max(5).default(1),
});
export type PipelineSettings = z.infer<typeof pipelineSettingsSchema>;
export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = pipelineSettingsSchema.parse({});
