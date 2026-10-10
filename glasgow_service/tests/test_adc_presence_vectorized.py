"""The vectorised _AdcPresenceMonitor must match the original per-sample loop.

The reference below is the pre-vectorisation implementation, verbatim, kept
only as a test oracle.
"""
import array
import random

import numpy as np
import pytest

from glasgow_service.service import (
    _ADC_DIAGNOSTIC_UNIQUE_LIMIT,
    _ADC_FULL_SCALE_VALUES,
    _AdcPresenceMonitor,
)


class _ReferenceMonitor:
    def __init__(self, *, enabled, minimum_samples=256):
        self.enabled = enabled
        self.minimum_samples = minimum_samples
        self.full_scale_samples = 0
        self.conclusive = False
        self.sample_count = 0
        self.minimum = None
        self.maximum = None
        self.first_samples = []
        self.unique_values = set()

    def observe(self, chunk):
        if not self.enabled:
            return None
        for sample in chunk:
            value = int(sample)
            self.sample_count += 1
            self.minimum = value if self.minimum is None else min(self.minimum, value)
            self.maximum = value if self.maximum is None else max(self.maximum, value)
            if len(self.first_samples) < 8:
                self.first_samples.append(value)
            if len(self.unique_values) < _ADC_DIAGNOSTIC_UNIQUE_LIMIT:
                self.unique_values.add(value)
            if self.conclusive:
                continue
            if value not in _ADC_FULL_SCALE_VALUES:
                self.conclusive = True
            else:
                self.full_scale_samples += 1
                if self.full_scale_samples >= self.minimum_samples:
                    self.conclusive = True
                    return "fault"
        return None


def _state(m):
    return (m.full_scale_samples, m.conclusive, m.sample_count, m.minimum, m.maximum,
            list(m.first_samples), set(m.unique_values))


def _chunks(rng, kind):
    full = [0xFFFC, 0x3FFF]
    for _ in range(rng.randint(1, 8)):
        n = rng.randint(0, 700)
        if kind == "all_full":
            values = [rng.choice(full) for _ in range(n)]
        elif kind == "late_signal":
            cut = rng.randint(0, n)
            values = [0xFFFC] * cut + [rng.randrange(0, 0xFFFC, 4) for _ in range(n - cut)]
        else:
            values = [rng.randrange(0, 0x10000) for _ in range(n)]
        yield array.array("H", values)


@pytest.mark.parametrize("kind", ["all_full", "late_signal", "random"])
@pytest.mark.parametrize("seed", range(40))
def test_matches_reference(kind, seed):
    rng = random.Random(seed * 7 + len(kind))
    minimum = rng.choice([1, 5, 64, 256, 1000])
    ref = _ReferenceMonitor(enabled=True, minimum_samples=minimum)
    new = _AdcPresenceMonitor(enabled=True, minimum_samples=minimum)
    for chunk in _chunks(rng, kind):
        a = ref.observe(chunk)
        b = new.observe(chunk)
        assert (a is None) == (b is None)
        assert _state(ref) == _state(new)
        if a is not None:
            break


def test_eight_bit_and_ndarray_chunks():
    ref = _ReferenceMonitor(enabled=True, minimum_samples=10)
    new = _AdcPresenceMonitor(enabled=True, minimum_samples=10)
    chunks = [array.array("B", [0xFF] * 4), np.array([0x3F, 0xFF, 7, 9], dtype=np.uint8), b"\x01\xff"]
    for chunk in chunks:
        assert (ref.observe(chunk) is None) == (new.observe(chunk) is None)
        assert _state(ref) == _state(new)


def test_disabled_is_noop():
    m = _AdcPresenceMonitor(enabled=False)
    assert m.observe(array.array("H", [0xFFFC] * 1000)) is None
    assert m.sample_count == 0
