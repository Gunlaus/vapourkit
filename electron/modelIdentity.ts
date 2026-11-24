import * as path from 'path';
import { createHash } from 'crypto';

/** Keep legacy root names; package-relative paths distinguish immutable imports. */
export function modelMetadataKey(file: string, modelsRoot: string): string {
  const paths = file.includes('\\') || path.win32.isAbsolute(file) ? path.win32 : path.posix;
  const stem = paths.basename(file, paths.extname(file));
  const relative = paths.isAbsolute(file) ? paths.relative(modelsRoot, file) : file;
  if (relative === '..' || relative.startsWith('..' + paths.sep) || paths.isAbsolute(relative)) {
    const identity = paths.join(paths.dirname(file), stem).replace(/\\/g, '/');
    return 'external/' + createHash('sha256').update(identity).digest('hex').slice(0, 16) + '/' + stem;
  }
  return relative.slice(0, relative.length - paths.extname(relative).length).replace(/\\/g, '/');
}
