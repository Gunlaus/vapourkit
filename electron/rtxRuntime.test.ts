import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
const control = vi.hoisted(() => ({ pip: vi.fn(), probe: vi.fn(), builder: vi.fn() }));
vi.mock('./constants', async () => {
  const p = await import('path'), o = await import('os');
  const root = p.join(o.tmpdir(), `vk-rtx-install-${process.pid}`);
  return { PATHS: { APP_DATA: root, SITE_PACKAGES: p.join(root, 'site'), PLUGINS: p.join(root, 'site', 'vapoursynth', 'plugins') } };
});
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./pip', () => ({
  withPipLock: (fn: () => Promise<unknown>) => fn(),
  pipInstall: (...args: unknown[]) => control.pip(...args),
  runPython: (...args: unknown[]) => control.probe(...args),
  throwIfFailed: (outcome: { ok: boolean }) => { if (!outcome.ok) throw new Error('probe failed'); },
}));
vi.mock('./trtexecShim', () => ({ ensureEngineBuilderScript: () => control.builder() }));
import { installRtxRuntime, rtxRuntimeStatus } from './rtxRuntime';
import { RTX_SPECS } from './providers/tensorrtRtx';
const root = path.join(os.tmpdir(), `vk-rtx-install-${process.pid}`);
beforeEach(async () => {
  await fs.remove(root); vi.clearAllMocks();
  control.pip.mockImplementation(async () => {
    for (const file of ['vapoursynth/plugins/trt_rtx/vstrt_rtx.dll', 'tensorrt_rtx/__init__.py', 'tensorrt_rtx_bindings/__init__.py', 'tensorrt_rtx_libs/tensorrt_rtx_1_7.dll']) {
      await fs.outputFile(path.join(root, 'site', file), 'wheel fixture');
    }
    return { ok: true };
  });
  control.probe.mockResolvedValue({ ok: true });
});
afterAll(async () => { await fs.remove(root); });
describe('optional RTX installation', () => {
  it('pins all four wheels without dependency upgrades and only publishes readiness after a probe', async () => {
    expect(await rtxRuntimeStatus('win32', 'x64')).toMatchObject({ installed: false });
    expect(await installRtxRuntime('win32', 'x64')).toMatchObject({ installed: true, busy: false });
    expect(control.pip).toHaveBeenCalledWith(RTX_SPECS, expect.objectContaining({ extraArgs: ['--no-deps'] }));
    expect(control.probe.mock.calls[0][0][1]).toContain('ensure_plugin');
    expect(control.builder).toHaveBeenCalled();
    await installRtxRuntime('win32', 'x64');
    expect(control.pip).toHaveBeenCalledTimes(1);
  });
  it('does not mark an incomplete or unloadable install ready and allows retry', async () => {
    control.probe.mockResolvedValue({ ok: false });
    await expect(installRtxRuntime('win32', 'x64')).rejects.toThrow('probe failed');
    expect(await rtxRuntimeStatus('win32', 'x64')).toMatchObject({ installed: false, busy: false });
    control.probe.mockResolvedValue({ ok: true });
    expect(await installRtxRuntime('win32', 'x64')).toMatchObject({ installed: true });
    await fs.remove(path.join(root, 'site', 'tensorrt_rtx_libs', 'tensorrt_rtx_1_7.dll'));
    expect(await rtxRuntimeStatus('win32', 'x64')).toMatchObject({ installed: false });
  });
  it('rejects unsupported platforms before touching Python', async () => {
    await expect(installRtxRuntime('linux', 'x64')).rejects.toThrow('Windows x64');
    expect(control.pip).not.toHaveBeenCalled();
  });
});
