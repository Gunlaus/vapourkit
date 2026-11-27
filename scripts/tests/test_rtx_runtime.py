"""RTX cache and subprocess boundaries; no GPU or RTX SDK needed."""
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch, MagicMock
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'include'))
import vk_model_runtime as common
import vk_rtx_runtime as rtx
import build_trt_engine as builder


class RtxRuntimeTests(unittest.TestCase):
    def contract(self):
        return {'inputs': [{'name': 'pixels', 'shape': [1, 3, 'h', 'w']}],
                'files': [{'path': 'model.onnx', 'sha256': 'source'}, {'path': 'weights.bin', 'sha256': 'weights'}]}

    def test_cache_separates_runtime_shape_precision_and_external_weights(self):
        c = self.contract()
        key = rtx.cache_key(c, [1,3,720,1280], 'fp16', {'sdk':'1','gpu':'a'})
        for shape, precision, identity in [([1,3,1080,1920], 'fp16', {'sdk':'1','gpu':'a'}),
                                           ([1,3,720,1280], 'fp32', {'sdk':'1','gpu':'a'}),
                                           ([1,3,720,1280], 'fp16', {'sdk':'2','gpu':'a'}),
                                           ([1,3,720,1280], 'fp16', {'sdk':'1','gpu':'b'})]:
            self.assertNotEqual(key, rtx.cache_key(c, shape, precision, identity))
        c['files'][1]['sha256'] = 'replaced weights'
        self.assertNotEqual(key, rtx.cache_key(c, [1,3,720,1280], 'fp16', {'sdk':'1','gpu':'a'}))

    def test_profiles_keep_actual_shape_and_bounded_reference_shape(self):
        args = rtx.build_arguments('m.onnx', 'e.engine', self.contract(), [1,3,1080,1920], 'fp16')
        opts = builder.parse_args(args)
        self.assertEqual(opts['runtime'], 'tensorrt-rtx')
        self.assertEqual(opts['min_shapes']['pixels'], [1,3,240,240])
        self.assertEqual(opts['opt_shapes']['pixels'], [1,3,1080,1920])
        self.assertEqual(opts['max_shapes'], opts['opt_shapes'])
        self.assertTrue(opts['fp16'])
        self.assertEqual(opts['adapter'], common.ADAPTER)
        c = self.contract(); c['inputs'][0]['shape'] = [1,3,320,480]
        opts = builder.parse_args(rtx.build_arguments('m','e',c,[1,3,320,480],'fp32'))
        self.assertEqual(opts['min_shapes'], opts['max_shapes'])
        self.assertFalse(opts['fp16'])

    def test_build_logs_never_enter_vspipe_stdout_and_warm_cache_skips_build(self):
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / 'builder.py'; script.write_text('# test')
            clip = types.SimpleNamespace(width=1280, height=720)
            metadata = {'runtime': {'sdk':'1'}, 'bindings': {'inputs': []}}
            with patch.object(rtx, 'ensure_plugin'), patch.object(common, 'graph_contract', return_value=self.contract()), \
                 patch.object(common, 'runtime_identity', return_value={'sdk':'1'}), \
                 patch.object(common, 'engine_metadata', side_effect=[None, metadata, metadata]), \
                 patch.object(rtx.subprocess, 'run') as run, patch.object(common, 'raw_model', return_value='output') as infer:
                for _ in range(2):
                    self.assertEqual(rtx.load_model(clip, 'm.onnx', 2, 'fp16', script, 'python', d), 'output')
                self.assertEqual(run.call_count, 1)
                kwargs = run.call_args.kwargs
                self.assertIs(kwargs['stdout'], sys.stderr)
                self.assertIs(kwargs['stderr'], sys.stderr)
                self.assertEqual(kwargs['stdin'], rtx.subprocess.DEVNULL)
                self.assertTrue(kwargs['check'])
                self.assertEqual(infer.call_args.kwargs['backend'], 'tensorrt-rtx')

    def test_failed_build_does_not_run_an_engine(self):
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / 'builder.py'; script.touch()
            clip = types.SimpleNamespace(width=1280, height=720)
            with patch.object(rtx, 'ensure_plugin'), patch.object(common, 'graph_contract', return_value=self.contract()), \
                 patch.object(common, 'runtime_identity', return_value={}), patch.object(common, 'engine_metadata', return_value=None), \
                 patch.object(rtx.subprocess, 'run', side_effect=RuntimeError('rejected')), patch.object(common, 'raw_model') as infer:
                with self.assertRaisesRegex(RuntimeError, 'rejected'):
                    rtx.load_model(clip, 'm.onnx', 1, 'fp16', script, 'python', d)
                infer.assert_not_called()

    def test_correct_plugin_and_actual_io_type_are_used(self):
        fake = types.SimpleNamespace(RGBS=32, RGBH=16, core=MagicMock())
        fake.core.resize.Point.side_effect = lambda clip, format: format
        with patch.dict(sys.modules, {'vapoursynth':fake}):
            common.raw_model(['clip'], 'rtx.engine', 2, {'inputs':[{'dtype':'DataType.FLOAT'}]}, backend='tensorrt-rtx')
        fake.core.trt_rtx.Model.assert_called_once_with([32], engine_path='rtx.engine', num_streams=2)
        fake.core.trt.Model.assert_not_called()

    def test_runtime_selector_is_explicit_and_default_stays_classic(self):
        self.assertEqual(builder.parse_args([])['runtime'], 'tensorrt')
        with self.assertRaisesRegex(ValueError, 'Unknown TensorRT runtime'):
            builder.parse_args(['--vkRuntime=arbitrary'])
        classic, modern = object(), object()
        with patch.dict(sys.modules, {'tensorrt':classic, 'tensorrt_rtx':modern}):
            self.assertIs(common.tensor_module(), classic)
            self.assertIs(common.tensor_module('tensorrt-rtx'), modern)

if __name__ == '__main__': unittest.main()
