"""CPU-only numerical checks for the optional native backend's ONNX adapter."""
import importlib.util
import hashlib
from pathlib import Path
import tempfile
import unittest
import numpy as np
import onnx
from onnx import helper, TensorProto
import onnxruntime as ort

spec = importlib.util.spec_from_file_location('prepare_nvencc_model', Path(__file__).resolve().parents[2] / 'include' / 'prepare_nvencc_model.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class NativeModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()

    def model(self, dtype=TensorProto.FLOAT16, channels=3, external=False):
        file = self.root / 'source.onnx'
        tensor = helper.make_tensor_value_info('pixels', dtype, [1, channels, 8, 8])
        output = helper.make_tensor_value_info('result', dtype, [1, channels, 8, 8])
        weight = onnx.numpy_helper.from_array(np.ones((1, channels, 8, 8), np.float16 if dtype == TensorProto.FLOAT16 else np.float32) / 8, name='weight')
        model = helper.make_model(helper.make_graph([helper.make_node('Add', ['pixels', 'weight'], ['result'])], 'test', [tensor], [output], [weight]), opset_imports=[helper.make_opsetid('', 17)], ir_version=10)
        onnx.save_model(model, file, save_as_external_data=external, all_tensors_to_one_file=True, location='source.weights', size_threshold=0)
        return file

    def test_fp16_and_fp32_internals_match_original_after_the_existing_input_clamp(self):
        for dtype in (TensorProto.FLOAT16, TensorProto.FLOAT):
            source = self.model(dtype)
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            prepared = adapter.prepare(source, self.root / 'cache')
            data = np.linspace(-.1, 1.1, 192, dtype=np.float32).reshape(1, 3, 8, 8)
            original = ort.InferenceSession(str(source), providers=['CPUExecutionProvider'])
            expected = original.run(None, {'pixels': data.clip(0, 1).astype(np.float16 if dtype == TensorProto.FLOAT16 else np.float32)})[0].astype(np.float32)
            session = ort.InferenceSession(prepared['model'], providers=['CPUExecutionProvider'])
            actual = session.run(None, {session.get_inputs()[0].name: data})[0]
            if dtype == TensorProto.FLOAT16:
                # ORT's CPU fallback promotes half operations and removes redundant
                # casts around them. Allow one half-precision ULP near unit RGB.
                np.testing.assert_allclose(actual, expected, atol=2 ** -10, rtol=0)
            else:
                np.testing.assert_array_equal(actual, expected)
            self.assertEqual(before, hashlib.sha256(source.read_bytes()).hexdigest())
            internal = onnx.load_model(prepared['model'])
            self.assertEqual(next(t for t in internal.graph.initializer if t.name == 'weight').data_type, dtype)

    def test_external_package_is_self_contained_and_original_files_are_unchanged(self):
        source = self.model(external=True)
        original = {p.name: p.read_bytes() for p in self.root.iterdir()}
        prepared = adapter.prepare(source, self.root / 'cache')
        for name, data in original.items(): self.assertEqual((self.root / name).read_bytes(), data)
        # Remove the original package to prove the derived package owns its weights.
        for name in original: (self.root / name).unlink()
        session = ort.InferenceSession(prepared['model'], providers=['CPUExecutionProvider'])
        self.assertEqual(session.run(None, {session.get_inputs()[0].name: np.zeros((1, 3, 8, 8), np.float32)})[0].shape, (1, 3, 8, 8))

    def test_cached_adapter_is_reused_and_a_damaged_cache_is_repaired(self):
        source = self.model()
        first = adapter.prepare(source, self.root / 'cache')
        file = Path(first['model']); modified = file.stat().st_mtime_ns
        self.assertEqual(adapter.prepare(source, self.root / 'cache')['model'], str(file))
        self.assertEqual(file.stat().st_mtime_ns, modified)
        file.write_bytes(b'broken')
        repaired = adapter.prepare(source, self.root / 'cache')
        onnx.checker.check_model(repaired['model'])

    def test_source_changes_get_a_new_cache_identity(self):
        source = self.model()
        first = adapter.prepare(source, self.root / 'cache')
        self.model(TensorProto.FLOAT)
        self.assertNotEqual(first['model'], adapter.prepare(source, self.root / 'cache')['model'])

    def test_non_rgb_layout_is_rejected_before_publication(self):
        source = self.model(channels=6)
        with self.assertRaisesRegex(ValueError, 'three input/output channels'):
            adapter.prepare(source, self.root / 'cache')


if __name__ == '__main__': unittest.main()
