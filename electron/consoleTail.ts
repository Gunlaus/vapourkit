import * as fs from 'fs-extra';
/** Byte cursor clears the view without truncating diagnostic files. */
export async function readConsoleTail(file: string, offset = 0, maxLines = 300, knownSize?: number): Promise<{ lines: string[]; endOffset: number }> {
  const size = knownSize ?? (await fs.stat(file)).size;
  offset = Number.isSafeInteger(offset) && offset >= 0 && offset <= size ? offset : 0;
  const start = Math.max(offset, size - 512 * 1024);
  const fd = await fs.open(file, 'r');
  let text: string;
  try {
    const bytes = Buffer.alloc(size - start);
    const read = await fs.read(fd, bytes, 0, bytes.length, start);
    text = bytes.subarray(0, read.bytesRead).toString('utf8');
  } finally { await fs.close(fd); }
  if (start > offset) {
    const newline = text.indexOf('\n'); text = newline >= 0 ? text.slice(newline + 1) : '';
  }
  return { lines: text.split(/\r?\n/).filter(line => line.trim()).slice(-Math.max(1, Math.min(1000, maxLines))), endOffset: size };
}
