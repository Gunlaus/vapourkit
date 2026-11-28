import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
vi.mock('./constants', async () => {
  const p = await import('path'), o = await import('os');
  return { PATHS: { APP_DATA: p.join(o.tmpdir(), `vk shader, import ${process.pid}`) } };
});
vi.mock('./utils', () => ({ getBundledBasePath: () => process.cwd() }));
import { inspectShader, prepareShader, shaderInfo, specializeShader } from './shaders';
import { SHADER_PRESETS, validateShaderSettings } from './shaderTypes';
const root = path.join(os.tmpdir(), `vk shader, import ${process.pid}`);
const file = path.join(root, 'source, 日本語.glsl');
const text = `//!PARAM GAIN
//!DESC Gain
//!TYPE float
//!MINIMUM 0
//!MAXIMUM 2
1

//!PARAM ENABLED
//!TYPE DEFINE
//!MINIMUM 0
//!MAXIMUM 1
1

//!HOOK MAIN
//!BIND HOOKED
//!DESC Test shader
vec4 hook() { return HOOKED_tex(HOOKED_pos) * GAIN; }
`;
beforeEach(async () => { await fs.remove(root); await fs.outputFile(file, text); });
afterAll(async () => { await fs.remove(root); });
describe('GLSL import and declared controls', () => {
  it('reads bounded numeric and boolean controls without running the source', () => {
    expect(inspectShader(text, 'test').parameters).toEqual([
      { name: 'GAIN', description: 'Gain', type: 'float', minimum: 0, maximum: 2, default: 1 },
      { name: 'ENABLED', description: 'ENABLED', type: 'bool', minimum: 0, maximum: 1, default: 1 },
    ]);
    const enumText = text.replace('//!TYPE float\n//!MINIMUM 0\n//!MAXIMUM 2\n1', '//!TYPE ENUM DEFINE\nSoft\nStrong');
    expect(inspectShader(enumText, 'enum').parameters[0]).toMatchObject({ choices: ['Soft', 'Strong'], default: 0, minimum: 0, maximum: 1 });
    expect(inspectShader(text.replace('//!TYPE float', '//!TYPE DYNAMIC float'), 'dynamic').parameters[0].type).toBe('float');
    expect(() => inspectShader('void main() {}', 'generic')).toThrow(/hook shader/);
  });
  it('copies without changing the original and repairs cache damage', async () => {
    const settings = { path: file, scale: 1, parameters: { GAIN: 1.5 } };
    const first = await prepareShader(settings);
    expect(path.basename(first.file)).toBe('shader.glsl');
    expect(await fs.readFile(file, 'utf8')).toBe(text);
    expect((await prepareShader(settings)).file).toBe(first.file);
    await fs.writeFile(first.file, 'damaged');
    await prepareShader(settings);
    expect(await fs.readFile(first.file, 'utf8')).toBe(text);
    await fs.writeFile(file, text.replace('GAIN;', 'GAIN * 0.5;'));
    expect((await prepareShader(settings)).file).not.toBe(first.file);
  });
  it('rejects unknown, out-of-range and unrepresentable parameters before rendering', async () => {
    for (const parameters of [{ UNKNOWN: 1 }, { GAIN: 3 }, { ENABLED: 2 }] as Record<string, number>[]) {
      await expect(prepareShader({ path: file, scale: 1, parameters })).rejects.toThrow(/parameter/);
    }
    expect(() => validateShaderSettings({ path: file, scale: 1, parameters: { GAIN: NaN } })).toThrow(/finite/);
    expect(() => validateShaderSettings({ path: file, scale: 0, parameters: {} })).toThrow(/scale/);
  });
  it('resolves bundled presets by stable id even after a workflow moves machines', async () => {
    for (const preset of SHADER_PRESETS) {
      const settings = { path: '/old-machine/missing.glsl', presetId: preset.id, scale: preset.scale, parameters: {} };
      expect((await shaderInfo(settings)).name).toBe(preset.name);
      const result = await prepareShader(settings);
      expect((await fs.readFile(result.file, 'utf8'))).toMatch(/\/\/!HOOK (MAIN|LUMA)/);
      expect((await fs.readFile(result.file, 'utf8'))).toContain('hook()');
    }
  });
});


it('specializes numeric and enum parameters without losing enum meanings or hook conditions', () => {
  const numeric = specializeShader(text, { GAIN: 1.75, ENABLED: 0 });
  expect(inspectShader(numeric, 'changed').parameters.map(p => p.default)).toEqual([1.75,0]);
  const source = '//!PARAM MODE\n//!TYPE ENUM DEFINE\nSoft\nStrong\n\n//!HOOK MAIN\n//!BIND HOOKED\n//!WHEN MODE Strong =\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }';
  const changed = specializeShader(source, { MODE: 1 });
  expect(changed).toContain('//!WHEN MODE 1 =');
  expect(changed).toContain('#define Strong 1');
  expect(inspectShader(changed, 'enum').parameters[0].default).toBe(1);
});

it('records required rendering hooks so a LINEAR shader is not silently skipped', () => {
  expect(inspectShader(text.replace('//!HOOK MAIN', '//!HOOK LINEAR'), 'linear').hooks).toEqual(['LINEAR']);
});
