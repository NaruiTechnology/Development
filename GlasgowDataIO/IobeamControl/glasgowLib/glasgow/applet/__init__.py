from abc import ABCMeta, abstractmethod
import os
import shlex
import unittest
import argparse
import functools
import asyncio
import threading

from ..support.plugin import PluginMetadata
from ..support.arepl import AsyncInteractiveConsole
from ..support.mock import MockRecorder, MockReplayer
from ..abstract import GlasgowVio, GlasgowPin, AbstractAssembly
from ..hardware.toolchain import find_toolchain
from ..hardware.device import GlasgowDevice
from ..hardware.assembly import HardwareAssembly
from ..simulation.assembly import SimulationAssembly
from ..gateware.clockgen import ClockGen
from ..hardware.multiplexer import DirectMultiplexer
from ..hardware.device import GlasgowDevice


__all__ = [
    "GlasgowAppletError",
    "GlasgowAppletMetadata", "GlasgowAppletArguments", "GlasgowAppletV2",
    "GlasgowAppletToolMetadata", "GlasgowAppletTool",
    "synthesis_test", "async_test",
    "GlasgowAppletV2TestCase", "applet_v2_simulation_test", "applet_v2_hardware_test",
    # deprecated:
    "GlasgowApplet", "GlasgowAppletTestCase", "applet_simulation_test", "applet_hardware_test"
]


class GlasgowAppletMetadata(PluginMetadata):
    # A Glasgow applet is defined by a class; known applets are taken from a
    # list of entry points in package metadata.  (In the Glasgow package, they
    # are enumerated in the `[project.entry-points."glasgow.applet"]` section of
    # the pyproject.toml.
    GROUP_NAME = "glasgow.applet"


class GlasgowAppletToolMetadata(PluginMetadata):
    # A Glasgow applet tool is defined by a class; known applets are taken from a
    # list of entry points in package metadata.  (In the Glasgow package, they
    # are enumerated in the `[project.entry-points."glasgow.applet.tool"]` section of
    # the pyproject.toml.
    GROUP_NAME = "glasgow.applet.tool"


class GlasgowAppletError(Exception):
    """An exception raised when an applet encounters an error."""


class GlasgowAppletV2(metaclass=ABCMeta):
    preview = False
    help = "applet help missing"
    description = "applet description missing"
    required_revision = "A0"

    def __init__(self, assembly: AbstractAssembly):
        self._assembly = assembly

        if isinstance(assembly, HardwareAssembly):
            if assembly.revision < self.required_revision:
                self.logger.warning(f"applet requires a rev{self.required_revision}+ device, "
                                    f"use on a rev{assembly.revision} device is unsupported")
            if self.preview:
                self.logger.warning(f"applet is PREVIEW QUALITY and may CORRUPT DATA")

    @property
    def assembly(self) -> AbstractAssembly:
        return self._assembly

    @property
    def device(self) -> GlasgowDevice:
        return self._assembly.device

    @classmethod
    def add_build_arguments(cls, parser, access):
        access.add_voltage_argument(parser)

    @abstractmethod
    def build(self, args):
        self.assembly.use_voltage(args.voltage)

    @classmethod
    def add_setup_arguments(cls, parser):
        pass

    async def setup(self, args):
        pass

    @classmethod
    def add_run_arguments(cls, parser):
        pass

    async def run(self, args):
        raise GlasgowAppletError("this applet can only be used in REPL mode")

    @classmethod
    def add_repl_arguments(cls, parser):
        pass

    @property
    def _iface_attrs(self):
        for attr in dir(self):
            if attr.endswith("iface"):
                yield attr

    def _code_locals(self, args):
        return {
            "asyncio": asyncio,
            "self": self,
            "args": args,
            "device": self.device,
            **{attr: getattr(self, attr) for attr in self._iface_attrs}
        }

    async def repl(self, args):
        self.logger.info("dropping to REPL; use %s to see available APIs",
            ", ".join(f"'help({attr})'" for attr in self._iface_attrs))
        await AsyncInteractiveConsole(
            locals=self._code_locals(args),
            run_callback=self.assembly.flush_pipes
        ).interact()

    async def script(self, args, code):
        result = eval(code, self._code_locals(args))
        if asyncio.iscoroutine(result):
            await result

    @classmethod
    def tests(cls):
        return None

    @classmethod
    def _get_argparser_for_sphinx(cls, name):
        parser = argparse.ArgumentParser(name, description=cls.description)
        cls.add_build_arguments(parser, GlasgowAppletArguments(name))
        cls.add_setup_arguments(parser)
        cls.add_run_arguments(parser)
        return parser


class GlasgowAppletArguments:
    def __init__(self, applet_name):
        self._applet_name  = applet_name
        self._free_pins    = "A0 A1 A2 A3 A4 A5 A6 A7 B0 B1 B2 B3 B4 B5 B6 B7".split()

    def _arg_error(self, message):
        raise argparse.ArgumentTypeError(f"applet {self._applet_name!r}: " + message)

    def add_pins_argument(self, parser, name, width=None, default=None, required=False, help=None):
        def get_free_pin():
            if len(self._free_pins) > 0:
                result = self._free_pins[0]
                del self._free_pins[0]
                return GlasgowPin.parse(result)[0]

        if width is None:
            match default:
                case None:
                    pass
                case True:
                    default = get_free_pin()
                case _:
                    default = GlasgowPin.parse(default)[0]

            metavar = "PIN"
            if help is None:
                help = f"bind the applet I/O line {name!r} to {metavar}"
            if default:
                help += f" (default: {default})"

            def pin_arg(arg):
                try:
                    result = GlasgowPin.parse(arg)
                except ValueError as e:
                    self._arg_error(str(e))
                if required:
                    if len(result) != 1:
                        self._arg_error(f"expected a single pin, got {len(result)} pins")
                    return result[0]
                else:
                    if len(result) not in (0, 1):
                        self._arg_error(f"expected zero or one pins, got {len(result)} pins")
                    if result:
                        return result[0]

        else:
            if type(width) is int:
                width = range(width, width + 1)

            match default:
                case None:
                    pass
                case True:
                    default = []
                    while len(default) < width.start:
                        if pin := get_free_pin():
                            default.append(pin)
                        else:
                            break
                    default = tuple(default)
                case int():
                    default = tuple(get_free_pin() for _ in range(default))
                case _:
                    default = GlasgowPin.parse(default)

            metavar = "PINS"
            if help is None:
                help = f"bind the applet I/O lines {name!r} to {metavar}"
            if default:
                help += f" (default: {','.join(str(pin) for pin in default)})"
            else:
                help += " (default is empty)"

            def pin_arg(arg):
                try:
                    result = GlasgowPin.parse(arg)
                except ValueError as e:
                    self._arg_error(str(e))
                if len(result) not in width:
                    if len(width) == 1:
                        width_desc = f"{width.start}"
                    else:
                        width_desc = f"{width.start}..{width.stop - width.step}"
                    self._arg_error(f"expected {width_desc} pins, got {len(result)} pins")
                return result

        if required and default is not None:
            required = False

        parser.add_argument(
            f"--{name.lower().replace('_', '-')}", dest=name, metavar=metavar,
            type=pin_arg, default=default, required=required, help=help)

    def add_voltage_argument(self, parser):
        def voltage_arg(arg):
            return GlasgowVio.parse(arg)
        parser.add_argument(
            "-V", "--voltage", metavar="SPEC", type=voltage_arg, default={},
            help="configure I/O port voltage to SPEC (e.g.: '3.3', 'A=5.0,B=3.3', 'A=SA')")

    def add_build_arguments(self, parser):
        pass

    def add_run_arguments(self, parser):
        self.add_voltage_argument(parser)


class GlasgowAppletTool:
    def __init_subclass__(cls, applet, **kwargs):
        super().__init_subclass__(**kwargs)

        cls.logger = applet.logger

    @classmethod
    def add_arguments(cls, parser):
        pass

    async def run(self, args):
        pass

    @classmethod
    def _get_argparser_for_sphinx(cls, name):
        parser = argparse.ArgumentParser(name, description=cls.description)
        cls.add_arguments(parser)
        return parser


class GlasgowAppletV2TestCase(unittest.TestCase):
    def __init_subclass__(cls, applet, **kwargs):
        super().__init_subclass__(**kwargs)

        cls.applet_cls = applet

    @classmethod
    def _parse_args(cls, args, *, mode=None):
        access = GlasgowAppletArguments("applet")
        parser = argparse.ArgumentParser()
        cls.applet_cls.add_build_arguments(parser, access)
        if mode != "build":
            cls.applet_cls.add_setup_arguments(parser)
        match mode:
            case "run":
                cls.applet_cls.add_run_arguments(parser)
            case "repl":
                cls.applet_cls.add_repl_arguments(parser)
        match args:
            case None:
                return parser.parse_args([])
            case list():
                return parser.parse_args(args)
            case str():
                return parser.parse_args(shlex.split(args))
            case _:
                assert False

    def assertBuilds(self, args=None, *, revision=None):
        parsed_args = self._parse_args(args, mode="build")
        assembly = HardwareAssembly(revision=revision or self.applet_cls.required_revision)
        applet = self.applet_cls(assembly)
        applet.build(parsed_args)
        assembly.artifact().get_bitstream()


def synthesis_test(case):
    synthesis_available = find_toolchain(quiet=True) is not None
    return unittest.skipUnless(synthesis_available, "synthesis not available")(case)


def async_test(case):
    @functools.wraps(case)
    def wrapper(*args, **kwargs):
        thread_exn = None
        def run_case():
            nonlocal thread_exn
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(case(*args, **kwargs))
            except Exception as exn:
                thread_exn = exn
            finally:
                loop.close()

        thread = threading.Thread(target=run_case)
        thread.start()
        thread.join()
        if thread_exn is not None:
            raise thread_exn
    return wrapper


def applet_v2_simulation_test(*, prepare=None, args=None):
    def decorator(case):
        @functools.wraps(case)
        def wrapper(self):
            parsed_args = self._parse_args(args)
            assembly = SimulationAssembly()
            applet: GlasgowAppletV2 = self.applet_cls(assembly)
            applet.build(parsed_args)
            if prepare is not None:
                prepare(self, assembly)
            async def launch(ctx):
                await applet.setup(parsed_args)
                await case(self, applet, ctx)
            assembly.run(launch, vcd_file=f"{case.__name__}.vcd")
        return wrapper
    return decorator


def applet_v2_hardware_test(*, prepare=None, args=None, mock):
    def decorator(case):
        @functools.wraps(case)
        @async_test
        async def wrapper(self):
            *mock_path, mock_attr = mock.split(".")
            parsed_args = self._parse_args(args)
            fixture_path = os.path.join(
                os.path.dirname(case.__code__.co_filename), "fixtures",
                case.__name__ + ".json")
            if not os.path.exists(fixture_path):
                # Record mode
                device = GlasgowDevice()
                assembly = HardwareAssembly(device=device)
                applet: GlasgowAppletV2 = self.applet_cls(assembly)
                applet.build(parsed_args)
                async with assembly:
                    os.makedirs(os.path.dirname(fixture_path), exist_ok=True)
                    with open(f"{fixture_path}.new", "w") as fixture:
                        await applet.setup(parsed_args)
                        if prepare is not None:
                            await prepare(self, assembly)
                        mock_obj = applet
                        for attr in mock_path:
                            mock_obj = getattr(mock_obj, attr)
                        setattr(mock_obj, mock_attr,
                            MockRecorder(self, fixture, getattr(mock_obj, mock_attr)))
                        await case(self, applet)
                    os.rename(f"{fixture_path}.new", fixture_path)
                device.close()
            else:
                # Replay mode
                assembly = HardwareAssembly(revision=self.applet_cls.required_revision)
                applet: GlasgowAppletV2 = self.applet_cls(assembly)
                applet.build(parsed_args)
                with open(fixture_path, "r") as fixture:
                    mock_obj = applet
                    for attr in mock_path:
                        mock_obj = getattr(mock_obj, attr)
                    setattr(mock_obj, mock_attr, MockReplayer(self, fixture))
                    await case(self, applet)
        return wrapper
    return decorator


from ._legacy import *

#================ Glasgow/STS version 34e4bd252f033cbc94dfb821b404a9ba528ec14e ================

import re
import argparse
import functools
from abc import ABCMeta, abstractmethod
from dataclasses import dataclass
from contextlib import AbstractAsyncContextManager, asynccontextmanager

from amaranth import *

from ..support.arepl import *
from ..support.plugin import *
from ..gateware.clockgen import *

class GlasgowAppletMetadata(PluginMetadata):
    GROUP_NAME = "glasgow.applet"

    @property
    def applet_cls(self):
        return self.load()

    @property
    def tool_cls(self):
        return self.load().tool_cls


class GlasgowAppletError(Exception):
    """An exception raised when an applet encounters an error."""


# A Glasgow applet is defined by a class; known applets are taken from a
# list of entry points in package metadata.  (In the Glasgow package, they
# are enumerated in the `[project.entry-points."glasgow.applet"]` section of
# the pyproject.toml.

class GlasgowApplet(metaclass=ABCMeta):
    preview = False
    help = "applet help missing"
    description = "applet description missing"
    required_revision = "A0"

    @classmethod
    def add_build_arguments(cls, parser, access):
        access.add_build_arguments(parser)

    def derive_clock(self, *args, clock_name=None, **kwargs):
        try:
            return ClockGen.derive(*args, **kwargs, logger=self.logger, clock_name=clock_name)
        except ValueError as e:
            if clock_name is None:
                raise GlasgowAppletError(e)
            else:
                raise GlasgowAppletError(f"clock {clock_name}: {e}")

    @abstractmethod
    def build(self, target):
        pass

    @classmethod
    def add_run_arguments(cls, parser, access):
        access.add_run_arguments(parser)

    async def run_lower(self, cls, device, args, **kwargs):
        return await super(cls, self).run(device, args, **kwargs)

    @abstractmethod
    async def run(self, device, args):
        pass

    @classmethod
    def add_interact_arguments(cls, parser):
        pass

    async def interact(self, device, args, iface):
        raise GlasgowAppletError("This applet can only be used in REPL mode.")

    @classmethod
    def add_repl_arguments(cls, parser):
        pass

    async def repl(self, device, args, iface):
        self.logger.info("dropping to REPL; use 'help(iface)' to see available APIs")
        await AsyncInteractiveConsole(locals={"device":device, "iface":iface, "args":args},
            run_callback=device.demultiplexer.flush).interact()

    @classmethod
    def tests(cls):
        return None

@dataclass(frozen=True)
class PinArgument:
    number: int
    invert: bool = False

    def __str__(self):
        return f"{self.number}{'#' if self.invert else ''}"
class GlasgowAppletArguments:
    def _arg_error(self, message):
        raise argparse.ArgumentTypeError(f"applet {self._applet_name!r}: " + message)

    # First, define some state-less methods that just add arguments to an argparse instance.

    def _port_spec(self, arg):
        if not re.match(r"^[A-Z]+$", arg):
            self._arg_error(f"{arg} is not a valid port specification")
        return arg

    def _add_port_argument(self, parser, default):
        help = "bind the applet to port SPEC"
        if default is not None:
            help += " (default: %(default)s)"

        parser.add_argument(
            "--port", dest="port_spec", metavar="SPEC", type=self._port_spec,
            default=default, help=help)

    def _add_port_voltage_arguments(self, parser, default):
        g_voltage = parser.add_mutually_exclusive_group(required=True)
        g_voltage.add_argument(
            "-V", "--voltage", metavar="VOLTS", type=float, nargs="?", default=default,
            help="set I/O port voltage explicitly")
        g_voltage.add_argument(
            "-M", "--mirror-voltage", action="store_true", default=False,
            help="sense and mirror I/O port voltage")
        g_voltage.add_argument(
            "--keep-voltage", action="store_true", default=False,
            help="do not change I/O port voltage")

    def _mandatory_pin_number(self, arg):
        if not re.match(r"^[0-9]+#?$", arg):
            self._arg_error(f"{arg} is not a valid pin number")
        return PinArgument(int(arg.replace("#", "")), invert=arg.endswith("#"))

    def _optional_pin_number(self, arg):
        if arg == "-":
            return None
        return self._mandatory_pin_number(arg)

    def _add_pin_argument(self, parser, name, default, required, help):
        if help is None:
            help = f"bind the applet I/O line {name!r} to pin NUM"
        if default is not None:
            default = PinArgument(default)
            help += f" (default: {default})"

        if required:
            type = self._mandatory_pin_number
            if default is not None:
                required = False
        else:
            type = self._optional_pin_number

        opt_name = "--pin-" + name.lower().replace("_", "-")
        parser.add_argument(
            opt_name, metavar="NUM", type=type, default=default, required=required, help=help)

    def _pin_set(self, width, arg):
        if arg == "":
            pin_args = []
        elif re.match(r"^[0-9]+:[0-9]+#?$", arg):
            first, last = map(int, arg.replace("#", "").split(":"))
            pin_args = [PinArgument(int(number), invert=arg.endswith("#"))
                        for number in range(first, last + 1)]
        elif re.match(r"((^|,)[0-9]+#?)+$", arg):
            pin_args = [PinArgument(int(number.replace("#", "")), invert=number.endswith("#"))
                        for number in arg.split(",")]
        else:
            self._arg_error(f"{arg} is not a valid pin number set")
        if len(pin_args) not in width:
            if len(width) == 1:
                width_desc = str(width[0])
            else:
                width_desc = f"{width.start}..{width.stop - 1}"
            self._arg_error(f"set {arg} includes {len(pin_args)} pins, but "
                            f"{width_desc} pins are required")
        return pin_args

    def _add_pin_set_argument(self, parser, name, width, default, required, help):
        if help is None:
            help = f"bind the applet I/O lines {name!r} to pins SET"
        if default is not None:
            default = [PinArgument(number) for number in default]
            if default:
                help += f" (default: {', '.join(map(str, default))})"
            else:
                help += " (default is empty)"
        if required and default is not None:
            required = False

        opt_name = "--pins-" + name.lower().replace("_", "-")
        parser.add_argument(
            opt_name, dest=f"pin_set_{name}", metavar="SET",
            type=functools.partial(self._pin_set, width), default=default, required=required,
            help=help)

    # Second, define a stateful interface that has features like automatically assigning
    # default pin numbers.

    def __init__(self, applet_name, default_port, pin_count):
        self._applet_name  = applet_name
        self._default_port = default_port
        self._free_pins    = list(range(pin_count))

    @staticmethod
    def _get_free(free_list):
        if len(free_list) > 0:
            result = free_list[0]
            free_list.remove(result)
            return result

    def add_build_arguments(self, parser):
        self._add_port_argument(parser, self._default_port)

    def add_pin_argument(self, parser, name, default=None, required=False, help=None):
        if default is True:
            default = self._get_free(self._free_pins)
        self._add_pin_argument(parser, name, default, required, help)

    def add_pin_set_argument(self, parser, name, width, default=None, required=False, help=None):
        if isinstance(width, int):
            width = range(width, width + 1)
        if default is True and len(self._free_pins) >= width.start:
            default = [self._get_free(self._free_pins) for _ in range(width.start)]
        elif isinstance(default, int) and len(self._free_pins) >= default:
            default = [self._get_free(self._free_pins) for _ in range(default)]
        self._add_pin_set_argument(parser, name, width, default, required, help)

    def add_run_arguments(self, parser):
        self._add_port_voltage_arguments(parser, default=None)


class GlasgowAppletTool:
    def __init_subclass__(cls, applet, **kwargs):
        super().__init_subclass__(**kwargs)

        applet.tool_cls = cls
        cls.applet_cls  = applet
        cls.logger      = applet.logger

    @classmethod
    def add_arguments(cls, parser):
        pass

    async def run(self, args):
        pass

# -------------------------------------------------------------------------------------------------

import os
import unittest
import functools
import asyncio
import types
import threading
import inspect
import json
from amaranth.sim import *

from ..simulation import *
from ..hardware import *
from ..simulation.target import *
from ..hardware.target import *
from ..simulation.device import *
from ..hardware.device import *
from ..hardware.toolchain import find_toolchain
from ..hardware.platform.rev_ab import GlasgowRevABPlatform
from ..hardware.demultiplexer import DirectDemultiplexer

__all__ += ["GlasgowAppletTestCase", "synthesis_test", "applet_simulation_test",
            "applet_hardware_test"]


class MockRecorder:
    def __init__(self, case, mocked, fixture):
        self.__case    = case
        self.__mocked  = mocked
        self.__fixture = fixture

    @staticmethod
    def __dump_object(obj):
        if isinstance(obj, bytes):
            return {"__class__": "bytes", "hex": obj.hex()}
        if isinstance(obj, bytearray):
            return {"__class__": "bytearray", "hex": obj.hex()}
        if isinstance(obj, memoryview):
            return {"__class__": "memoryview", "hex": obj.hex()}
        raise TypeError("%s is not serializable" % type(obj))

    def __dump_stanza(self, stanza):
        if not self.__case._recording:
            return
        json.dump(fp=self.__fixture, default=self.__dump_object, obj=stanza)
        self.__fixture.write("\n")

    def __dump_method(self, call, kind, args, kwargs, result):
        self.__dump_stanza({
            "call":   call,
            "kind":   kind,
            "args":   args,
            "kwargs": kwargs,
            "result": result
        })

    def __getattr__(self, attr):
        mocked = getattr(self.__mocked, attr)
        if inspect.ismethod(mocked):
            def wrapper(*args, **kwargs):
                result = mocked(*args, **kwargs)
                if isinstance(result, AbstractAsyncContextManager):
                    @asynccontextmanager
                    async def cmgr_wrapper():
                        value = await result.__aenter__()
                        self.__dump_method(attr, "asynccontext.enter", (), {}, value)
                        try:
                            yield value
                        finally:
                            exc_type, exc_value, traceback = sys.exc_info()
                            self.__dump_method(attr, "asynccontext.exit", (exc_value,), {}, None)
                            await result.__aexit__(exc_type, exc_value, traceback)
                    return cmgr_wrapper()
                elif inspect.isawaitable(result):
                    async def coro_wrapper():
                        coro_result = await result
                        self.__dump_method(attr, "asyncmethod", args, kwargs, coro_result)
                        return coro_result
                    return coro_wrapper()
                else:
                    self.__dump_method(attr, "method", args, kwargs, result)
                    return result
            return wrapper

        return mocked


class MockReplayer:
    def __init__(self, case, fixture):
        self.__case    = case
        self.__fixture = fixture

    @staticmethod
    def __load_object(obj):
        if "__class__" not in obj:
            return obj
        if obj["__class__"] == "bytes":
            return bytes.fromhex(obj["hex"])
        if obj["__class__"] == "bytearray":
            return bytearray.fromhex(obj["hex"])
        if obj["__class__"] == "memoryview":
            return memoryview(bytes.fromhex(obj["hex"]))
        assert False

    def __load(self):
        json_str = self.__fixture.readline()
        return json.loads(s=json_str, object_hook=self.__load_object)

    @staticmethod
    def __upgrade(stanza):
        """Upgrade an object to the latest schema."""
        if "method" in stanza:
            stanza["call"] = stanza.pop("method")
            if stanza.pop("async"):
                stanza["kind"] = "asyncmethod"
            else:
                stanza["kind"] = "method"
        return stanza

    def __getattr__(self, attr):
        stanza = self.__upgrade(self.__load())
        self.__case.assertEqual(attr, stanza["call"])
        if stanza["kind"] == "asynccontext.enter":
            @asynccontextmanager
            async def mock():
                assert () == tuple(stanza["args"])
                assert {} == stanza["kwargs"]
                try:
                    yield stanza["result"]
                finally:
                    exc_type, exc_value, traceback = sys.exc_info()
                    exit_stanza = self.__load()
                    self.__case.assertEqual(attr, exit_stanza["call"])
                    self.__case.assertEqual("asynccontext.exit", exit_stanza["kind"])
                    self.__case.assertEqual((exc_value,), tuple(exit_stanza["args"]))
                    assert {} == exit_stanza["kwargs"]
                    assert None == exit_stanza["result"]
        elif stanza["kind"] == "asyncmethod":
            async def mock(*args, **kwargs):
                self.__case.assertEqual(args, tuple(stanza["args"]))
                self.__case.assertEqual(kwargs, stanza["kwargs"])
                return stanza["result"]
        elif stanza["kind"] == "method":
            def mock(*args, **kwargs):
                self.__case.assertEqual(args, tuple(stanza["args"]))
                self.__case.assertEqual(kwargs, stanza["kwargs"])
                return stanza["result"]
        else:
            assert False, f"unknown stanza {stanza['kind']}"
        return mock


class GlasgowAppletTestCase(unittest.TestCase):
    def __init_subclass__(cls, applet, **kwargs):
        super().__init_subclass__(**kwargs)

        cls.applet_cls  = applet

    def setUp(self):
        self.applet = self.applet_cls()

    def assertBuilds(self, access="direct", args=[]):
        if access == "direct":
            target = GlasgowHardwareTarget(revision=self.applet_cls.required_revision,
                                           multiplexer_cls=DirectMultiplexer)
            access_args = GlasgowAppletArguments("applet", "AB", 16)
        else:
            raise NotImplementedError

        parser = argparse.ArgumentParser()
        self.applet.add_build_arguments(parser, access_args)

        try:
            parsed_args = parser.parse_args(args)
        except SystemExit:
            raise AssertionError("argument parsing failed") from None
        self.applet.build(target, parsed_args)

        target.build_plan().get_bitstream()

    def _prepare_applet_args(self, args, access_args, interact=False):
        parser = argparse.ArgumentParser()
        self.applet.add_build_arguments(parser, access_args)
        self.applet.add_run_arguments(parser, access_args)
        if interact:
            self.applet.add_interact_arguments(parser)
        self._parsed_args = parser.parse_args(args)

    def _prepare_simulation_target(self):
        self.target = GlasgowSimulationTarget(multiplexer_cls=SimulationMultiplexer)

        self.device = GlasgowSimulationDevice(self.target)
        self.device.demultiplexer = SimulationDemultiplexer(self.device)

    def build_simulated_applet(self):
        self.applet.build(self.target, self._parsed_args)

    async def run_simulated_applet(self):
        return await self.applet.run(self.device, self._parsed_args)

    def _prepare_hardware_target(self, case, fixture, mode):
        assert mode in ("record", "replay")

        if mode == "record":
            self.device = None # in case the next line raises
            self.device = GlasgowDevice() # GlasgowHardwareDevice()
            self.device.demultiplexer = DirectDemultiplexer(self.device, pipe_count=1)
            revision = self.device.revision
        else:
            self.device = None
            revision = "A0"

        self.target = GlasgowHardwareTarget(revision=revision,
                                            multiplexer_cls=DirectMultiplexer)
        self.applet.build(self.target, self._parsed_args)

        self._recording = False
        self._recorders = []

        old_run_lower = self.applet.run_lower

        async def run_lower(cls, device, args):
            if mode == "record":
                lower_iface = await old_run_lower(cls, device, args)
                recorder = MockRecorder(case, lower_iface, fixture)
                self._recorders.append(recorder)
                return recorder

            if mode == "replay":
                return MockReplayer(case, fixture)

        self.applet.run_lower = run_lower

    async def run_hardware_applet(self, mode):
        if mode == "record":
            await self.device.download_target(self.target.build_plan())
        else:
            # avoid UnusedElaboratable warning
            Fragment.get(self.target, GlasgowRevABPlatform())

        return await self.applet.run(self.device, self._parsed_args)


def synthesis_test(case):
    synthesis_available = find_toolchain(quiet=True) is not None
    return unittest.skipUnless(synthesis_available, "synthesis not available")(case)


def applet_simulation_test(setup, args=[]):
    def decorator(case):
        @functools.wraps(case)
        def wrapper(self):
            access_args = GlasgowAppletArguments("applet", "AB", 16)
            self._prepare_applet_args(args, access_args)
            self._prepare_simulation_target()

            getattr(self, setup)()
            @types.coroutine
            def run():
                yield from case(self)

            sim = Simulator(self.target)
            sim.add_clock(1e-9)
            sim.add_sync_process(run)
            vcd_name = f"{case.__name__}.vcd"
            with sim.write_vcd(vcd_name):
                sim.run()
            os.remove(vcd_name)

        return wrapper

    return decorator


def applet_hardware_test(setup="run_hardware_applet", args=[]):
    def decorator(case):
        @functools.wraps(case)
        def wrapper(self):
            fixture_path = os.path.join(os.path.dirname(case.__code__.co_filename), "fixtures",
                                        case.__name__ + ".json")
            os.makedirs(os.path.dirname(fixture_path), exist_ok=True)
            if os.path.exists(fixture_path):
                fixture = open(fixture_path)
                mode = "replay"
            else:
                fixture = open(fixture_path, "w")
                mode = "record"

            try:
                access_args = GlasgowAppletArguments(self.applet, default_port="AB", pin_count=16)
                self._prepare_applet_args(args, access_args)
                self._prepare_hardware_target(self, fixture, mode)

                exception = None
                def run_test():
                    try:
                        loop = asyncio.new_event_loop()
                        iface = loop.run_until_complete(getattr(self, setup)(mode))

                        self._recording = True
                        loop.run_until_complete(case(self, iface))

                    except Exception as e:
                        nonlocal exception
                        exception = e

                    finally:
                        if self.device is not None:
                            loop.run_until_complete(self.device.demultiplexer.cancel())
                        loop.close()

                thread = threading.Thread(target=run_test)
                thread.start()
                thread.join()
                if exception is not None:
                    raise exception

            except:
                if mode == "record":
                    os.remove(fixture_path)
                raise

            finally:
                if mode == "record":
                    if self.device is not None:
                        self.device.close()
                fixture.close()

        return wrapper

    return decorator
    