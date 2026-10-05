"""Pfeiffer Vacuum protocol for RS-485 (TC 110 / TC 400 / DCU turbo drives).

Telegram: ``aaa`` address, ``*0`` action (``00`` query, ``10`` command /
response), ``nnn`` parameter, ``ll`` data length, data, ``ccc`` checksum
(sum of all preceding ASCII codes mod 256, three decimal digits), ``CR``.

Example query of the actual rotation speed (parameter 309) at address 1::

    0010030902=?107\\r

Used by the emulated turbo controllers and by :class:`PfeifferClient`, which
talks to the real drives on the board's RS-485 port (J4).
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Protocol

# Common parameters (Pfeiffer TC 110 / TC 400 operating instructions).
P_PUMPG_STATN = 10   # pumping station on/off (boolean_old "111111"/"000000")
P_MOTOR_PUMP = 23    # motor pump on/off
P_ERROR_CODE = 303   # "no Err", "Err001", "Wrn007" ...
P_SET_ROT_SPD = 308  # set rotation speed, Hz
P_ACTUAL_SPD = 309   # actual rotation speed, Hz
P_DRV_CURRENT = 310  # drive current, A (u_real: 6 digits, 2 decimals)
P_ELEC_NAME = 349    # electronic drive unit name


class PfeifferProtocolError(ValueError):
    pass


def checksum(body: str) -> str:
    return f"{sum(body.encode('ascii')) % 256:03d}"


def encode(address: int, action: int, parameter: int, data: str) -> bytes:
    if not 1 <= address <= 999:
        raise ValueError("Pfeiffer address must be 1..999")
    body = f"{address:03d}{action:02d}{parameter:03d}{len(data):02d}{data}"
    return (body + checksum(body) + "\r").encode("ascii")


def query(address: int, parameter: int) -> bytes:
    return encode(address, 0, parameter, "=?")


def command(address: int, parameter: int, data: str) -> bytes:
    return encode(address, 10, parameter, data)


@dataclass(frozen=True)
class Telegram:
    address: int
    action: int
    parameter: int
    data: str

    @property
    def is_query(self) -> bool:
        return self.action == 0 and self.data == "=?"


def decode(raw: bytes) -> Telegram:
    text = raw.decode("ascii", errors="replace").rstrip("\r")
    if len(text) < 13:
        raise PfeifferProtocolError(f"telegram too short: {text!r}")
    body, cks = text[:-3], text[-3:]
    if checksum(body) != cks:
        raise PfeifferProtocolError(f"bad checksum in {text!r}")
    try:
        address = int(body[0:3])
        action = int(body[3:5])
        parameter = int(body[5:8])
        length = int(body[8:10])
    except ValueError as exc:
        raise PfeifferProtocolError(f"malformed telegram {text!r}") from exc
    data = body[10:]
    if len(data) != length:
        raise PfeifferProtocolError(f"length field {length} != {len(data)} in {text!r}")
    return Telegram(address, action, parameter, data)


def boolean_old(value: bool) -> str:
    return "111111" if value else "000000"


def u_integer(value: int) -> str:
    return f"{max(0, min(999999, int(value))):06d}"


def u_real(value: float) -> str:
    return f"{max(0, min(9999.99, value)) * 100:06.0f}"


class SerialLike(Protocol):
    def write(self, data: bytes) -> int: ...
    def read_until(self, expected: bytes = b"\n", size: int | None = None) -> bytes: ...
    def reset_input_buffer(self) -> None: ...


class PfeifferClient:
    """Half-duplex master for the RS-485 bus on the vacuum I/O board.

    ``set_driver_enable`` drives the MAX3485 DE/RE line (GPIO18).  The line is
    raised for the request only and released before the reply arrives.
    """

    def __init__(self, port: SerialLike, set_driver_enable: Callable[[bool], None],
                 *, sleep: Callable[[float], None] = time.sleep,
                 baudrate: int = 9600) -> None:
        self._port = port
        self._de = set_driver_enable
        self._sleep = sleep
        self._char_time = 10.0 / baudrate

    def transact(self, request: bytes) -> Telegram:
        self._port.reset_input_buffer()
        self._de(True)
        try:
            self._port.write(request)
            # Hold DE until the last stop bit has left the shift register.
            self._sleep(len(request) * self._char_time + 0.0005)
        finally:
            self._de(False)
        raw = self._port.read_until(b"\r")
        if not raw.endswith(b"\r"):
            raise TimeoutError("no response from Pfeiffer drive")
        reply = decode(raw)
        sent = decode(request)
        if reply.address != sent.address or reply.parameter != sent.parameter:
            raise PfeifferProtocolError(f"unexpected reply {reply}")
        if reply.data in ("NO_DEF", "_RANGE", "_LOGIC"):
            raise PfeifferProtocolError(f"drive rejected parameter {sent.parameter}: {reply.data}")
        return reply

    def read(self, address: int, parameter: int) -> str:
        return self.transact(query(address, parameter)).data

    def actual_speed_hz(self, address: int) -> int:
        return int(self.read(address, P_ACTUAL_SPD))

    def error_code(self, address: int) -> str:
        return self.read(address, P_ERROR_CODE).strip()

    def set_pumping_station(self, address: int, on: bool) -> None:
        self.transact(command(address, P_PUMPG_STATN, boolean_old(on)))
