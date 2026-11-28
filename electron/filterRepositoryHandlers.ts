import { z } from 'zod';
import { handleValidated } from './ipcValidation';
import { listRepository, installRepositoryPackage } from './filterRepository';

export function registerFilterRepositoryHandlers(): void {
  handleValidated('filter-repository-list', z.boolean(), listRepository);
  handleValidated('filter-repository-install', z.string().min(1).max(300), installRepositoryPackage);
}
