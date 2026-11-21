"""Match an image template to a larger image using edge correlation.

Adapted from PuzzleCaptchaSolver by Vasyl Smutok, MIT license. See
https://github.com/vsmutok/PuzzleCaptchaSolver and PUZZLE_CAPTCHA_LICENSE.txt.
This handles matching edges; it does not decide semantic similarity.
"""

import argparse
import json

import cv2


def locate(template, image):
    """Return the best template center and score in image pixel coordinates."""
    if template is None or image is None:
        raise ValueError("Could not read one or both images")
    if template.shape[0] > image.shape[0] or template.shape[1] > image.shape[1]:
        raise ValueError("Template must fit within the image")
    template_edges = cv2.Canny(cv2.cvtColor(template, cv2.COLOR_BGR2GRAY), 100, 200)
    image_edges = cv2.Canny(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), 100, 200)
    if cv2.countNonZero(template_edges) == 0:
        raise ValueError("Template contains no detectable edges")
    scores = cv2.matchTemplate(image_edges, template_edges, cv2.TM_CCOEFF_NORMED)
    _, score, _, (x, y) = cv2.minMaxLoc(scores)
    return {"x": x + template.shape[1] / 2, "y": y + template.shape[0] / 2, "score": score, "width": image.shape[1], "height": image.shape[0]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", help="Path to the cropped target template")
    parser.add_argument("image", help="Path to the uncropped search image")
    args = parser.parse_args()
    result = locate(cv2.imread(args.template), cv2.imread(args.image))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
