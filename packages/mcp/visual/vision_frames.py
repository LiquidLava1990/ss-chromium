"""Ask CrawlRX's container vision service about ordered SS screenshots."""
import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
from io import BytesIO

import httpx


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('prompt')
    parser.add_argument('screenshots', nargs='+', type=Path)
    parser.add_argument('--per-frame', action='store_true',
                        help='Analyze frames separately; results do not establish motion on their own')
    parser.add_argument('--max-image-dimension', type=int, default=0,
                        help='Downscale images to this maximum dimension (0 preserves originals)')
    args = parser.parse_args()
    if args.max_image_dimension < 0:
        parser.error('--max-image-dimension must be nonnegative')
    if not args.per_frame and len(args.screenshots) > 8:
        parser.error('A joint analysis supports at most eight frames')
    images = []
    for path in args.screenshots:
        data = path.read_bytes()
        if args.max_image_dimension:
            from PIL import Image
            image = Image.open(BytesIO(data)).convert('RGB')
            image.thumbnail((args.max_image_dimension, args.max_image_dimension))
            output = BytesIO()
            image.save(output, format='PNG')
            data = output.getvalue()
        encoded = base64.b64encode(data).decode('ascii')
        images.append(encoded)
    url = 'http://127.0.0.1:7338'
    if os.environ.get('SS_CHROMIUM_TESTING') == '1':
        url = os.environ.get('SS_CRAWLRX_TEST_VISION_BASE', url)
        from urllib.parse import urlsplit
        if urlsplit(url).hostname != '127.0.0.1' or urlsplit(url).scheme != 'http':
            raise ValueError('Test vision base must be HTTP loopback')
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            answers = []
            for group in ([[image] for image in images] if args.per_frame else [images]):
                payload = {'prompt': args.prompt}
                if len(group) == 1:
                    payload['image'] = group[0]
                    endpoint = '/analyze'
                else:
                    payload['frames'] = group
                    endpoint = '/analyze-frames'
                response = await client.post(url + endpoint, json=payload)
                response.raise_for_status()
                result = response.json()
                if result.get('ok') is not True:
                    raise ValueError('CrawlRX did not complete vision analysis')
                answer = result.get('analysis')
                if not isinstance(answer, str) or not answer.strip():
                    raise ValueError('No answer from vision model')
                answers.append(answer.strip())
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
        error = {'ok': False, 'error': type(exc).__name__}
        if isinstance(exc, httpx.HTTPStatusError):
            error['status'] = exc.response.status_code
        print(json.dumps(error))
        return 1
    result = {'ok': True, 'frames': answers} if args.per_frame else {'ok': True, 'analysis': answers[0]}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
