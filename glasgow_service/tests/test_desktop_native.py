import array
import asyncio
import json
import struct
from types import SimpleNamespace
import pytest
from glasgow_service.desktop_native import NativeScanServer, native_payload
from glasgow_service.models import RasterRequest, VectorRequest
from glasgow_service.service import DeviceBusy


async def connect(path, request):
    reader, writer = await asyncio.open_unix_connection(path)
    body = json.dumps(request).encode()
    writer.write(struct.pack('>I', len(body)) + body)
    await writer.drain()
    return reader, writer


async def read_frame(reader):
    kind, size = struct.unpack('>BI', await reader.readexactly(5))
    data = await reader.readexactly(size)
    return kind, json.loads(data) if kind == 0 else data


def test_native_memoryview_does_not_copy_samples():
    chunk = array.array('H', [4, 0x1234, 0xfffc])
    tag, view = native_payload(chunk)
    assert tag == 2
    assert view.obj is chunk
    assert bytes(view) == b'\x04\x00\x34\x12\xfc\xff'
    assert native_payload(array.array('B', [0, 255]))[0] == 1


@pytest.mark.parametrize('kind', ['raster', 'vector'])
def test_real_simulator_native_samples_match_web(kind):
    from .test_simulation_scan_path import make_service
    request = RasterRequest(resolution=128) if kind == 'raster' else VectorRequest(vector_resolution=128)
    async def run():
        first, second = make_service(), make_service()
        expected = b''.join([chunk async for chunk in getattr(first, f'{kind}_scan')(request)])
        native = [chunk async for chunk in getattr(second, f'{kind}_scan')(request, native_samples=True)]
        values = [value for chunk in native for value in chunk]
        assert values == list(struct.unpack(f'>{len(expected)//2}H', expected))
        assert second.status().state.value == 'idle'
    asyncio.run(run())


def test_native_socket_auth_samples_busy_and_cancellation(tmp_path):
    async def run():
        closed = asyncio.Event()
        lock = asyncio.Lock()
        async def scan(request, *, native_samples):
            assert native_samples
            if lock.locked():
                raise DeviceBusy()
            async with lock:
                try:
                    yield array.array('H', [4, 0x1234, 0xfffc])
                    await asyncio.Event().wait()
                finally:
                    closed.set()
        server = NativeScanServer(SimpleNamespace(raster_scan=scan, vector_scan=scan, dac_ramp_scan=scan, adc_stream=scan), tmp_path/'private'/'scan.sock', token='secret')
        await server.start()
        try:
            reader, writer = await connect(server.path, {'kind':'raster','request':{},'token':'wrong'})
            assert (await read_frame(reader))[1]['code'] == 'unauthorized'
            writer.close(); await writer.wait_closed()
            reader, writer = await connect(server.path, {'kind':'raster','request':{},'token':'secret'})
            assert await read_frame(reader) == (2, b'\x04\x00\x34\x12\xfc\xff')
            other, other_writer = await connect(server.path, {'kind':'raster','request':{},'token':'secret'})
            assert (await read_frame(other))[1]['code'] == 'busy'
            other_writer.close(); await other_writer.wait_closed()
            assert not closed.is_set()
            writer.close(); await writer.wait_closed()
            await asyncio.wait_for(closed.wait(), 1)
            assert not lock.locked()
            # A second server cannot replace a live native acquisition socket.
            another = NativeScanServer(server.service, server.path)
            with pytest.raises(BlockingIOError):
                await another.start()
        finally:
            await server.close()
        assert not server.path.exists()
    asyncio.run(run())


def test_native_socket_completion_and_validation(tmp_path):
    async def run():
        called = False
        async def scan(request, *, native_samples):
            nonlocal called
            called = True
            yield array.array('B', [0, 255])
        service = SimpleNamespace(raster_scan=scan, vector_scan=scan, dac_ramp_scan=scan, adc_stream=scan)
        server = NativeScanServer(service, tmp_path/'private'/'scan.sock', token='')
        await server.start()
        try:
            reader, writer = await connect(server.path, {'kind':'raster','request':{'resolution':-1}})
            assert (await read_frame(reader))[1]['event'] == 'error'
            assert not called
            writer.close(); await writer.wait_closed()
            reader, writer = await connect(server.path, {'kind':'raster','request':{}})
            assert await read_frame(reader) == (1, b'\x00\xff')
            assert await read_frame(reader) == (0, {'event':'done','chunks':1})
            writer.close(); await writer.wait_closed()
        finally:
            await server.close()
    asyncio.run(run())
