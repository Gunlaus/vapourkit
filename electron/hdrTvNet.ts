import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { app } from 'electron';
import { PATHS } from './constants';
import { fixAsarPath } from './utils';

/** Keep source models immutable and engine caches outside packaged resources. */
export async function prepareHdrTvNet(): Promise<{ model: string; cache: string }> {
  const bundled = path.join(fixAsarPath(app.getAppPath()), 'include', 'hdrtvnet');
  const manifest = await fs.readJson(path.join(bundled, 'AGCM_LE.json')).catch(() => {
    throw new Error('HDRTVNet++ is missing from this application build. Extract the complete HDRTVNet++ test package.');
  });
  const data = await fs.readFile(path.join(bundled, 'AGCM_LE.onnx'));
  const digest = createHash('sha256').update(data).digest('hex');
  if (digest !== manifest.modelSha256 || manifest.output !== 'BT.2020 PQ RGB [0,1]' || manifest.hallucination !== false) {
    throw new Error('The bundled HDRTVNet++ model failed its integrity or color-contract check. Re-extract the application.');
  }
  const folder = path.join(PATHS.APP_DATA, 'hdrtvnet', digest);
  const model = path.join(folder, 'model.onnx');
  await fs.ensureDir(folder);
  const current = await fs.readFile(model).catch(() => null);
  if (!current || createHash('sha256').update(current).digest('hex') !== digest) {
    const staging = `${model}.${randomUUID()}.tmp`;
    try { await fs.writeFile(staging, data); await fs.move(staging, model, { overwrite: true }); }
    finally { await fs.remove(staging); }
  }
  return { model, cache: path.join(folder, 'engines') };
}
