import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('vk_hdr_runtime', Path(__file__).resolve().parents[2] / 'include/vk_hdr_runtime.py')
hdr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hdr)
SETTINGS = dict(peakNits=1000, referenceWhite=203, strength=0.35)


class CurveTests(unittest.TestCase):
    def test_black_neutral_and_bounded_monotone_expansion(self):
        values = [hdr.mapped_luminance(i / 10000, SETTINGS) for i in range(10001)]
        self.assertEqual(values[0], 0)
        self.assertLessEqual(max(values), SETTINGS['peakNits'])
        self.assertTrue(all(a <= b for a, b in zip(values, values[1:])))
        self.assertAlmostEqual(hdr.mapped_luminance(.18, SETTINGS), 36.593, delta=.01)

    def test_strength_zero_preserves_reference_luminance(self):
        settings = dict(SETTINGS, strength=0)
        self.assertEqual(hdr.mapped_luminance(1, settings), 203)
        self.assertEqual(hdr.mapped_luminance(-1, settings), 0)

    def test_full_strength_reaches_peak_without_overshooting(self):
        self.assertEqual(hdr.mapped_luminance(1, dict(SETTINGS, strength=1)), 1000)
        self.assertEqual(hdr.mapped_luminance(2, dict(SETTINGS, strength=1)), 1000)

    def test_ai_grade_is_monotone_bounded_and_maps_reference_white(self):
        for white in (80, 144, 203, 300):
            for shoulder in (.4, .75, .95):
                settings = dict(SETTINGS, referenceWhite=white, aiShoulder=shoulder)
                values = [hdr.ai_mapped_luminance(i, settings) for i in range(10001)]
                self.assertEqual(values[0], 0)
                self.assertTrue(all(a <= b for a, b in zip(values, values[1:])))
                self.assertLessEqual(max(values), 1000)
                self.assertAlmostEqual(hdr.ai_mapped_luminance(203, settings), white)
        self.assertAlmostEqual(hdr.ai_mapped_luminance(200, dict(SETTINGS, aiExposure=-1)), 100)
        with self.assertRaises(ValueError): hdr.ai_grade_parameters(dict(SETTINGS, aiShoulder=float('nan')))
        with self.assertRaises(ValueError): hdr.ai_grade_parameters(dict(SETTINGS, aiExposure=3))

    def test_rejects_nonfinite_and_out_of_range_values(self):
        for key, value in [('peakNits', float('nan')), ('referenceWhite', float('inf')), ('strength', 2)]:
            with self.assertRaises(ValueError): hdr.validate(dict(SETTINGS, **{key: value}))


if __name__ == '__main__': unittest.main()
