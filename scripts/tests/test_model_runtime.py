"""CPU tests for real ONNX contracts and mocked CUDA/plugin boundaries."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch, MagicMock
import numpy as np
import onnx
from onnx import helper, TensorProto

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'include'))
import vk_model_runtime as runtime
import build_trt_engine as builder


def model(file, channels=3, rank=4, external=False):
    shape = [1, channels, 'h', 'w'] if rank == 4 else [1, 5, 3, 'h', 'w']
    a = helper.make_tensor_value_info('pixels', TensorProto.FLOAT, shape)
    b = helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 3, 'h', 'w'])
    weights = onnx.numpy_helper.from_array(np.ones((1,), np.float32), name='weight')
    graph = helper.make_graph([helper.make_node('Identity', ['pixels'], ['output'])], 'test', [a], [b], [weights])
    onnx.save_model(helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=10), file, save_as_external_data=external, all_tensors_to_one_file=True, location='weights.bin', size_threshold=0)


class ModelRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def test_real_graph_and_external_weights_are_fingerprinted(self):
        source = self.root / 'model.onnx'; model(source, external=True)
        a = runtime.graph_contract(source)
        self.assertEqual(a['inputs'][0]['name'], 'pixels')
        self.assertEqual(len(a['files']), 2)
        weights = self.root / 'weights.bin'
        weights.write_bytes(weights.read_bytes() + b'changed')
        self.assertNotEqual(runtime.graph_contract(source)['files'], a['files'])
        weights.unlink()
        with self.assertRaisesRegex(RuntimeError, 'external weights'): runtime.graph_contract(source)
    def test_symbolic_output_channels_are_resolved_without_editing_source(self):
        source = self.root / 'symbolic.onnx'; model(source)
        graph = onnx.load(source)
        channel = graph.graph.output[0].type.tensor_type.shape.dim[1]
        channel.ClearField('dim_value'); channel.dim_param = 'Divoutput_dim_1'
        onnx.save(graph, source)
        before = source.read_bytes()
        self.assertEqual(runtime.graph_contract(source)['outputs'][0]['shape'][1], 3)
        self.assertEqual(source.read_bytes(), before)

    def test_inferred_non_rgb_and_unresolved_outputs_remain_rejected(self):
        source = self.root / 'not-rgb.onnx'
        for shape, operation in [([1, 1, 'h', 'w'], 'Identity'), ([1, 'unknown', 'h', 'w'], 'UnknownCustom')]:
            a = helper.make_tensor_value_info('pixels', TensorProto.FLOAT, [1, 3, 'h', 'w'])
            b = helper.make_tensor_value_info('output', TensorProto.FLOAT, shape)
            node = helper.make_node(operation, ['pixels'], ['output'], domain='custom' if operation == 'UnknownCustom' else '')
            onnx.save(helper.make_model(helper.make_graph([node], 'test', [a], [b]), opset_imports=[helper.make_opsetid('', 13), helper.make_opsetid('custom', 1)]), source)
            with self.assertRaisesRegex(RuntimeError, 'three output channels'): runtime.graph_contract(source)

    def test_warm_engine_integrity_cache_invalidates_when_file_changes(self):
        engine = self.root / 'model.engine'; engine.write_bytes(b'original')
        with patch.object(runtime, 'digest', wraps=runtime.digest) as hash_file:
            first = runtime.cached_digest(engine)
            self.assertEqual(runtime.cached_digest(engine), first)
            self.assertEqual(hash_file.call_count, 1)
            engine.write_bytes(b'new engine contents')
            self.assertNotEqual(runtime.cached_digest(engine), first)
            self.assertEqual(hash_file.call_count, 2)

    def test_even_windows_and_five_dimensional_tensors_are_not_guessed(self):
        for channels, rank in [(6, 4), (3, 5), (1, 4)]:
            source = self.root / 'model.onnx'; model(source, channels, rank)
            with self.assertRaises(RuntimeError): runtime.graph_contract(source)
    def test_profile_range_is_checked_without_assuming_1080p(self):
        binding = {'shape': [1, 3, -1, -1], 'profiles': [[[1, 3, 64, 64], [1, 3, 720, 1280], [1, 3, 2160, 3840]]]}
        self.assertTrue(runtime.covers(binding, [1, 3, 2160, 3840]))
        self.assertFalse(runtime.covers(binding, [1, 3, 2161, 3840]))
        self.assertFalse(runtime.covers(binding, [1, 15, 720, 1280]))
        self.assertFalse(runtime.covers({'shape': [1, 3, 64, 64]}, [1, 3, 128, 128]))
    def test_actual_engine_io_selects_rgb_type(self):
        fake = types.SimpleNamespace(RGBS=32, RGBH=16, core=MagicMock())
        fake.core.resize.Point.side_effect = lambda clip, format: (clip, format)
        with patch.dict(sys.modules, {'vapoursynth': fake}):
            runtime.raw_model(['frame'], 'test.engine', 2, {'inputs': [{'dtype': 'DataType.FLOAT'}]})
            fake.core.trt.Model.assert_called_with([('frame', 32)], engine_path='test.engine', num_streams=2)
    def test_failed_postbuild_validation_keeps_previous_engine(self):
        source = self.root / 'model.onnx'; model(source)
        target = self.root / 'model.engine'; target.write_bytes(b'working engine')
        def fake_build(opts): Path(opts['save_engine']).write_bytes(b'unverified engine'); return 0
        with patch.dict(sys.modules, {'tensorrt': types.SimpleNamespace()}), patch.object(builder, 'build', fake_build), patch.object(runtime, 'validate_engine', side_effect=RuntimeError('bad output')):
            status = builder.main(['--vkAdapter=rgb-window-v1','--onnx=' + str(source), '--saveEngine=' + str(target)])
        self.assertEqual(status, 1)
        self.assertEqual(target.read_bytes(), b'working engine')
        self.assertEqual(list(self.root.glob('*.candidate-*')), [])
    def test_accuracy_retry_disables_tf32_and_publishes_only_after_passing(self):
        source=self.root/'retry.onnx'; model(source)
        target=self.root/'retry.engine'; target.write_bytes(b'previous')
        modes=[]
        def build_candidate(opts):
            modes.append(opts['no_tf32'])
            Path(opts['save_engine']).write_bytes(b'strict' if opts['no_tf32'] else b'candidate')
            return 0
        def validate(file,opts):
            self.assertEqual(target.read_bytes(),b'previous')
            if not opts['no_tf32']: raise runtime.EngineValidationError('accuracy-mismatch',{'maxAbsoluteError':0.1})
            return {'schema':1,'validation':{'accuracy':{'status':'passed'}}}
        fake_trt=types.SimpleNamespace(BuilderFlag=types.SimpleNamespace(TF32=1))
        with patch.dict(sys.modules,{'tensorrt':fake_trt}),patch.object(builder,'build',build_candidate),patch.object(runtime,'validate_engine',validate):
            status=builder.main(['--vkAdapter=rgb-window-v1','--onnx='+str(source),'--saveEngine='+str(target),'--fp16'])
        self.assertEqual(status,0); self.assertEqual(modes,[False,True]); self.assertEqual(target.read_bytes(),b'strict')
        saved=json.loads(Path(str(target)+'.json').read_text())
        self.assertTrue(saved['validation']['noTF32'])
        self.assertEqual(len(saved['validation']['buildAttempts']),2)
        self.assertEqual(json.loads(Path(str(target)+'.validation-report.json').read_text())['status'],'passed')

    def test_accuracy_retry_is_bounded_and_layout_errors_do_not_retry(self):
        source=self.root/'failed.onnx'; model(source)
        fake_trt=types.SimpleNamespace(BuilderFlag=types.SimpleNamespace(TF32=1))
        for kind,expected_attempts in [('accuracy-mismatch',2),('shape-mismatch',1),('nonfinite-output',1)]:
            with self.subTest(kind=kind):
                target=self.root/(kind+'.engine'); target.write_bytes(b'previous')
                modes=[]
                def build_candidate(opts): modes.append(opts['no_tf32']); Path(opts['save_engine']).write_bytes(b'unverified'); return 0
                with patch.dict(sys.modules,{'tensorrt':fake_trt}),patch.object(builder,'build',build_candidate),patch.object(runtime,'validate_engine',side_effect=runtime.EngineValidationError(kind,{'maxAbsoluteError':0.5})):
                    status=builder.main(['--vkAdapter=rgb-window-v1','--onnx='+str(source),'--saveEngine='+str(target)])
                self.assertEqual(status,1); self.assertEqual(len(modes),expected_attempts)
                self.assertEqual(target.read_bytes(),b'previous')
                self.assertEqual(json.loads(Path(str(target)+'.validation-report.json').read_text())['status'],'failed')
                self.assertFalse(list(self.root.glob('*.candidate-*')))

    def test_runtime_fingerprint_changes_cache_location(self):
        opts = {'save_engine': str(self.root / 'model.engine'), 'adapter': runtime.ADAPTER}
        with patch.object(runtime, 'runtime_identity', return_value={'tensorrt': '11.3', 'gpu': 'one'}): a = builder.blacklist_path_for(opts, 'structure', 'fp16')
        with patch.object(runtime, 'runtime_identity', return_value={'tensorrt': '11.4', 'gpu': 'one'}): b = builder.blacklist_path_for(opts, 'structure', 'fp16')
        self.assertNotEqual(a, b)
    def test_reference_comparison_rejects_finite_but_wrong_pixels(self):
        source = self.root / 'model.onnx'; model(source)
        class Frame:
            format = types.SimpleNamespace(num_planes=3)
            def __getitem__(self, plane): return np.full((64, 64), 0.9, np.float32)
        class Output:
            height = width = 64
            def get_frame(self, index): return Frame()
        fake_vs = types.SimpleNamespace(RGBS=32, RGBH=16, core=MagicMock())
        class InputFrame:
            def __getitem__(self, plane): return np.full((64,64), [0.2,0.4,0.6][plane], np.float32)
        fake_vs.core.std.BlankClip.return_value.get_frame.return_value = InputFrame()
        fake_vs.core.resize.Point.side_effect = lambda clip, **kwargs: clip
        opts = {'onnx': str(source), 'adapter': runtime.ADAPTER, 'fp16': False, 'bf16': False}
        bindings = {'inputs': [{'shape': [1, 3, 64, 64], 'dtype': 'DataType.FLOAT'}], 'outputs': [{'shape': [1, 3, 64, 64], 'dtype': 'DataType.FLOAT'}]}
        with patch.dict(sys.modules, {'vapoursynth': fake_vs}), patch.object(runtime, 'engine_details', return_value=bindings), patch.object(runtime, 'raw_model', return_value=Output()):
            with self.assertRaisesRegex(runtime.EngineValidationError, 'accuracy-mismatch'): runtime.validate_engine('candidate', opts)
    def test_reference_uses_exact_engine_input_values_for_image_and_temporal_models(self):
        import onnxruntime as ort
        class Frame:
            format = types.SimpleNamespace(num_planes=3)
            def __init__(self, values): self.values = values
            def __getitem__(self, plane): return self.values[plane]
        class Clip:
            width = height = 4
            def __init__(self, values): self.values = values
            def get_frame(self, index): return Frame(self.values)
        core = types.SimpleNamespace(
            std=types.SimpleNamespace(BlankClip=lambda **kw: Clip(np.stack([np.full((4,4), c, np.float32) for c in kw['color']]))),
            resize=types.SimpleNamespace(Point=lambda clip,format: Clip(clip.values.astype(np.float16 if format==16 else np.float32))))
        fake_vs = types.SimpleNamespace(RGBS=32, RGBH=16, core=core)
        for channels in (3,15):
            with self.subTest(channels=channels):
                source = self.root / f'quantized-{channels}.onnx'
                first = helper.make_tensor_value_info('pixels',TensorProto.FLOAT,[1,channels,4,4])
                last = helper.make_tensor_value_info('output',TensorProto.FLOAT,[1,3,4,4])
                indices = onnx.numpy_helper.from_array(np.arange(channels//2-1,channels//2+2,dtype=np.int64),name='center')
                bias = onnx.numpy_helper.from_array(np.array(float(np.float16(0.2)),np.float32),name='bias')
                gain = onnx.numpy_helper.from_array(np.array(4096,np.float32),name='gain')
                graph = helper.make_graph([helper.make_node('Gather',['pixels','center'],['rgb'],axis=1),helper.make_node('Sub',['rgb','bias'],['difference']),helper.make_node('Mul',['difference','gain'],['output'])], 'rounding-sensitive', [first],[last],[indices,bias,gain])
                onnx.save(helper.make_model(graph,opset_imports=[helper.make_opsetid('',13)],ir_version=10),source)
                session = ort.InferenceSession(str(source),providers=['CPUExecutionProvider'])
                def simulated_engine(clips,*args):
                    values = np.stack([np.asarray(c.get_frame(0)[p],dtype=np.float16).astype(np.float32) for c in clips for p in range(3)])[None]
                    return Clip(session.run(None,{'pixels':values})[0][0])
                details = {'inputs':[{'shape':[1,channels,4,4],'dtype':'DataType.HALF'}],'outputs':[{'shape':[1,3,4,4],'dtype':'DataType.FLOAT'}]}
                opts={'onnx':str(source),'adapter':runtime.ADAPTER,'fp16':True,'bf16':False}
                with patch.dict(sys.modules,{'vapoursynth':fake_vs}),patch.object(runtime,'engine_details',return_value=details),patch.object(runtime,'raw_model',side_effect=simulated_engine),patch.object(runtime,'runtime_identity',return_value={}),patch.object(runtime,'digest',return_value='test'):
                    report=runtime.validate_engine(str(self.root / 'candidate.engine'),opts)
                self.assertEqual(report['validation']['accuracy']['samples'][0]['maxAbsoluteError'],0)

    def test_shape_nonfinite_and_accuracy_failures_are_distinct(self):
        for actual,expected,kind in [(np.zeros((1,3,2,2)),np.zeros((1,3,4,4)),'shape-mismatch'),(np.full((1,3,2,2),np.nan),np.zeros((1,3,2,2)),'nonfinite-output'),(np.ones((1,3,2,2)),np.zeros((1,3,2,2)),'accuracy-mismatch')]:
            with self.subTest(kind=kind),self.assertRaises(runtime.EngineValidationError) as error:
                runtime.compare_engine_output(actual,expected,[1,3,2,2],'float16','float32')
            self.assertEqual(error.exception.kind,kind)
            self.assertIn('actualOutputShape',error.exception.report)

    def test_generic_wrappers_are_not_forced_into_the_rgb_contract(self):
        fake_vs = types.SimpleNamespace(core=MagicMock())
        with patch.dict(sys.modules, {'vapoursynth': fake_vs}), patch.object(runtime, 'engine_details', return_value={'inputs': ['images', 'timestep']}), patch.object(runtime, 'runtime_identity', return_value={}), patch.object(runtime, 'digest', return_value='hash'), patch.object(runtime, 'graph_contract', side_effect=AssertionError('RGB inspection must not run')):
            result = runtime.validate_engine('rife.engine', {'adapter': None})
        self.assertEqual(result['validation']['accuracy'], 'requires-wrapper-validation')

    def test_temporal_context_repeats_boundary_frames_even_for_short_clips(self):
        class Clip:
            def __init__(self, values): self.values = values; self.num_frames = len(values)
            def __getitem__(self, item): return Clip(self.values[item] if isinstance(item, slice) else [self.values[item]])
            def __mul__(self, count): return Clip(self.values * count)
            def __add__(self, other): return Clip(self.values + other.values)
        windows = runtime.temporal_window(Clip([1, 2, 3]), 5)
        self.assertEqual([w.values[0] for w in windows], [1, 1, 1, 2, 3])
        self.assertEqual([w.values[-1] for w in windows], [1, 2, 3, 3, 3])
        short = runtime.temporal_window(Clip([1, 2]), 9)
        self.assertTrue(all(w.num_frames == 2 for w in short))
        self.assertEqual([w.values[-1] for w in short], [1, 1, 1, 1, 2, 2, 2, 2, 2])

    def engine(self, name='model_fp16.engine', profile=((64, 64), (720, 1280), (1080, 1920)), channels=3, dtype='DataType.HALF', source=None):
        """A built engine with the manifest the builder writes; profile shapes are (height, width)."""
        engine = self.root / name; engine.parent.mkdir(parents=True, exist_ok=True); engine.write_bytes(b'engine ' + name.encode())
        if profile is None: return engine
        binding = {'name': 'pixels', 'dtype': dtype, 'shape': [1, channels, -1, -1],
                   'profiles': [[[1, channels, h, w] for h, w in profile]]}
        manifest = {'schema': 1, 'bindings': {'inputs': [binding], 'outputs': [{'name': 'output', 'dtype': dtype, 'shape': [1, 3, -1, -1]}]},
                    'engineSha256': runtime.digest(engine), 'precision': 'fp16'}
        if source: manifest['sourceRelative'] = source
        Path(str(engine) + '.json').write_text(json.dumps(manifest))
        return engine

    def test_dynamic_engine_serves_every_size_in_its_profile_without_building(self):
        engine = self.engine()
        with patch.object(runtime.subprocess, 'run', side_effect=AssertionError('Scripts must never build engines')), patch.object(runtime, 'raw_model', side_effect=lambda clips, *a: clips[0]) as run:
            for width, height in ((640, 480), (1280, 720), (1920, 1080), (64, 64)):
                runtime.load_model(types.SimpleNamespace(width=width, height=height), str(engine), 2)
                self.assertEqual(run.call_args.args[1], engine)
                self.assertEqual(run.call_args.args[3]['inputs'][0]['dtype'], 'DataType.HALF')
        self.assertEqual([p.name for p in self.root.iterdir() if p.is_dir()], [], 'No per-resolution engine cache')

    def test_size_outside_the_profile_names_the_range_and_rebuild_remedy(self):
        engine = self.engine()
        with patch.object(runtime, 'raw_model', side_effect=AssertionError('Must not run')):
            with self.assertRaisesRegex(RuntimeError, r'accepts 64x64 to 1920x1080 .* sends 3840x2160.*Rebuild the engine'):
                runtime.load_model(types.SimpleNamespace(width=3840, height=2160), engine, 2)

    def test_engine_without_manifest_retries_the_other_float_format(self):
        engine = self.engine('legacy_fp16.engine', profile=None)
        class Error(Exception): pass
        calls = []
        def trt_model(clips, engine_path, num_streams):
            calls.append(clips)
            if len(calls) == 1: raise Error('trt: bits per sample mismatch')
            return 'output'
        fake = types.SimpleNamespace(Error=Error, RGBS=32, RGBH=16, core=types.SimpleNamespace(
            trt=types.SimpleNamespace(Model=trt_model), resize=types.SimpleNamespace(Point=lambda clip, format: ('cast', format))))
        clip = types.SimpleNamespace(width=1280, height=720, format=types.SimpleNamespace(bits_per_sample=16))
        with patch.dict(sys.modules, {'vapoursynth': fake}):
            self.assertEqual(runtime.load_model(clip, engine, 2), 'output')
        self.assertEqual(calls, [[clip], [('cast', 32)]])

    def test_stale_manifest_is_ignored(self):
        engine = self.engine()
        engine.write_bytes(b'replaced by hand')
        with patch.object(runtime, 'probed_model', return_value='probed') as probe, patch.object(runtime, 'raw_model', side_effect=AssertionError('Stale manifest')):
            self.assertEqual(runtime.load_model(types.SimpleNamespace(width=8000, height=8000), engine, 2), 'probed')
        probe.assert_called_once()

    def test_missing_engine_or_onnx_path_asks_for_a_build(self):
        source = self.root / 'model.onnx'; model(source)
        for target in (source, self.root / 'missing_fp16.engine'):
            with self.subTest(target=target.name), self.assertRaisesRegex(RuntimeError, 'Build the model'):
                runtime.load_model(types.SimpleNamespace(width=64, height=64), target, 2)

    def test_spatial_multiple_pads_inside_the_profile_and_crops_the_output(self):
        package = self.root / 'packages' / 'cat-1-abc'; package.mkdir(parents=True)
        source = package / 'cat-1.onnx'; model(source)
        Path(str(source) + '.contract.json').write_text(json.dumps({'spatialMultiple': 2, 'scale': 2}))
        engine = self.engine('packages/cat-1-abc/cat-1_fp16.engine', source='cat-1.onnx')
        Clip = types.SimpleNamespace
        fake = types.SimpleNamespace(core=types.SimpleNamespace(std=types.SimpleNamespace(
            AddBorders=lambda c, right, bottom: Clip(width=c.width + right, height=c.height + bottom),
            CropRel=lambda c, right, bottom: Clip(width=c.width - right, height=c.height - bottom))))
        def run(clips, engine_path, streams, details):
            self.assertEqual((clips[0].width, clips[0].height), (722, 480))
            return Clip(width=clips[0].width * 2, height=clips[0].height * 2)
        with patch.dict(sys.modules, {'vapoursynth': fake}), patch.object(runtime, 'raw_model', side_effect=run):
            output = runtime.load_model(Clip(width=721, height=480), engine, 2)
        self.assertEqual((output.width, output.height), (1442, 960))

    def test_temporal_window_follows_the_engine_channel_count(self):
        engine = self.engine('vsr_fp16.engine', channels=15)
        centre = types.SimpleNamespace(width=640, height=480)
        with patch.object(runtime, 'temporal_window', return_value=[centre] * 5) as window, patch.object(runtime, 'raw_model', side_effect=lambda clips, *a: clips):
            self.assertEqual(len(runtime.load_model([centre] * 3, engine, 2)), 5)
        window.assert_called_once_with(centre, 5)

    def test_rgb_builds_take_the_engine_build_lock(self):
        from contextlib import contextmanager
        source = self.root / 'model.onnx'; model(source)
        target = self.root / 'model_fp16.engine'
        held = []
        @contextmanager
        def lock(engine):
            held.append(str(engine)); yield
        def fake_build(opts): Path(opts['save_engine']).write_bytes(b'checked engine'); return 0
        args = ['--vkAdapter=rgb-window-v1', '--onnx=' + str(source), '--saveEngine=' + str(target),
                '--minShapes=pixels:1x3x64x64', '--optShapes=pixels:1x3x720x1280', '--maxShapes=pixels:1x3x1080x1920', '--fp16']
        with patch.dict(sys.modules, {'tensorrt': types.SimpleNamespace()}), patch.object(runtime, 'engine_build_lock', lock), patch.object(builder, 'build', fake_build), patch.object(runtime, 'validate_engine', return_value={'schema': 1, 'validation': {}}):
            self.assertEqual(builder.main(args), 0)
        self.assertEqual(held, [str(target)])

    def test_saved_engine_is_only_published_after_validation(self):
        source = self.root / 'model.onnx'; model(source)
        target = self.root / 'model.engine'
        def fake_build(opts): Path(opts['save_engine']).write_bytes(b'checked engine'); return 0
        with patch.dict(sys.modules, {'tensorrt': types.SimpleNamespace()}), patch.object(builder, 'build', fake_build), patch.object(runtime, 'validate_engine', return_value={'schema': 1, 'validation': {'execution': ['passed']}}):
            self.assertEqual(builder.main(['--vkAdapter=rgb-window-v1','--onnx=' + str(source), '--saveEngine=' + str(target)]), 0)
        self.assertEqual(target.read_bytes(), b'checked engine')
        self.assertEqual(json.loads(Path(str(target) + '.json').read_text())['schema'], 1)
    def test_cuda_identity_uses_visible_zero_without_a_current_context(self):
        previous = runtime._IDENTITY
        try:
            for mask in ('0', '1', 'GPU-selected-uuid', 'MIG-selected-uuid'):
                runtime._IDENTITY = None
                driver = MagicMock()
                driver.cuInit.return_value = 0
                driver.cuCtxGetDevice.side_effect = AssertionError('A context must not be required')
                def device(pointer, ordinal):
                    self.assertEqual(ordinal, 0); pointer._obj.value = 0; return 0
                def uuid(pointer, selected):
                    for i in range(16): pointer._obj[i] = i
                    return 0
                def version(pointer): pointer._obj.value = 13000; return 0
                driver.cuDeviceGet.side_effect = device
                driver.cuDeviceGetUuid.side_effect = uuid
                driver.cuDriverGetVersion.side_effect = version
                vs = types.SimpleNamespace(core=types.SimpleNamespace(trt=types.SimpleNamespace(Version=lambda: {})))
                with patch.dict('os.environ', {'CUDA_VISIBLE_DEVICES': mask}), patch.dict(sys.modules, {'tensorrt': types.SimpleNamespace(__version__='test'), 'vapoursynth': vs}), patch.object(runtime.ctypes, 'CDLL', return_value=driver):
                    result = runtime.runtime_identity()
                self.assertEqual(result['gpu'], bytes(range(16)).hex())
                driver.cuCtxGetDevice.assert_not_called()
        finally: runtime._IDENTITY = previous

    def test_generic_builder_does_not_run_rgb_validation_or_require_app_gpu_identity(self):
        source = self.root / 'wrapper.onnx'; model(source)
        target = self.root / 'wrapper.engine'
        def build(opts):
            Path(opts['save_engine']).write_bytes(b'wrapper engine')
            opts['_pending_blacklist'] = (str(self.root / 'wrapper-blacklist.txt'), b'learned node')
            return 0
        with patch.dict(sys.modules, {'tensorrt': types.SimpleNamespace()}), patch.object(builder, 'build', build), patch.object(runtime, 'validate_engine', side_effect=AssertionError('Generic wrapper must stay outside RGB validation')), patch.object(runtime, 'runtime_identity', side_effect=AssertionError('Generic wrapper must not require app GPU identity')):
            self.assertEqual(builder.main(['--onnx=' + str(source), '--saveEngine=' + str(target)]), 0)
            self.assertEqual(builder.blacklist_path_for({'save_engine':str(target)}, 'graph', 'fp16').name, 'graph_fp16.txt')
        self.assertEqual(target.read_bytes(), b'wrapper engine')
        self.assertEqual((self.root / 'wrapper-blacklist.txt').read_bytes(), b'learned node')
        self.assertFalse(Path(str(target) + '.json').exists())

    def test_cpu_reference_timeout_and_input_budget_fail_explicitly(self):
        data = np.zeros((1, 3, 4, 4), np.float32)
        with patch.object(runtime.subprocess, 'run', side_effect=runtime.subprocess.TimeoutExpired('reference', runtime.REFERENCE_TIMEOUT)) as run:
            with self.assertRaises(runtime.EngineValidationError) as failure:
                runtime.reference_output(self.root / 'model.onnx', 'input', 'output', data)
            self.assertEqual(failure.exception.kind, 'reference-timeout')
            self.assertEqual(run.call_args.kwargs['timeout'], runtime.REFERENCE_TIMEOUT)
        with patch.object(runtime, 'REFERENCE_INPUT_BUDGET', 1), patch.object(runtime.subprocess, 'run') as run:
            with self.assertRaises(runtime.EngineValidationError) as failure:
                runtime.reference_output(self.root / 'model.onnx', 'input', 'output', data)
            self.assertEqual(failure.exception.kind, 'reference-budget')
            run.assert_not_called()

    def test_missing_cpu_reference_is_not_silently_accepted_as_accuracy_verified(self):
        def unavailable(args, **kwargs):
            kwargs['stderr'].write(b"No module named 'onnxruntime'")
            return types.SimpleNamespace(returncode=1)
        with patch.object(runtime.subprocess, 'run', side_effect=unavailable):
            with self.assertRaises(runtime.EngineValidationError) as failure:
                runtime.reference_output(self.root / 'model.onnx', 'input', 'output', np.zeros((1,3,4,4),np.float32))
            self.assertEqual(failure.exception.kind, 'reference-failed')
            self.assertIn('onnxruntime', failure.exception.report['details'])


if __name__ == '__main__': unittest.main()
