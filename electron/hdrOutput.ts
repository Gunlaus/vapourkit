import { spawn } from 'child_process';
import { createWorkloadSpawnOptions, terminateProcessTree } from './processLifecycle';

export function assertHdrStream(stream: Record<string, unknown> | undefined): void {
  if (!stream || !['hevc', 'av1'].includes(String(stream.codec_name)) || stream.pix_fmt !== 'yuv420p10le'
      || stream.color_transfer !== 'smpte2084' || stream.color_primaries !== 'bt2020'
      || stream.color_space !== 'bt2020nc' || stream.color_range !== 'tv') {
    throw new Error('HDR output verification failed: expected HEVC/AV1, 10-bit 4:2:0, PQ, BT.2020 and limited range. The file is kept for inspection.');
  }
}

export async function verifyHdrOutput(file: string, ffprobe: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('Canceled');
  const output = await new Promise<string>((resolve, reject) => {
    const proc = spawn(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,pix_fmt,color_transfer,color_space,color_range,color_primaries', '-of', 'json', file],
    createWorkloadSpawnOptions({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    let stdout = '', stderr = '';
    const stop = () => { terminateProcessTree(proc); reject(new Error('Canceled')); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(() => { terminateProcessTree(proc); reject(new Error('HDR output verification timed out.')); }, 30000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    proc.stdout?.on('data', data => {
      stdout += data.toString();
      if (stdout.length > 65536) { terminateProcessTree(proc); reject(new Error('HDR output probe exceeded its output limit.')); }
    });
    proc.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
    proc.once('error', error => { cleanup(); reject(error); });
    proc.once('close', code => { cleanup(); code === 0 ? resolve(stdout) : reject(new Error(`HDR verification failed: ${stderr || `ffprobe exit ${code}`}`)); });
  });
  if (signal.aborted) throw new Error('Canceled');
  assertHdrStream(JSON.parse(output).streams?.[0]);
}
