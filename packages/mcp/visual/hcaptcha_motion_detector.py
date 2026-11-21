"""Recognize a narrow four-island animation from sequential frame screenshots."""
import math
import cv2
import numpy as np


def scene_changed(images: list[bytes], current: bytes) -> bool:
    raw = [cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_COLOR) for image in images]
    fresh = cv2.imdecode(np.frombuffer(current, np.uint8), cv2.IMREAD_COLOR)
    if not raw or fresh is None or any(im is None or im.shape[:2] != raw[0].shape[:2] for im in raw):
        raise ValueError('Invalid frames for next-round comparison')
    if fresh.shape[:2] != raw[0].shape[:2]:
        raise ValueError('Next-round frame dimensions changed')
    frames = np.array([cv2.resize(im, (520, 570), interpolation=cv2.INTER_AREA) for im in raw])
    median = np.median(frames, axis=0).astype('uint8')
    fresh = cv2.resize(fresh, (520, 570), interpolation=cv2.INTER_AREA)
    difference = np.max(np.abs(fresh.astype('int16')-median.astype('int16')), axis=2)
    return bool(np.mean(difference[140:472, 20:500] > 35) > .08)


def _find_islands(median):
    hsv = cv2.cvtColor(median, cv2.COLOR_BGR2HSV)
    sets = []
    ranges = (((30, 75, 80), (85, 255, 255)),
              ((15, 75, 80), (32, 255, 255)),
              ((0, 0, 235), (179, 90, 255)))
    for low, high in ranges:
        mask = cv2.inRange(hsv, low, high)
        mask[:140] = 0
        mask[472:] = 0
        n, _, stats, centers = cv2.connectedComponentsWithStats(mask)
        islands = []
        for i in range(1, n):
            x, y, w, h, area = (int(a) for a in stats[i])
            if 2500 <= area <= 9000 and 65 <= w <= 125 and 50 <= h <= 100:
                islands.append((x, y, w, h, tuple(float(v) for v in centers[i])))
        if len(islands) == 4:
            sets.append(sorted(islands, key=lambda b: (b[1], b[0])))
    if not sets:
        raise ValueError('Expected four clear islands in a supported color')
    if any(np.linalg.norm(np.array(a[4])-np.array(b[4])) > 8
           for other in sets[1:] for a, b in zip(sets[0], other)):
        raise ValueError('Island color detection is ambiguous')
    return sets[0]


def _unvisited_from_observations(observations):
    """Require two stable cycles and reject ambiguous apparent visits."""
    runs = []
    start = 0
    while start < len(observations):
        end = start + 1
        while end < len(observations) and observations[end] == observations[start]:
            end += 1
        candidate = observations[start]
        if candidate is not None and end-start >= 2 and (not runs or runs[-1] != candidate):
            runs.append(candidate)
        start = end
    cycle = next((runs[i:i+6] for i in range(len(runs)-5)
                  if len(set(runs[i:i+3])) == 3 and runs[i:i+3] == runs[i+3:i+6]), None)
    if cycle is None:
        raise ValueError('Two complete stable animation cycles were not observed')
    missing = set(range(4))-set(cycle)
    if len(missing) != 1:
        raise ValueError('The unvisited island is ambiguous')
    index = missing.pop()
    # A moving animal may briefly pass over an unvisited island between two
    # stable stops. Only discount isolated samples bracketed by distinct stops.
    transits = [i for i, observed in enumerate(observations) if observed == index]
    if (any(run not in cycle for run in runs) or any(
            i == 0 or i == len(observations)-1
            or observations[i-1] not in cycle or observations[i+1] not in cycle
            or observations[i-1] == observations[i+1] for i in transits)):
        raise ValueError('An apparent visit to the remaining island was observed')
    return index, runs


def detect(images: list[bytes], timestamps: list[float], verification_image: bytes | None = None) -> dict[str, list[float] | list[int] | int]:
    if len(images) < 20 or len(images) != len(timestamps):
        raise ValueError('Need at least 20 timed frames')
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in timestamps):
        raise ValueError('Animation timestamps must be finite numbers')
    if timestamps[-1] - timestamps[0] < 6000 or any(
            b <= a or b-a > 1000 for a, b in zip(timestamps, timestamps[1:])):
        raise ValueError('Animation sampling is too short or has a large gap')
    raw = [cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_COLOR) for image in images]
    if any(im is None or im.shape[:2] != raw[0].shape[:2] for im in raw):
        raise ValueError('Frame screenshots have inconsistent dimensions')
    if abs(raw[0].shape[1] / raw[0].shape[0] - 520/570) > .02:
        raise ValueError('Unsupported challenge frame dimensions')
    frames = np.array([cv2.resize(im, (520, 570), interpolation=cv2.INTER_AREA) for im in raw])
    median = np.median(frames, axis=0).astype('uint8')
    if verification_image is not None:
        current = cv2.imdecode(np.frombuffer(verification_image, np.uint8), cv2.IMREAD_COLOR)
        if current is None or current.shape[:2] != raw[0].shape[:2]:
            raise ValueError('Verification frame dimensions changed')
        current = cv2.resize(current, (520, 570), interpolation=cv2.INTER_AREA)
        difference = np.max(np.abs(current.astype('int16')-median.astype('int16')), axis=2)
        if np.mean(difference[140:472, 20:500] > 35) > .08:
            raise ValueError('Challenge background changed after sampling')
    islands = _find_islands(median)
    observations = []
    for frame in frames:
        diff = np.max(np.abs(frame.astype('int16')-median.astype('int16')), axis=2) > 30
        scores = [int(diff[max(140,y-60):y+int(h*.5), max(0,x-6):x+w+6].sum())
                  for x,y,w,h,_ in islands]
        order = sorted(range(4), key=lambda i: scores[i], reverse=True)
        candidate = order[0] if scores[order[0]] >= 700 and scores[order[1]] <= scores[order[0]]*.25 else None
        observations.append(candidate)
    index, runs = _unvisited_from_observations(observations)
    x, y = islands[index][4]
    return {'point': [x/520, y/570], 'runs': runs, 'missing': index}


