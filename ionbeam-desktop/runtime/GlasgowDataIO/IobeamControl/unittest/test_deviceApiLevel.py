"""A Glasgow that is present and running compatible firmware must be found.

``GlasgowDevice`` only reports devices whose firmware API level the host
supports. Anything else takes the reload path: claim every interface, upload
firmware, and wait for the device to re-enumerate on the bus. That path fails in
ways a plain ``lsusb`` cannot show (another process holds an interface, or the
device does not reappear in time, as can happen behind VM USB passthrough), and
the result is "device not found" for a device that is right there.

So a device already running a compatible level must be used as it is, with no
claim and no reload. The bundled firmware.ihex must also declare the level the
host code names as its own.
"""
from pathlib import Path

import pytest
import usb1
from fx2 import REG_CPUCS
from fx2.format import input_data

from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware import device as dev

REV_C3 = 0x33
# MOV DPTR,#EP0BUF ; MOV A,#<API level> ... MOVX @DPTR,A -- how the FX2 firmware
# answers the "API level" request (firmware/main.c).
API_STORE = bytes([0x90, 0xE7, 0x40, 0x74])


def api_level_of(image: bytes) -> int:
    found, i = [], 0
    while (i := image.find(API_STORE, i)) >= 0:
        if i + 5 < len(image) and image[i + 5] == 0xF0:
            found.append(image[i + 4])
        i += 1
    assert len(found) == 1, f"expected one API-level store in the firmware, found {found}"
    return found[0]


class FakeConfig:
    def getConfigurationValue(self):
        return 1

    def getNumInterfaces(self):
        return 1


class FakeHandle:
    def __init__(self, device):
        self.device = device

    def getDevice(self):
        return self.device

    def getConfiguration(self):
        return 1

    def claimInterface(self, number):
        self.device.claims += 1
        if self.device.busy:
            raise usb1.USBErrorBusy()

    def getASCIIStringDescriptor(self, index):
        return "TESTSERIAL"

    def close(self):
        pass

    def controlWrite(self, request_type, request, value, index, data):
        device = self.device
        if value == REG_CPUCS:
            if list(data) == [1]:
                device.ram.clear()
            else:                                    # released from reset: firmware boots
                device.uploads += 1
                if not device.reappears:
                    device.gone = True
                    return
                image = bytearray(max(device.ram) + 1)
                for address, byte in device.ram.items():
                    image[address] = byte
                device.api = api_level_of(bytes(image))
        else:
            for offset, byte in enumerate(bytes(data)):
                device.ram[value + offset] = byte


class FakeDevice:
    def __init__(self, api, *, busy=False, reappears=True):
        self.api, self.busy, self.reappears = api, busy, reappears
        self.claims = self.uploads = 0
        self.gone = False
        self.ram = {}

    def getVendorID(self):
        return dev.VID_QIHW

    def getProductID(self):
        return dev.PID_GLASGOW

    def getbcdDevice(self):
        return (self.api << 8) | REV_C3

    def open(self):
        return FakeHandle(self)

    def iterConfigurations(self):
        return [FakeConfig()]

    def getSerialNumberDescriptor(self):
        return 3

    def getBusNumber(self):
        return 1

    def getDeviceAddress(self):
        return 2


class FakeContext:
    def __init__(self, device):
        self.device = device

    def hasCapability(self, capability):
        return False

    def getDeviceIterator(self, skip_on_error=True):
        return [] if self.device.gone else [self.device]


@pytest.fixture(autouse=True)
def no_reenumeration_wait(monkeypatch):
    monkeypatch.setattr(dev.time, "sleep", lambda seconds: None)


def enumerate_devices(device):
    return dev.GlasgowDevice._enumerate_devices(FakeContext(device))


def test_bundled_firmware_declares_the_level_the_host_expects():
    path = Path(dev.__file__).with_name("firmware.ihex")
    with open(path) as file:
        image = {}
        for address, chunk in input_data(file, fmt="ihex"):
            for offset, byte in enumerate(chunk):
                image[address + offset] = byte
    flat = bytearray(max(image) + 1)
    for address, byte in image.items():
        flat[address] = byte

    assert api_level_of(bytes(flat)) == dev.CUR_API_LEVEL, \
        "firmware.ihex and CUR_API_LEVEL disagree"
    assert dev.CUR_API_LEVEL in dev.COMPATIBLE_API_LEVELS


@pytest.mark.parametrize("api", sorted(dev.COMPATIBLE_API_LEVELS))
def test_device_at_a_compatible_level_is_found_without_a_reload(api):
    device = FakeDevice(api)

    found = enumerate_devices(device)

    assert list(found) == ["TESTSERIAL"]
    assert device.uploads == 0, "a compatible device must not have its firmware reloaded"
    assert device.claims == 0, "a compatible device must not have its interfaces claimed"


def test_compatible_device_with_busy_interfaces_is_still_found():
    """Another process holding an interface must not hide the device."""
    device = FakeDevice(0x05, busy=True)

    assert list(enumerate_devices(device)) == ["TESTSERIAL"]


def test_compatible_device_that_would_not_reenumerate_is_still_found():
    """A VM that fails to re-attach the device after a reload must not matter."""
    device = FakeDevice(0x05, reappears=False)

    assert list(enumerate_devices(device)) == ["TESTSERIAL"]
    assert device.uploads == 0


def test_device_without_firmware_is_loaded_with_the_bundled_firmware():
    device = FakeDevice(0)

    found = enumerate_devices(device)

    assert list(found) == ["TESTSERIAL"]
    assert device.uploads == 1 and device.api == dev.CUR_API_LEVEL


def test_device_at_an_unsupported_level_is_reloaded():
    device = FakeDevice(0x09)

    found = enumerate_devices(device)

    assert list(found) == ["TESTSERIAL"]
    assert device.uploads == 1 and device.api == dev.CUR_API_LEVEL


def test_device_at_an_unsupported_level_with_busy_interfaces_is_skipped():
    """Unchanged behaviour: an incompatible device that cannot be claimed is not usable."""
    device = FakeDevice(0x09, busy=True)

    assert enumerate_devices(device) == {}
    assert device.uploads == 0
