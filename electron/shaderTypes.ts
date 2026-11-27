/** Persisted with the filter, queue and workflows. Built-ins resolve by id. */
export interface ShaderSettings {
  path: string;
  name?: string;
  description?: string;
  categories?: string[];
  libraryId?: string;
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
  hooks?: string[];
  name: string;
  description: string;
  parameters: ShaderParameter[];
}
export interface ShaderPreset { id: string; file: string; name: string; description: string; scale: number; categories: string[] }
export interface ShaderLibraryEntry { id: string; path: string; name: string; description: string; categories: string[]; scale: number; builtin: boolean; source?: string; code?: string }
export const SHADER_PRESETS: readonly ShaderPreset[] = [
  { id: 'anime4k-x2-s', file: 'Anime4K_Upscale_CNN_x2_S.glsl', name: 'Anime4K CNN ×2 — Small', description: 'A lightweight neural shader for anime upscaling. Start here for speed.', scale: 2, categories: ['Anime', 'Upscaling'] },
  { id: 'anime4k-x2-m', file: 'Anime4K_Upscale_CNN_x2_M.glsl', name: 'Anime4K CNN ×2 — Medium', description: 'A larger anime upscaler, with more GPU work than Small. Compare detail and artifacts on your source.', scale: 2, categories: ['Anime', 'Upscaling'] },
  { id: 'anime4k-x2-l', file: 'Anime4K_Upscale_CNN_x2_L.glsl', name: 'Anime4K CNN ×2 — Large', description: 'The largest bundled anime upscaler. More expensive; higher speed or quality is not guaranteed.', scale: 2, categories: ['Anime', 'Upscaling'] },
  { id: 'anime4k-restore-s', file: 'Anime4K_Restore_CNN_S.glsl', name: 'Anime4K Restore CNN — Small', description: 'Anime line reconstruction at source size. May alter line art; compare with the original.', scale: 1, categories: ['Anime', 'Restoration'] },
  { id: 'anime4k-bilateral', file: 'Anime4K_Denoise_Bilateral_Mean.glsl', name: 'Anime4K Bilateral Denoise', description: 'Edge-aware spatial smoothing for anime. Fine texture may be softened.', scale: 1, categories: ['Anime', 'Denoising'] },
  { id: 'ravu-lite-ar-r3', file: 'ravu-lite-ar-r3.glsl', name: 'RAVU Lite AR ×2', description: 'General-image luma upscaling with anti-ringing. Suitable for testing on live-action footage; retains chroma through the renderer.', scale: 2, categories: ['Live action', 'General', 'Upscaling'] },
  { id: 'vk-color', file: 'Vapourkit_Color_Controls.glsl', name: 'SDR Color Controls', description: 'Adjust gain, gamma, contrast and saturation. SDR values outside the display range are clipped.', scale: 1, categories: ['General', 'Color correction'] },
  { id: 'vk-warmth', file: 'Vapourkit_Warm_Cool.glsl', name: 'Warm / Cool Tint', description: 'Subtle red-blue balance adjustment for SDR footage.', scale: 1, categories: ['General', 'Live action', 'Color correction'] },
  { id: 'vk-sharpen', file: 'Vapourkit_Gentle_Sharpen.glsl', name: 'Gentle Sharpen', description: 'Lightweight spatial sharpening for anime or live action. Excessive strength can create halos.', scale: 1, categories: ['General', 'Anime', 'Live action', 'Sharpening'] },
  { id: 'vk-gray', file: 'Vapourkit_Grayscale.glsl', name: 'Grayscale', description: 'Convert SDR RGB to luminance while retaining opacity.', scale: 1, categories: ['General', 'Effects', 'Color correction'] },
  { id: 'vk-vignette', file: 'Vapourkit_Vignette.glsl', name: 'Vignette', description: 'Adjustable soft darkening toward the image edges.', scale: 1, categories: ['General', 'Live action', 'Effects'] },
] as const;

export function validateShaderSettings(value: ShaderSettings): void {
  if (!value || typeof value.path !== 'string' || !value.path.toLowerCase().endsWith('.glsl')) throw new Error('Choose a .glsl shader file.');
  if (!Number.isFinite(value.scale) || ![1, 2, 3, 4].includes(value.scale)) throw new Error('Shader output scale must be 1×, 2×, 3× or 4×.');
  if (value.presetId !== undefined && !SHADER_PRESETS.some(p => p.id === value.presetId)) throw new Error('This shader preset is unknown. Choose an installed shader.');
  if (value.presetId && value.scale !== SHADER_PRESETS.find(p => p.id === value.presetId)!.scale) throw new Error('Use the output scale this preset was designed for.');
  if (!value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) throw new Error('Invalid shader parameters.');
  for (const [name, parameter] of Object.entries(value.parameters)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof parameter !== 'number' || !Number.isFinite(parameter)) throw new Error('Shader parameters must have valid names and finite numeric values.');
  }
}
