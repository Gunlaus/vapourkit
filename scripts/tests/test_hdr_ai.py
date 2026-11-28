import sys
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'include'))
import vk_hdr_ai as ai
import vk_model_runtime as common


class HdrAiTests(unittest.TestCase):
    def test_fp32_profile_has_a_bounded_reference_and_no_reduced_precision_flag(self):
        args = ai.engine_arguments('model.onnx', 'cache.engine', [1, 3, 1080, 1920], 'tensorrt')
        self.assertIn('--noTF32', args)
        self.assertIn('--minShapes=input:1x3x128x128', args)
        self.assertNotIn('--fp16', args)

    def test_build_is_validated_cached_and_output_is_marked_as_pq(self):
        with tempfile.TemporaryDirectory() as folder:
            clip = types.SimpleNamespace(width=160, height=128)
            result = object()
            identity = {'version': 'fixture', 'gpu': 'fixture'}
            metadata = {'runtime': identity, 'bindings': {}}
            tagged = Mock(return_value=result)
            vs = types.SimpleNamespace(RGBS=1, core=types.SimpleNamespace(
                resize=types.SimpleNamespace(Point=lambda c, **kw: c),
                std=types.SimpleNamespace(SetFrameProps=tagged)))
            def build(args, **kwargs):
                target = next(a.split('=', 1)[1] for a in args if a.startswith('--saveEngine='))
                Path(target).write_bytes(b'validated engine')
                self.assertIs(kwargs['stdout'], sys.stderr)
            with patch.dict(sys.modules, {'vapoursynth': vs}), \
                 patch.object(common, 'runtime_identity', return_value=identity), \
                 patch.object(common, 'graph_contract', return_value={'weights': 'immutable'}), \
                 patch.object(common, 'engine_metadata', side_effect=lambda p: metadata if Path(p).exists() else None), \
                 patch.object(common, 'raw_model', return_value=clip), \
                 patch.object(ai.subprocess, 'run', side_effect=build) as run:
                for _ in range(2):
                    self.assertIs(ai.load_model(clip, 'source.onnx', folder, 'tensorrt', 'builder.py'), result)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(tagged.call_args.kwargs, dict(_Matrix=0, _Primaries=9, _Transfer=16, _Range=1))


if __name__ == '__main__': unittest.main()
