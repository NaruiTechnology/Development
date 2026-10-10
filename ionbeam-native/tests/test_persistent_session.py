"""Persistent Glasgow session against the byte-level emulator.

These exercise the real macros, GlasgowConnection/Stream code and
DeviceService scan paths; only USB + gateware are emulated
(``ionbeam_native.testing.fake_glasgow``).
"""
import asyncio

import numpy as np
import pytest

from glasgow_service.models import RasterRequest, VectorRequest
from ionbeam_native.engine.persistent import PersistentGlasgowConnection
from ionbeam_native.engine.service import DesktopDeviceService
from ionbeam_native.testing.fake_glasgow import FakeStreamLauncherMixin, sample_value


class FakePersistentConnection(FakeStreamLauncherMixin, PersistentGlasgowConnection):
    pass


class FakeDesktopService(DesktopDeviceService):
    connection_cls = FakePersistentConnection


def raster(res=256, cookie=123, dwell=1):
    return RasterRequest(resolution=res, dwell=dwell, latency_bytes=16384, cookie=cookie,
                         output_mode="SixteenBit", adc_valid=True, do_validate=True)


def vector(res=256, cookie=321, dwell=2):
    return VectorRequest(pattern="default", scan_path="horizontal_sawtooth", vector_resolution=res, dwell=dwell,
                         latency_bytes=8196, output_mode="SixteenBit", adc_valid=True, cookie=cookie,
                         pre_process=True, do_validate=True)


def samples_of(chunks):
    return np.concatenate([np.asarray(c, dtype=np.uint16) for c in chunks]) if chunks else np.zeros(0, np.uint16)


async def collect(gen, stop_after=None, on_chunk=None):
    chunks = []
    async for chunk in gen:
        chunks.append(np.array(chunk, dtype=np.uint16))
        if on_chunk is not None:
            on_chunk(len(chunks))
        if stop_after is not None and len(chunks) >= stop_after:
            pass
    return samples_of(chunks)


def expected(cookie, n):
    return np.array([sample_value(cookie, i) for i in range(n)], dtype=np.uint16)


def stray_senders():
    return [t for t in asyncio.all_tasks() if not t.done()
            and "sender" in getattr(t.get_coro(), "__qualname__", "")]


def test_consecutive_scans_share_one_session(stream_config):
    async def main():
        svc = FakeDesktopService(stream_config)
        try:
            for cookie in (123, 456, 789):
                data = await collect(svc.raster_scan(raster(cookie=cookie), native_samples=True))
                assert data.size == 256 * 256
                assert np.array_equal(data, expected(cookie, data.size))
            stats = svc.session_stats
            assert stats.connects == 1
            assert stats.soft_resets == 3
            assert stats.hard_closes == 0
            assert svc._conn.fake_iface.resets == 3
            # applet run gate re-asserted on every soft reset
            assert svc._conn.fake_iface.device.registers[0x10] == 1
            assert svc.session_open
            assert not stray_senders()
        finally:
            await svc.stop()
    asyncio.run(main())


def test_abort_then_rescan_has_no_stale_samples(stream_config):
    async def main():
        svc = FakeDesktopService(stream_config)
        FakePersistentConnection.fake_kwargs = {"time_scale": 5.0}  # slow beam so the abort lands mid-frame
        try:
            gen = svc.raster_scan(raster(res=512, cookie=111, dwell=4), native_samples=True)
            got = 0
            async for chunk in gen:
                got += len(chunk)
                if got >= 16384:
                    assert svc.abort_active_scan()
            await gen.aclose()
            # (a run-length raster frame is already queued in the gateware when
            # the abort lands, so how much of it arrives is not asserted; what
            # matters is that none of it leaks into the next scan)
            assert got >= 16384
            FakePersistentConnection.fake_kwargs = {}
            data = await collect(svc.raster_scan(raster(cookie=222), native_samples=True))
            assert data.size == 256 * 256
            assert np.array_equal(data, expected(222, data.size)), "stale samples from the aborted scan"
            assert svc.session_stats.connects == 1
            assert not stray_senders()
        finally:
            FakePersistentConnection.fake_kwargs = {}
            await svc.stop()
    asyncio.run(main())


def test_vector_after_raster_on_same_session(stream_config):
    async def main():
        svc = FakeDesktopService(stream_config)
        try:
            await collect(svc.raster_scan(raster(cookie=10), native_samples=True))
            data = await collect(svc.vector_scan(vector(cookie=20), native_samples=True))
            assert data.size == 256 * 256
            assert np.array_equal(data, expected(20, data.size))
            assert svc.session_stats.connects == 1
        finally:
            await svc.stop()
    asyncio.run(main())


def test_soft_reset_failure_falls_back_to_hard_close(stream_config):
    async def main():
        svc = FakeDesktopService(stream_config)
        try:
            await collect(svc.raster_scan(raster(cookie=1), native_samples=True))
            iface = svc._conn.fake_iface

            async def broken_reset():
                raise OSError("LIBUSB_ERROR_IO")
            iface.reset = broken_reset
            await collect(svc.raster_scan(raster(cookie=2), native_samples=True))
            assert svc.session_stats.hard_closes == 1
            assert iface.device.closed
            data = await collect(svc.raster_scan(raster(cookie=3), native_samples=True))
            assert np.array_equal(data, expected(3, data.size))
            assert svc.session_stats.connects == 2   # reconnected like the web service would
        finally:
            await svc.stop()
    asyncio.run(main())


def test_release_device_frees_lock_for_web_service(stream_config):
    from glasgow_service.device_lock import DeviceHeld, DeviceLock

    async def main():
        svc = FakeDesktopService(stream_config)
        await svc.open_session()
        other = DeviceLock("glasgow_service (web UI)")
        with pytest.raises(DeviceHeld, match="desktop"):
            other.acquire()
        await svc.release_device()
        assert not svc.session_open
        other.acquire()
        assert other.held
        other.release()
        await svc.stop()
    asyncio.run(main())


def test_engine_live_mode_streams_frames_without_reconnect(stream_config):
    import threading
    from ionbeam_native.engine.engine import Engine, ScanJob

    engine = Engine(stream_config, post=lambda fn: fn(), service_cls=FakeDesktopService)
    frames, done = [], threading.Event()
    outcome = {}

    def on_frame(index, result):
        frames.append(result)
        if len(frames) == 5:
            engine.stop()

    def on_finished(result):
        outcome.update(result)
        done.set()

    req = raster().model_dump()
    engine.start_stream(ScanJob("raster", req, live=True), on_started=lambda: None,
                        on_frame=on_frame, on_finished=on_finished)
    assert done.wait(30)
    try:
        assert len(frames) >= 5
        assert outcome["event"] in ("stopped", "done")
        assert all(not f["perf"]["reconnected"] for f in frames[1:])
        view = engine.raster.view()
        assert view.cursor == view.total == 256 * 256
        assert engine.svc.session_stats.connects == 1
    finally:
        engine.shutdown()
