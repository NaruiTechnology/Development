import array

from glasgow_service.service import DeviceService


def test_raster_validation_allows_zero_valued_full_chunks():
    svc = object.__new__(DeviceService)
    pixels_per_chunk = 8192
    expected_chunks = 128
    chunks = [array.array("H", [0] * pixels_per_chunk) for _ in range(expected_chunks)]

    validation = svc._validate_raster(chunks, pixels_per_chunk, expected_chunks)

    assert validation.passed
    assert [check.name for check in validation.checks] == [
        "chunk_count",
        "full_chunk_sizes",
        "tail_chunk_size",
    ]


def test_vector_validation_allows_zero_valued_chunks():
    svc = object.__new__(DeviceService)
    chunks = [array.array("H", [0] * 4098) for _ in range(512)]

    validation = svc._validate_vector(chunks)

    assert validation.passed
    assert [check.name for check in validation.checks] == [
        "non_zero_chunks",
        "all_chunks_non_empty",
    ]
