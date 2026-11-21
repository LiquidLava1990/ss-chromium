# Visual analysis helpers

These optional Python utilities restore the private build's image-shape matching and ordered-frame vision tools. Install `opencv-python` for `shape_match.py` and `httpx` (plus `Pillow` when using resizing) for `vision_frames.py`. The matcher is adapted from PuzzleCaptchaSolver; its MIT license is in `PUZZLE_CAPTCHA_LICENSE.txt`.

`python shape_match.py template.png screenshot.png` reports the best matching center and score. `python vision_frames.py "Describe the changes" frame1.png frame2.png` sends ordered images to the CrawlRX vision adapter on loopback port 7338. The adapter and a configured vision model must be running separately. `ss_frame_capture.cjs` supplies a frame-cropping helper for code that already has an SS browser tool connection. `hcaptcha_motion_detector.py` contains the private build's narrow motion detector; it is not a general-purpose classifier.

Results are suggestions and should be checked against the current page. Frame analysis alone does not establish that a challenge was accepted. These helpers are not built into the Chrome Web Store extension.
