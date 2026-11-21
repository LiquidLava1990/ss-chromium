"""Send the current SS screenshot to the vision adapter in CrawlRX."""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('screenshot', type=Path)
    parser.add_argument('prompt')
    args = parser.parse_args()
    try:
        payload = json.dumps({'image': base64.b64encode(args.screenshot.read_bytes()).decode('ascii'),
                              'prompt': args.prompt}).encode('utf-8')
        endpoint = 'http://127.0.0.1:7338/analyze'
        if os.environ.get('SS_CHROMIUM_TESTING') == '1':
            candidate = os.environ.get('SS_CRAWLRX_TEST_VISION_URL', endpoint)
            if not candidate.startswith('http://127.0.0.1:'):
                raise ValueError('Test vision URL must be loopback')
            endpoint = candidate
        request = urllib.request.Request(endpoint, data=payload,
                                         headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(request, timeout=65) as response:
            result = json.load(response)
        if result.get('ok') is not True or not isinstance(result.get('analysis'), str):
            raise ValueError('Invalid vision response')
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, urllib.error.URLError):
        print(json.dumps({'ok': False, 'error': 'CrawlRX vision service unavailable'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
