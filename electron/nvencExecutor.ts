import { pipelineResult } from './pipelineResult';
import { prepareShader } from './shaders';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { PATHS } from './constants';
import { FFmpegManager } from './ffmpegManager';
import { findChosenGpu, getGpuChoice, type GpuInfo } from './gpuSelection';
import { createWorkloadSpawnOptions, terminateProcessTree } from './processLifecycle';
import { fixAsarPath, setupVSEnvironment } from './utils';
import { logger } from './logger';
import { LineSplitter } from './lineSplitter';
import { ReportedRunError } from './errorMessageHandler';
import type { UpscaleProgress } from './upscaleExecutor';
import { acquireNvencRuntime, nvencExecutable } from './nvencRuntime';
import { nativeProcessingFilter, nvencArgs, selectedOrdinals, sourceVideo, verifyNativeOutput, type NativeProbe, type NvencRequest } from './nvencPlan';

export interface NativeProgress { frames: number; fps: number; percentage: number | null }
export function parseNativeProgress(line: string): NativeProgress | null {
  const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const progress = /(?:\[\s*([\d.]+)%\]\s*)?(\d+)\s+frames:\s*([\d.]+)\s+fps/i.exec(clean);
  if (progress) return { frames: Number(progress[2]), fps: Number(progress[3]), percentage: progress[1] === undefined ? null : Number(progress[1]) };
  const final = /encoded\s+(\d+)\s+frames,\s*([\d.]+)\s+fps/i.exec(clean);
  return final ? { frames: Number(final[1]), fps: Number(final[2]), percentage: null } : null;
}

/** One cancellable NVEncC process; final output is published only after track checks. */
export class NvencExecutor {
  private stopped = false;
  private child: ChildProcess | null = null;
  onDiagnostic?: (message: string) => void;
  constructor(private readonly window: BrowserWindow | null, private readonly python: string, private readonly platform: NodeJS.Platform = process.platform) {}
  get isStopped(): boolean { return this.stopped; }
  cancel(): void { this.stopped = true; if (this.child) terminateProcessTree(this.child); }
  kill(): void { this.cancel(); }
  private check(): void { if (this.stopped) throw new Error('Canceled'); }
  private log(message: string): void { logger.upscale(message); this.onDiagnostic?.(message); }
  private send(progress: UpscaleProgress): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('upscale-progress', progress);
      this.window.setProgressBar(progress.type === 'progress' ? progress.percentage / 100 : -1);
    }
  }

  private command(executable: string, args: string[], env: NodeJS.ProcessEnv, onLine?: (line: string) => void, timeout = 0): Promise<string> {
    this.check();
    return new Promise((resolve, reject) => {
      const proc = spawn(executable, args, createWorkloadSpawnOptions({ windowsHide: true, cwd: path.dirname(executable), env, stdio: ['ignore', 'pipe', 'pipe'] }));
      this.child = proc;
      let stdout = '', stderr = '';
      const out = new StringDecoder('utf8'), err = new StringDecoder('utf8');
      const lines = new LineSplitter(line => onLine?.(line));
      const timer = timeout ? setTimeout(() => { terminateProcessTree(proc); reject(new Error(`NVEncC setup command timed out after ${timeout / 1000} seconds.`)); }, timeout) : null;
      proc.stdout?.on('data', (data: Buffer) => { const s = out.write(data); stdout = (stdout + s).slice(-4 * 1024 * 1024); if (onLine) lines.push(s); });
      proc.stderr?.on('data', (data: Buffer) => { const s = err.write(data); stderr = (stderr + s).slice(-128 * 1024); if (onLine) lines.push(s); });
      proc.once('error', error => { if (timer) clearTimeout(timer); if (this.child === proc) this.child = null; reject(error); });
      proc.once('close', code => {
        if (timer) clearTimeout(timer);
        const outTail = out.end(), errTail = err.end();
        stdout += outTail; stderr += errTail;
        if (onLine) { lines.push(outTail); lines.push(errTail); lines.flush(); }
        if (this.child === proc) this.child = null;
        if (this.stopped) reject(new Error('Canceled'));
        else if (code !== 0) reject(new Error(`NVEncC command failed (exit ${code}): ${(stderr || stdout).slice(-6000)}`));
        else resolve(stdout);
      });
    });
  }

  private async probe(file: string, packets = false): Promise<NativeProbe> {
    const executable = FFmpegManager.getFFprobePath();
    if (!executable) throw new Error('FFprobe is missing. Repair FFmpeg in Setup before using NVEncC.');
    return JSON.parse(await this.command(executable, ['-v', 'error', ...(packets ? ['-count_packets'] : []), '-show_streams', '-show_format', '-of', 'json', file], process.env, undefined, packets ? 120000 : 30000));
  }

  private async sourceModel(file: string): Promise<string> {
    if (/\.onnx$/i.test(file) && await fs.pathExists(file)) return file;
    if (!/\.engine$/i.test(file)) throw new Error('Choose an ONNX model or a TensorRT engine with its original ONNX model available.');
    const candidates: string[] = [];
    try {
      const manifest = await fs.readJson(file + '.json');
      if (typeof manifest.sourceRelative === 'string') candidates.push(path.resolve(path.dirname(file), manifest.sourceRelative));
    } catch { /* Legacy engines are paired by filename. */ }
    candidates.push(file.replace(/\.engine$/i, '.onnx'), file.replace(/_(fp16|fp32|bf16)\.engine$/i, '.onnx'));
    for (const source of candidates) if (/\.onnx$/i.test(source) && await fs.pathExists(source)) return source;
    throw new Error('NVEncC needs the original ONNX beside this engine. Restore/reimport its model package; existing TensorRT engine files cannot be reused by this backend.');
  }

  private checkedSource: { file: string; probe: NativeProbe } | null = null;
  /** Check metadata while this executor is in the cancellable job slot. */
  async supportsShaderSource(file: string): Promise<boolean> {
    const probe = await this.probe(file);
    this.check();
    try { sourceVideo(probe, true); }
    catch { return false; }
    const video = probe.streams.find(s => s.codec_type === 'video')!;
    // Consumer NVDEC does not decode 10-bit H.264; the standard path can.
    if (video.codec_name === 'h264' && video.pix_fmt === 'yuv420p10le') return false;
    this.checkedSource = { file, probe };
    return true;
  }

  async execute(request: NvencRequest, useFp32: (file: string) => boolean, modelType: (file: string) => string): Promise<void> {
    if (this.platform !== 'win32') throw new Error('This NVEncC test backend currently supports Windows x64. Select VapourSynth execution.');
    const filter = nativeProcessingFilter(request);
    const isShader = filter.filterType === 'shader';
    if (!isShader && modelType(filter.modelPath!) !== 'image') throw new Error('NVEncC currently supports image models. Select VapourSynth execution for temporal models.');
    const release = await acquireNvencRuntime();
    const extension = path.extname(request.outputPath);
    const stage = path.join(path.dirname(request.outputPath), `.${path.basename(request.outputPath, extension)}.nvencc-${randomUUID()}${extension}`);
    const started = Date.now();
    let frames = 0, planned = 0, fps = 0;
    let zeroCopy: boolean | null = null;
    let buildStatus = false;
    let setupMs = 0, nativeProcessMs = 0, verificationMs = 0;
    try {
      this.check();
      if (await fs.pathExists(request.outputPath)) throw new Error('The output file already exists. Choose a new filename; the NVEncC test backend never overwrites an existing video.');
      await fs.ensureDir(path.dirname(request.outputPath));
      const source = this.checkedSource?.file === request.inputPath ? this.checkedSource.probe : await this.probe(request.inputPath);
      const video = sourceVideo(source, isShader);
      const rate = (video.avg_frame_rate ?? '').split('/').map(Number);
      const averageFps = rate.length === 2 && rate[1] ? rate[0] / rate[1] : 0;
      planned = Number(video.nb_frames) || Math.round(Number(source.format?.duration ?? video.duration) * averageFps) || 0;
      this.send({ type: 'progress', currentFrame: 0, totalFrames: planned, fps: 0, percentage: 0, message: 'Preparing NVEncC GPU backend…' });
      let resourcePath: string;
      let shaderResources: string[] = [];
      let shaderFlags: Array<{ linearize: boolean; sigmoidize: boolean }> = [];
      let label: string;
      let engineIdentity = '';
      if (isShader) {
        const runtimeFiles = await fs.readdir(path.dirname(nvencExecutable()));
        if (!runtimeFiles.some(name => /^libplacebo.*\.dll$/i.test(name))) {
          throw new Error('The NVEncC libplacebo runtime is missing. Repair NVIDIA shader acceleration from Add filter → GLSL Shader.');
        }
        const shaders = request.filters.filter(f => f.enabled).sort((a,b) => a.order-b.order);
        const prepared = await Promise.all(shaders.map(step => prepareShader(step.shader!)));
        shaderResources = prepared.map(p => p.file);
        shaderFlags = prepared.map(p => ({ linearize: (p.info.hooks ?? []).some(h => h === 'LINEAR' || h === 'SIGMOID'), sigmoidize: (p.info.hooks ?? []).includes('SIGMOID') }));
        resourcePath = shaderResources[0];
        label = prepared.map(p => p.info.name).join(' → ');
        this.log('[nvencc] GLSL shader processing through libplacebo; no AI model or TensorRT engine build is required. The GPU driver compiles the shader on use.');
      } else {
        const sourcePath = await this.sourceModel(filter.modelPath!);
        const cache = path.join(PATHS.APP_DATA, 'nvencc', 'model-cache');
        const adapter = fixAsarPath(path.join(app.getAppPath(), 'include', 'prepare_nvencc_model.py'));
        this.log('[nvencc] Preparing a cached model adapter; the original model and engine remain untouched.');
        const prepared = JSON.parse(await this.command(this.python, ['-I', adapter, '--source', sourcePath, '--cache', cache, '--contract-cache', path.join(PATHS.APP_DATA, 'model-contracts')], setupVSEnvironment(this.python), undefined, 300000)) as { model: string; engineIdentity?: string; inputShape: Array<string | number>; outputShape: Array<string | number> };
        for (const [index, actual] of [[2, video.height!], [3, video.width!]]) {
          const expected = prepared.inputShape[index];
          if (typeof expected === 'number' && expected > 0 && expected !== actual) throw new Error(`This ONNX model requires ${prepared.inputShape[3]}x${prepared.inputShape[2]} input; this source is ${video.width}x${video.height}. Choose a dynamic model or VapourSynth execution.`);
        }
        resourcePath = prepared.model;
        label = path.basename(sourcePath);
        engineIdentity = prepared.engineIdentity ?? path.basename(path.dirname(prepared.model));
      }
      let device = 0;
      const choice = getGpuChoice();
      if (choice) {
        const devices = JSON.parse(await this.command(this.python, ['-I', fixAsarPath(path.join(app.getAppPath(), 'include', 'vk_gpus.py'))], process.env, undefined, 15000)) as GpuInfo[];
        this.check();
        const selected = findChosenGpu(devices, choice);
        if (selected?.cuda === null || selected?.cuda === undefined) throw new Error('The selected GPU has no CUDA device. Select an NVIDIA GPU or use VapourSynth execution.');
        device = selected.cuda;
      }
      const executable = nvencExecutable();
      // command() runs in the executable directory. Both caches and runtime are
      // under data/nvencc, so a relative path omits arbitrary install-directory
      // characters that NVEncC's comma-delimited filter parser cannot escape.
      const modelArgument = path.relative(path.dirname(executable), resourcePath);
      // NVEncC fingerprints model.onnx itself, not its external weights.bin.
      // Namespace its cache by the complete prepared source identity as well.
      const engineCache = path.join(PATHS.APP_DATA, 'nvencc', 'engine-cache', engineIdentity);
      const shaderArguments = shaderResources.map(file => path.relative(path.dirname(executable), file));
      const args = nvencArgs(request, source, isShader ? shaderArguments : modelArgument, engineCache, !isShader && useFp32(filter.modelPath!) ? 'fp32' : 'fp16', stage, device, shaderFlags);
      if (!isShader) await fs.ensureDir(engineCache);
      const env = { ...process.env, PATH: path.dirname(executable) + path.delimiter + (process.env.PATH ?? '') };
      // Preserve user-supplied device masks. Both enumeration and NVEncC use
      // this same environment, so the CUDA ordinals stay consistent.
      this.log(isShader ? '[nvencc] Shader preview is not available in this first version. Encode a short source clip to compare the result.' : '[nvencc] First use builds a separate engine cache. Live encoding preview is unavailable; dedicated preview still uses VapourSynth.');
      this.log('[nvencc] Command: ' + JSON.stringify([executable, ...args]));
      setupMs = Date.now() - started;
      const nativeStarted = Date.now();
      await this.command(executable, args, env, line => {
        if (/cuda-zerocopy/i.test(line)) zeroCopy = true;
        if (/ホスト経路|テンソル転送経路|fallback.*host|host.*fallback/i.test(line)) zeroCopy = false;
        const progress = parseNativeProgress(line);
        if (progress) {
          frames = progress.frames; fps = progress.fps;
          const percentage = Math.min(99.5, progress.percentage ?? (planned ? frames / planned * 100 : 0));
          this.send({ type: 'progress', currentFrame: frames, totalFrames: planned, fps, percentage, message: `NVEncC: ${frames}${planned ? '/' + planned : ''} frames @ ${fps.toFixed(1)} FPS` });
          if (buildStatus) { this.window?.webContents.send('engine-build-progress', { status: 'idle' }); buildStatus = false; }
        } else {
          this.log('[nvencc] ' + line);
          if (!isShader && !buildStatus && /(?:building|build).*engine|engine.*(?:building|build)/i.test(line)) {
            buildStatus = true;
            this.window?.webContents.send('engine-build-progress', { status: 'building', label, message: 'NVEncC is preparing its TensorRT engine cache.' });
          }
        }
      });
      nativeProcessMs = Date.now() - nativeStarted;
      const verificationStarted = Date.now();
      this.check();
      if (!(await fs.stat(stage)).size) throw new Error('NVEncC produced an empty output file.');
      const result = await this.probe(stage, true);
      verifyNativeOutput(source, result, request);
      const outputVideo = result.streams.find(s => s.codec_type === 'video')!;
      frames = Number(outputVideo.nb_frames ?? outputVideo.nb_read_packets) || frames;
      if (!frames) throw new Error('NVEncC completed without a readable encoded frame count.');
      this.check();
      await fs.move(stage, request.outputPath, { overwrite: false });
      verificationMs = Date.now() - verificationStarted;
      const elapsed = Math.max(1, Date.now() - started);
      this.log('[pipeline-summary] ' + JSON.stringify({ status: 'completed', backend: 'nvencc', processing: isShader ? 'shader' : 'onnx', filter: label, plannedFrames: planned, plannedFramesEstimated: !Number(video.nb_frames), encodedFrames: frames,
        elapsedMs: elapsed, setupMs, nativeProcessMs, verificationMs, averagePipelineFps: frames * 1000 / elapsed, nativeReportedFps: fps, gpuTensorSharingConfirmed: isShader ? null : zeroCopy, audioTracks: request.encoding.simple.audioCodec === 'none' ? [] : selectedOrdinals(source, 'audio', request.encoding.audioTracks), subtitleTracks: selectedOrdinals(source, 'subtitle', request.encoding.subtitleTracks) }));
      if (!isShader && zeroCopy !== true) this.log('[nvencc] GPU tensor sharing was not confirmed. Include this log when reporting performance; this run is not proof of a fully GPU-resident inference path.');
      this.log(pipelineResult(frames, elapsed));
      this.send({ type: 'complete', currentFrame: frames, totalFrames: frames, fps: frames * 1000 / elapsed, percentage: 100, message: 'Processing completed successfully!' });
    } catch (error) {
      this.log('[pipeline-summary] ' + JSON.stringify({ status: this.stopped ? 'cancelled' : 'failed', backend: 'nvencc', encodedFrames: frames, elapsedMs: Date.now() - started }));
      if (!this.stopped) this.send({ type: 'error', currentFrame: frames, totalFrames: planned, fps, percentage: 0, message: error instanceof Error ? error.message : String(error) });
      throw this.stopped ? error : new ReportedRunError(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.child) terminateProcessTree(this.child);
      this.window?.webContents.send('engine-build-progress', { status: 'idle' });
      await fs.remove(stage).catch(() => {});
      release();
    }
  }
}
