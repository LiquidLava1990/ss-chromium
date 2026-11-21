import unittest

import cv2
import numpy as np

from shape_match import locate


class ShapeMatchTest(unittest.TestCase):
    def test_matching_shape_in_larger_image(self):
        template = np.full((50, 50, 3), 255, dtype=np.uint8)
        cv2.circle(template, (25, 25), 14, (0, 0, 0), 3)
        cv2.line(template, (10, 10), (20, 20), (0, 0, 0), 3)
        image = np.full((150, 200, 3), 255, dtype=np.uint8)
        image[65:115, 120:170] = template
        result = locate(template, image)
        self.assertAlmostEqual(result['x'], 145, delta=1)
        self.assertAlmostEqual(result['y'], 90, delta=1)
        self.assertGreater(result['score'], 0.95)

    def test_blank_template_is_rejected(self):
        image = np.full((20, 20, 3), 255, dtype=np.uint8)
        with self.assertRaisesRegex(ValueError, 'no detectable edges'):
            locate(image, image)


if __name__ == '__main__':
    unittest.main()
