import { z } from 'zod';
import { handleValidated } from './ipcValidation';
import { listCatalogModels, installCatalogModel } from './modelCatalogInstaller';
export function registerModelCatalogHandlers(): void {
  handleValidated('model-catalog-list', z.undefined(), listCatalogModels);
  handleValidated('model-catalog-install', z.object({ id: z.string().min(1).max(80), version: z.string().min(1).max(60), experimental: z.boolean(), accepted: z.boolean() }).strict(), request => installCatalogModel(request.id, request.version, request.experimental, request.accepted));
}
