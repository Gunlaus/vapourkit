/** Persisted with the filter, queue and workflows. Built-ins resolve by id. */
export interface ShaderSettings {
  path: string;
  name?: string;
  presetId?: string;
  scale: number;
  parameters: Record<string, number>;
}
export interface ShaderParameter {
  name: string;
  description: string;
  type: 'float' | 'int' | 'uint' | 'bool';
  default: number;
  minimum?: number;
  maximum?: number;
  choices?: string[];
}
export interface ShaderInfo {
  name: string;
  description: string;
  parameters: ShaderParameter[];
}
export const SHADER_PRESETS = [
  { id: 'anime4k-x2-s', file: 'Anime4K_Upscale_CNN_x2_S.glsl', name: 'Anime4K CNN ×2 — Small', description: 'A lightweight neural shader for anime upscaling. Start here for speed.', scale: 2 },
  { id: 'anime4k-x2-m', file: 'Anime4K_Upscale_CNN_x2_M.glsl', name: 'Anime4K CNN ×2 — Medium', description: 'A larger anime upscaler, with more GPU work than Small. Compare detail and artifacts on your source.', scale: 2 },
  { id: 'anime4k-x2-l', file: 'Anime4K_Upscale_CNN_x2_L.glsl', name: 'Anime4K CNN ×2 — Large', description: 'The largest bundled anime upscaler. More expensive; higher speed or quality is not guaranteed.', scale: 2 },
] as const;

export function validateShaderSettings(value: ShaderSettings): void {
  if (!value || typeof value.path !== 'string' || !value.path.toLowerCase().endsWith('.glsl')) throw new Error('Choose a .glsl shader file.');
  if (!Number.isFinite(value.scale) || ![1, 2, 3, 4].includes(value.scale)) throw new Error('Shader output scale must be 1×, 2×, 3× or 4×.');
  if (value.presetId !== undefined && !SHADER_PRESETS.some(p => p.id === value.presetId)) throw new Error('This shader preset is unknown. Choose an installed shader.');
  if (value.presetId && value.scale !== SHADER_PRESETS.find(p => p.id === value.presetId)!.scale) throw new Error('The selected Anime4K preset requires 2× output scale.');
  if (!value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) throw new Error('Invalid shader parameters.');
  for (const [name, parameter] of Object.entries(value.parameters)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof parameter !== 'number' || !Number.isFinite(parameter)) throw new Error('Shader parameters must have valid names and finite numeric values.');
  }
}
