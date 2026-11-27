import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash } from 'crypto';
import { getBundledBasePath } from './utils';
import { PATHS } from './constants';
import { SHADER_PRESETS, validateShaderSettings, type ShaderSettings, type ShaderInfo, type ShaderParameter } from './shaderTypes';

const MAX_SHADER_BYTES = 8 * 1024 * 1024;
/** Read declarations only. GLSL is compiled by libplacebo, never evaluated as JS/Python. */
export function inspectShader(text: string, name: string): ShaderInfo {
  if (!/^\s*\/\/!HOOK\s+\S+/m.test(text) || !/\b(?:vec4|void)\s+hook\s*\(/.test(text)) throw new Error('Choose an mpv/libplacebo hook shader (.glsl). Generic GLSL and HLSL files are not supported.');
  const parameters: ShaderParameter[] = [];
  const blocks = text.split(/^\s*\/\/!PARAM\s+/m).slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const name = lines.shift()!.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid shader //!PARAM name.');
    const declarations = new Map<string, string>();
    let bodyStart = 0;
    for (; bodyStart < lines.length; bodyStart++) {
      const line = lines[bodyStart];
      if (!line.trim()) continue;
      const item = /^\s*\/\/!(DESC|TYPE|MINIMUM|MAXIMUM)\s+(.+?)\s*$/.exec(line);
      if (!item) break;
      declarations.set(item[1], item[2]);
    }
    const declared = declarations.get('TYPE') ?? '';
    const enumeration = /^ENUM\s+/.test(declared);
    const modeType = declared.replace(/^ENUM\s+/, '').replace(/^(DYNAMIC|CONSTANT)\s+/, '');
    const type = modeType === 'DEFINE' ? 'int' : modeType;
    if (!['float', 'int', 'uint'].includes(type) || (enumeration && type !== 'int')) throw new Error(`Shader parameter ${name} uses unsupported scalar type ${declared}.`);
    const body = lines.slice(bodyStart).join('\n').split(/^\s*\/\/!/m)[0].trim();
    const numeric = (value: string | undefined): number | undefined => {
      if (value === undefined) return undefined;
      if (!value.trim()) throw new Error(`Shader parameter ${name} needs an initial numeric value.`);
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`Shader parameter ${name} needs numeric bounds and an initial value.`);
      return number;
    };
    if (parameters.some(p => p.name === name)) throw new Error(`Duplicate shader parameter ${name}.`);
    const choices = enumeration ? body.split(/\r?\n/).map(v => v.trim()).filter(Boolean) : undefined;
    if (choices && !choices.length) throw new Error(`Shader parameter ${name} has no enum choices.`);
    const minimum = choices ? 0 : numeric(declarations.get('MINIMUM'));
    const maximum = choices ? choices.length - 1 : numeric(declarations.get('MAXIMUM'));
    const parameter: ShaderParameter = { name, description: declarations.get('DESC') ?? name,
      type: modeType === 'DEFINE' && minimum === 0 && maximum === 1 ? 'bool' : type as ShaderParameter['type'],
      default: choices ? 0 : numeric(body)!, minimum, maximum, ...(choices ? { choices } : {}) };
    validateParameter(parameter, parameter.default);
    parameters.push(parameter);
  }
  return { name, hooks: [...new Set([...text.matchAll(/^\s*\/\/!HOOK\s+(\w+)/gm)].map(match => match[1]))], description: /^\s*\/\/!DESC\s+(.+)$/m.exec(text)?.[1]?.trim() ?? 'Custom mpv/libplacebo shader.', parameters };
}
function validateParameter(parameter: ShaderParameter, value: number): void {
  if ((parameter.type === 'float' && Math.abs(value) > 3.4028234663852886e38)
    || (parameter.type === 'int' && (value < -2147483648 || value > 2147483647))
    || (parameter.type === 'uint' && value > 4294967295)
    || (parameter.type !== 'float' && !Number.isInteger(value)) || (parameter.type === 'uint' && value < 0)
    || (parameter.type === 'bool' && value !== 0 && value !== 1)
    || (parameter.minimum !== undefined && value < parameter.minimum) || (parameter.maximum !== undefined && value > parameter.maximum)) {
    throw new Error(`Shader parameter ${parameter.name} is outside its declared type or range.`);
  }
}
export function shaderSource(settings: ShaderSettings): string {
  validateShaderSettings(settings);
  const preset = SHADER_PRESETS.find(p => p.id === settings.presetId);
  return preset ? path.join(getBundledBasePath(), 'include', 'shaders', preset.file) : settings.path;
}
async function shaderBytes(file: string): Promise<Buffer> {
  if (path.extname(file).toLowerCase() !== '.glsl') throw new Error('Choose a .glsl shader file.');
  const stat = await fs.stat(file).catch(() => { throw new Error('Shader file is missing. Import it again from Add filter → GLSL Shader.'); });
  if (!stat.isFile() || stat.size > MAX_SHADER_BYTES) throw new Error('Shader files must be at most 8 MiB.');
  const bytes = await fs.readFile(file);
  if (bytes.length > MAX_SHADER_BYTES) throw new Error('Shader files must be at most 8 MiB.');
  return bytes;
}
export async function shaderInfo(settings: ShaderSettings): Promise<ShaderInfo> {
  const source = shaderSource(settings);
  const info = inspectShader((await shaderBytes(source)).toString('utf8'), settings.name ?? path.basename(source));
  const preset = SHADER_PRESETS.find(p => p.id === settings.presetId);
  return { ...info, name: settings.name ?? preset?.name ?? info.name, description: settings.description ?? preset?.description ?? info.description };
}
/** Import/copy to a content-addressed path, safe for NVEncC's comma-delimited parser. */
export async function prepareShader(settings: ShaderSettings): Promise<{ file: string; info: ShaderInfo }> {
  const source = shaderSource(settings);
  const bytes = await shaderBytes(source);
  const info = inspectShader(bytes.toString('utf8'), settings.name ?? path.basename(source));
  for (const [name, value] of Object.entries(settings.parameters)) {
    const parameter = info.parameters.find(p => p.name === name);
    if (!parameter) throw new Error(`The shader does not declare parameter ${name}. Choose the shader again to reset its controls.`);
    validateParameter(parameter, value);
  }
  const id = createHash('sha256').update(bytes).digest('hex');
  const target = path.join(PATHS.APP_DATA, 'nvencc', 'shader-cache', id, 'shader.glsl');
  await fs.ensureDir(path.dirname(target));
  if (!(await fs.readFile(target).catch(() => Buffer.alloc(0))).equals(bytes)) {
    const { randomUUID } = await import('crypto');
    const stage = target + '.' + randomUUID() + '.tmp';
    try { await fs.writeFile(stage, bytes); await fs.rename(stage, target); }
    finally { await fs.remove(stage); }
  }
  return { file: target, info };
}

/** Bake selected parameter values into a private shader for the VS binding.
 * ENUM labels retain their original numeric meanings through #defines.
 */
export function specializeShader(text: string, parameters: Record<string, number>): string {
  const info = inspectShader(text, 'shader');
  const defines: string[] = [];
  const result = text;
  // Each parameter block ends at the next directive after its initial body.
  const parts = result.split(/(?=^\s*\/\/!PARAM\s+)/m);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const header = /^\s*\/\/!PARAM\s+(\w+)\s*\r?\n/.exec(part);
    if (!header) continue;
    const parameter = info.parameters.find(p => p.name === header[1])!;
    if (!(parameter.name in parameters)) continue;
    validateParameter(parameter, parameters[parameter.name]);
    const lines = part.slice(header[0].length).split(/\r?\n/);
    let body = 0;
    while (body < lines.length && (!lines[body].trim() || /^\s*\/\/!/.test(lines[body]))) body++;
    let end = body;
    while (end < lines.length && !/^\s*\/\/!/.test(lines[end])) end++;
    if (parameter.choices) {
      for (const [i, label] of parameter.choices.entries()) {
        if (!/^[A-Za-z_]\w*$/.test(label)) throw new Error('Shader enum labels must be GLSL identifiers.');
        defines.push(`#define ${label} ${i}`);
      }
      for (let i = 0; i < body; i++) lines[i] = lines[i].replace(/(\/\/!TYPE\s+)ENUM\s+/, '$1');
    }
    lines.splice(body, end - body, String(parameters[parameter.name]), '');
    parts[index] = header[0] + lines.join('\n');
  }
  let specialized = parts.join('');
  for (const definition of defines) {
    const [, label, value] = /^#define (\w+) (\d+)$/.exec(definition)!;
    const token = new RegExp('\\b' + label + '\\b', 'g');
    specialized = specialized.replace(/(^\s*\/\/!(?:WHEN|WIDTH|HEIGHT)\s+)([^\n]*)/gm, (_match, prefix, expression) => prefix + expression.replace(token, value));
  }
  // Put enum aliases in every hook body, after its //! header.
  return defines.length ? specialized.replace(/(^\s*\/\/!HOOK[^\n]*\n(?:\s*\/\/![^\n]*\n)*)/gm, '$1' + defines.join('\n') + '\n') : specialized;
}
export async function prepareVsShader(settings: ShaderSettings): Promise<{ file: string; linearize: boolean; sigmoidize: boolean }> {
  const prepared = await prepareShader(settings);
  const text = specializeShader(await fs.readFile(prepared.file, 'utf8'), settings.parameters);
  const id = createHash('sha256').update(text).digest('hex');
  const target = path.join(PATHS.APP_DATA, 'shaders', 'runtime', id + '.glsl');
  await fs.ensureDir(path.dirname(target));
  if ((await fs.readFile(target, 'utf8').catch(() => null)) !== text) {
    const { randomUUID } = await import('crypto');
    const stage = target + '.' + randomUUID() + '.tmp';
    try { await fs.writeFile(stage, text); await fs.rename(stage, target); } finally { await fs.remove(stage); }
  }
  const hooks = prepared.info.hooks ?? [];
  return { file: target, linearize: hooks.includes('LINEAR') || hooks.includes('SIGMOID'), sigmoidize: hooks.includes('SIGMOID') };
}
