"""Local OBI-style acquisition: native sample arrays over a private Unix socket.

No HTTP/WebSocket encoding in the sample path. The existing DeviceService owns
the USB interface, pipeline, abort handling, cache and acquisition lock.
"""
import array
import asyncio
import contextlib
import fcntl
import hmac
import json
import os
from pathlib import Path
import stat
import struct
import sys

from .models import RasterRequest, VectorRequest, DacRampRequest, AdcTestRequest
from .service import DeviceBusy, DeviceNotReady


def default_socket_path():
    base = Path.home() / '.cache'
    return base / 'ionbeam-desktop' / 'scan.sock'


def native_payload(chunk):
    if isinstance(chunk, array.array) and chunk.typecode == 'H':
        if sys.byteorder != 'little':
            chunk = array.array('H', chunk)
            chunk.byteswap()
        return 2, memoryview(chunk).cast('B')
    return 1, memoryview(chunk).cast('B')


class NativeScanServer:
    def __init__(self, service, path=None, token=None):
        self.service = service
        self.path = Path(path or os.environ.get('GLASGOW_DESKTOP_SOCKET') or default_socket_path())
        self.token = os.environ.get('GLASGOW_TOKEN', '') if token is None else token
        self.tasks = set()
        self.server = None
        self.lock = None

    async def start(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.path.parent.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise PermissionError('Desktop socket directory must be owned by this user and mode 0700')
        self.lock = open(str(self.path) + '.lock', 'a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.path.exists():
                if not stat.S_ISSOCK(self.path.lstat().st_mode):
                    raise RuntimeError('Refusing to replace a non-socket desktop path')
                self.path.unlink()
            self.server = await asyncio.start_unix_server(self._client, path=self.path)
            self.path.chmod(0o600)
        except BaseException:
            self.lock.close()
            self.lock = None
            raise

    async def close(self):
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            for task in tuple(self.tasks):
                task.cancel()
            await asyncio.gather(*self.tasks, return_exceptions=True)
            self.path.unlink(missing_ok=True)
        if self.lock is not None:
            self.lock.close()

    async def _send(self, writer, kind, data):
        if kind == 0:
            data = json.dumps(data, separators=(',', ':')).encode()
        if len(data) > 16 * 1024 * 1024:
            raise ValueError('Native sample frame exceeds 16 MiB')
        writer.write(struct.pack('>BI', kind, len(data)))
        writer.write(data)
        await writer.drain()

    async def _scan(self, writer, kind, request):
        methods = {
            'raster': (RasterRequest, self.service.raster_scan),
            'vector': (VectorRequest, self.service.vector_scan),
            'dac_ramp': (DacRampRequest, self.service.dac_ramp_scan),
            'adc': (AdcTestRequest, self.service.adc_stream),
        }
        if kind not in methods:
            raise ValueError('Unsupported scan kind')
        model, method = methods[kind]
        request = model(**request)
        gen = method(request) if kind == 'adc' else method(request, native_samples=True)
        chunks = 0
        try:
            if kind == 'adc':
                await self._send(writer, 0, {'event': 'metadata', 'duration_minutes': request.duration_minutes,
                                            'simulation': request.simulation, 'sample_bits': 14, 'wire_format': 'uint16-be'})
            async for chunk in gen:
                tag, payload = native_payload(chunk)
                await self._send(writer, tag, payload)
                chunks += 1
            await self._send(writer, 0, {'event': 'done', 'chunks': chunks})
        finally:
            await gen.aclose()

    async def _client(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        work = disconnect = None
        try:
            header = await asyncio.wait_for(reader.readexactly(4), 10)
            size, = struct.unpack('>I', header)
            if size > 128 * 1024 * 1024:
                raise ValueError('Scan request exceeds 128 MiB')
            raw = await asyncio.wait_for(reader.readexactly(size), 30)
            command = json.loads(raw)
            if self.token and not hmac.compare_digest(str(command.get('token', '')), self.token):
                await self._send(writer, 0, {'event': 'error', 'code': 'unauthorized'})
                return
            work = asyncio.create_task(self._scan(writer, command.get('kind'), command.get('request', {})))
            disconnect = asyncio.create_task(reader.read(1))
            done, _ = await asyncio.wait([work, disconnect], return_when=asyncio.FIRST_COMPLETED)
            if disconnect in done and not work.done():
                work.cancel()
            await work
        except (asyncio.CancelledError, BrokenPipeError, ConnectionResetError, asyncio.IncompleteReadError):
            pass
        except Exception as exc:
            code = 'busy' if isinstance(exc, DeviceBusy) else 'not_ready' if isinstance(exc, DeviceNotReady) else 'scan_error'
            with contextlib.suppress(Exception):
                await self._send(writer, 0, {'event': 'error', 'code': code, 'message': str(exc)})
        finally:
            for child in (work, disconnect):
                if child is not None and not child.done():
                    child.cancel()
            await asyncio.gather(*(t for t in (work, disconnect) if t), return_exceptions=True)
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
            self.tasks.discard(task)
