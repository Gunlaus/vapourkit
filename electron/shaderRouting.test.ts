import { describe, expect, it } from 'vitest';
import { useNativeShaders } from './shaderRouting';
import type { NvencRequest } from './nvencPlan';
const request = (): NvencRequest => ({ inputPath: '/in.mkv', outputPath: '/out.mkv', processingFormat: 'vs.YUV420P8',
  encoding: { mode: 'simple', customArgs: '', simple: { codec: 'av1', encoder: 'nvidia', preset: 'p1', quality: 25 } },
  filters: [{ id: 'a', enabled: true, filterType: 'shader', preset: 'test', order: 0, code: '', shader: { path: '/shader.glsl', scale: 1, parameters: {} } }] });
describe('automatic shader routing', () => {
  it('uses native GPU routing for a compatible shader chain', () => {
    const r = request(); r.filters.push({ ...r.filters[0], id: 'b', order: 1 });
    expect(useNativeShaders(r, true, 'win32')).toBe(true);
  });
  it('quietly uses the standard path for CPU, mixed chains, benchmark, segments and missing native support', () => {
    const cpu = request(); cpu.encoding.simple.encoder = 'software';
    const mixed = request(); mixed.filters.push({ id: 'blur', enabled: true, filterType: 'custom', code: 'clip=blur(clip)', preset: 'Blur', order: 1 });
    const model = request(); model.filters = [{ ...model.filters[0], filterType: 'aiModel', modelPath: '/m.engine' }];
    for (const value of [cpu, mixed, model, { ...request(), benchmark: true }, { ...request(), segment: { enabled: true, startFrame: 0, endFrame: 240 } }]) {
      expect(useNativeShaders(value, true, 'win32')).toBe(false);
    }
    expect(useNativeShaders(request(), false, 'win32')).toBe(false);
    expect(useNativeShaders(request(), true, 'linux')).toBe(false);
  });
});
