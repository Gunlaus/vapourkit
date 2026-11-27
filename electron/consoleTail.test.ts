import { afterAll, beforeEach, expect, it } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { readConsoleTail } from './consoleTail';
const file = path.join(os.tmpdir(), `vk-console-${process.pid}.log`);
beforeEach(async () => { await fs.writeFile(file, 'old line\n日本語\n'); });
afterAll(async () => { await fs.remove(file); });
it('only displays content after the clear cursor and keeps the full diagnostic log', async () => {
  const cursor = (await fs.stat(file)).size;
  expect((await readConsoleTail(file, cursor)).lines).toEqual([]);
  await fs.appendFile(file, 'new line\n');
  expect((await readConsoleTail(file, cursor)).lines).toEqual(['new line']);
  expect(await fs.readFile(file, 'utf8')).toContain('old line\n日本語\nnew line');
});
it('recovers when a log is truncated and limits the visible tail', async () => {
  await fs.writeFile(file, 'one\ntwo\nthree\n');
  expect((await readConsoleTail(file, 1000, 2)).lines).toEqual(['two','three']);
});
