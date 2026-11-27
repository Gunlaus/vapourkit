"""Compare the v2.1.0 direct TRT call and managed loader using ONE existing engine.

No engine builds, downloads, video decoder, preview, color conversion or encoder.
Synthetic input isolates inference/loader behavior; absolute FPS is not video FPS.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
MODES = ('original', 'managed', 'managed-graphs')


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', required=True, type=Path)
    parser.add_argument('--compare', action='store_true')
    parser.add_argument('--baseline-engine', type=Path, help='Optional compatible engine saved from the original application; never rebuilt.')
    parser.add_argument('--mode', choices=(*MODES, 'inspect'), default='original')
    parser.add_argument('--width', type=int, default=1920)
    parser.add_argument('--height', type=int, default=1080)
    parser.add_argument('--frames', type=int, default=120)
    parser.add_argument('--warmup', type=int, default=30)
    parser.add_argument('--requests', type=int, default=8)
    parser.add_argument('--streams', type=int, default=2)
    parser.add_argument('--binding', help=argparse.SUPPRESS)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args(argv)
    if not args.engine.is_file(): parser.error('Engine file not found.')
    if args.baseline_engine and not args.baseline_engine.is_file(): parser.error('Baseline engine file not found.')
    if min(args.width, args.height, args.frames, args.warmup) < 1: parser.error('Dimensions and frame counts must be positive.')
    if not 1 <= args.requests <= 32 or not 1 <= args.streams <= 16: parser.error('Requests/streams are outside supported bounds.')
    return args


def original_window(clip, frames):
    # Exact temporal shift expressions from published v2.1.0 scriptGenerator.ts.
    result = []
    for offset in range(-(frames // 2), frames // 2 + 1):
        count = abs(offset)
        result.append(clip[:count] + clip[:-count] if offset < 0 else clip[count:] + clip[-count:] if offset > 0 else clip)
    return result


def consume(clip, requests):
    count = 0
    for _frame in clip.frames(prefetch=requests, backlog=requests): count += 1
    return count


def run(args):
    import vk_model_runtime as runtime
    if args.mode == 'inspect':
        details = runtime.engine_details(args.engine)
        return {'binding': details['inputs'][0]}
    import vapoursynth as vs
    binding = json.loads(args.binding) if args.binding else runtime.engine_details(args.engine)['inputs'][0]
    channels = binding['shape'][1]
    if channels < 3 or channels % 3 or (channels // 3) % 2 == 0: raise ValueError('Requires an odd channel-packed RGB engine.')
    if not runtime.covers(binding, [1, channels, args.height, args.width]): raise ValueError('Requested dimensions are outside this engine profile.')
    dtype = binding['dtype'].lower()
    if dtype not in ('datatype.float', 'float32', 'datatype.half', 'float16'): raise ValueError('Only FP32/FP16 engine interfaces are supported.')
    fmt = vs.RGBH if dtype in ('datatype.half', 'float16') else vs.RGBS
    vs.core.max_cache_size = 512
    clip = vs.core.std.BlankClip(width=args.width, height=args.height, length=args.warmup + args.frames,
        format=fmt, color=[.2, .4, .6], fpsnum=24, fpsden=1)
    count = channels // 3
    window = original_window(clip, count) if args.mode == 'original' else runtime.temporal_window(clip, count)
    supplied = window if count > 1 else clip
    setup_started = time.perf_counter()
    if args.mode == 'original':
        # Same direct call as v2.1.0. Format is taken from the SAME engine's I/O,
        # so its bits-per-sample retry is unnecessary in this controlled test.
        output = vs.core.trt.Model(supplied, engine_path=str(args.engine.resolve()), num_streams=args.streams)
    else:
        output = runtime.load_model(supplied, args.engine.resolve(), args.streams, use_cuda_graph=args.mode == 'managed-graphs')
    import numpy as np
    with output.get_frame(0) as frame:
        if not all(np.isfinite(np.asarray(frame[p])).all() for p in range(frame.format.num_planes)):
            raise RuntimeError('The engine returned nonfinite pixels on the benchmark input.')
    warm_frames = consume(output[:args.warmup], args.requests)
    setup_seconds = time.perf_counter() - setup_started
    started = time.perf_counter()
    frames = consume(output[args.warmup:args.warmup + args.frames], args.requests)
    seconds = time.perf_counter() - started
    if frames != args.frames or warm_frames != args.warmup: raise RuntimeError('Incomplete benchmark frame count.')
    try: actual_runtime = runtime.runtime_identity()
    except Exception as error: actual_runtime = {'inspectionError': str(error)}
    return {'status': 'completed', 'mode': args.mode, 'actualRuntime': actual_runtime, 'vapoursynthVersion': str(vs.__version__), 'engine': str(args.engine.resolve()), 'engineInputType': dtype,
        'inputShape': [1, channels, args.height, args.width], 'outputSize': [output.width, output.height],
        'frames': frames, 'firstFrameFinite': True, 'seconds': seconds, 'fps': frames / seconds, 'setupAndWarmupSeconds': setup_seconds,
        'streams': args.streams, 'requests': args.requests, 'cpuThreads': vs.core.num_threads,
        'cudaGraphsFallback': (str(args.engine.resolve()), args.streams) in runtime._GRAPH_FALLBACKS,
        'scope': 'synthetic RGB inference and host frame delivery; no encode/decode/preview'}


def child(args, mode, binding=None):
    command = [sys.executable, '-I', str(Path(__file__).resolve()), '--engine', str(args.engine.resolve()), '--mode', mode,
        '--width', str(args.width), '--height', str(args.height), '--frames', str(args.frames),
        '--warmup', str(args.warmup), '--requests', str(args.requests), '--streams', str(args.streams)]
    if binding is not None: command.extend(['--binding', json.dumps(binding)])
    # Each mode owns a fresh process, so caches/contexts/VRAM from a prior mode
    # cannot make the next mode slower or keep a previous graph alive.
    try:
        completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300, check=False)
    except subprocess.TimeoutExpired:
        return {'status': 'failed', 'mode': mode, 'error': 'Benchmark exceeded 300 seconds; child process was terminated.'}
    lines = completed.stdout.decode(errors='replace').splitlines()
    result = None
    for line in reversed(lines):
        if not line.startswith('{'): continue
        try: result = json.loads(line); break
        except ValueError: continue
    if completed.returncode or result is None:
        return {'status': 'failed', 'mode': mode, 'error': completed.stderr.decode(errors='replace')[-5000:]}
    return result


def main(argv=None):
    args = arguments(argv)
    if args.compare:
        binding = child(args, 'inspect')
        if 'binding' not in binding: raise RuntimeError(binding.get('error', 'Engine inspection failed.'))
        results = []
        for mode in MODES:
            print('Running ' + mode + ' with the same engine...', file=sys.stderr, flush=True)
            item = child(args, mode, binding['binding'])
            item['comparisonRole'] = 'current-engine'
            results.append(item)
        if args.baseline_engine:
            baseline = argparse.Namespace(**vars(args))
            baseline.engine = args.baseline_engine
            info = child(baseline, 'inspect')
            item = child(baseline, 'original', info['binding']) if 'binding' in info else info
            item['comparisonRole'] = 'baseline-engine'
            results.append(item)
        metadata = {}
        try: metadata = json.loads(Path(str(args.engine) + '.json').read_text(encoding='utf8'))
        except (OSError, ValueError): pass
        if not isinstance(metadata, dict): metadata = {}
        with args.engine.open('rb') as engine_file:
            engine_sha = hashlib.file_digest(engine_file, 'sha256').hexdigest()
        result = {'status': 'completed' if all(r['status'] == 'completed' for r in results) else 'failed',
            'engineSha256': engine_sha,
            'engineRuntime': metadata.get('runtime'), 'engineValidation': metadata.get('validation'),
            'cudaVisibleDevices': os.environ.get('CUDA_VISIBLE_DEVICES'), 'results': results}
    else: result = run(args)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result), flush=True)
    return 1 if result.get('status') == 'failed' else 0


if __name__ == '__main__':
    try: raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
