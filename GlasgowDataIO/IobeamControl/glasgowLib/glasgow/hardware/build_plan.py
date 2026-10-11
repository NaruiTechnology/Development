from typing import Optional, BinaryIO
import os, time
import logging
import hashlib
import pathlib
import tempfile
import shutil
import subprocess
import stat
from pathlib import Path

import platformdirs
from amaranth.build.run import BuildPlan

from .toolchain import Toolchain
# BuildScriptUtil is intentionally NOT imported here.
# All Verilog, PCF, and build scripts come exclusively from Amaranth's BuildPlan.files.

__all__ = ["GlasgowBuildPlan"]

logger = logging.getLogger(__name__)


class GatewareBuildError(Exception):
    pass


class GlasgowBuildPlan:
    def __init__(self, inner: BuildPlan, toolchain: Toolchain):
        self._inner = ToolchainBuildPlan(inner)
        self._toolchain = toolchain
        self._bitstream_id = self._generate_identifier()
        self.project_path = Path.cwd()
        # _buildDir is None until execute() is called with debug=True.
        # Normally the bitstream bytes are returned directly from get_bitstream()
        # and no on-disk path is needed by callers.
        self._buildDir = None

    @property
    def buildDir(self) -> Optional[Path]:
        """Path to the last build directory. Only set when execute(debug=True) was used."""
        return self._buildDir

    def _generate_identifier(self) -> bytes:
        import sys
        hasher = hashlib.blake2s()
        if hasattr(self._toolchain, 'identifier'):
            toolchain_id = self._toolchain.identifier
            if toolchain_id is not None:
                hasher.update(toolchain_id)
        # Digest from Amaranth file contents only — no timestamp, so the ID is
        # deterministic for identical HDL. download_target() uses this to skip
        # re-flashing when the design hasn't changed.
        file_hasher = hashlib.blake2s()
        for filename, content in sorted(self._inner.files.items()):
            file_hasher.update(filename.encode())
            file_hasher.update(content if isinstance(content, bytes) else content.encode())
        hasher.update(file_hasher.digest())
        hasher.update(sys.platform.encode())
        return hasher.digest()[:16]

    @property
    def rtlil(self) -> str:
        return self._inner.files["top.il"]

    def archive(self, file: os.PathLike | BinaryIO):
        self._inner.archive(file)

    @property
    def toolchain(self) -> Toolchain:
        return self._toolchain

    @property
    def bitstream_id(self) -> bytes:
        return self._bitstream_id

    @staticmethod
    def get_build_dir() -> str:
        return tempfile.mkdtemp(prefix="glasgow_")

    def execute(self, build_dir=None, *, debug=False):
        """
        Write Amaranth-generated files to build_dir, run the build script,
        and return (bitstream_bytes, stdout_text).

        If debug=True the directory is preserved after the build and
        plan.buildDir points to it, so you can inspect top.v, top.bin, etc.
        If debug=False (default) the directory is deleted after the build.

        Raises RuntimeError on build failure. Never silently swallows errors.
        """
        if build_dir is None:
            build_dir = GlasgowBuildPlan.get_build_dir()

        build_dir = Path(build_dir)
        build_dir.mkdir(parents=True, exist_ok=True)

        try:
            # Write every file that Amaranth generated (top.il, top.v, top.pcf,
            # the build shell script, etc.)  Nothing from BuildScriptUtil.
            for filename, content in self._inner.files.items():
                path = build_dir / filename
                path.parent.mkdir(parents=True, exist_ok=True)
                # Preserve Amaranth's UTF-8/LF output on Windows too. Text
                # mode translates LF to CRLF, which Yosys' RTLIL parser rejects.
                with open(path, 'wb') as f:
                    f.write(content if isinstance(content, bytes) else content.encode('utf-8'))
                # Make ANY shell script executable, regardless of extension.
                # Amaranth names its script "build" (no .sh) on Linux.
                if filename == self._inner.script or filename.endswith('.sh'):
                    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

            script_name = self._inner.script  # "build" from Amaranth iCE40 platform
            script_path = build_dir / script_name
            if not script_path.exists():
                raise GatewareBuildError(
                    f"Build script '{script_name}' not found in build directory. "
                    f"Files present: {sorted(self._inner.files.keys())}")

            logger.debug("Running build script '%s' in %s", script_name, build_dir)
            # The generated build script locates each tool (yosys, nextpnr-ice40,
            # icepack) via environment variables such as NEXTPNR_ICE40, which
            # ToolchainBuildPlan.env_vars exposes. Without passing them through,
            # the subprocess falls back to bare command names on PATH, which
            # breaks whenever a tool (e.g. the WASM/yowasp nextpnr-ice40) is only
            # reachable via its env var and not installed system-wide.
            build_env = dict(os.environ)
            build_env.update(self._inner.env_vars)
            # The selected Glasgow Toolchain is authoritative. Some Amaranth
            # BuildPlan versions expose fallback variables containing bare
            # executable names; allowing those to win makes a clean host fail
            # while a host with a cached bitstream appears healthy.
            build_env.update(self._toolchain.env_vars)
            command = ([os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", "call", ".\\" + script_name]
                       if os.name == "nt"
                       else ["sh", script_name])
            proc = subprocess.run(
                command,
                cwd=build_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=build_env,
            )

            if proc.returncode != 0:
                logger.error("--- FULL BUILD LOG ---\n%s", proc.stdout)
                raise GatewareBuildError(
                    f"Build failed (exit code {proc.returncode}):\n{proc.stdout[-2000:]}")

            bitstream_path = build_dir / "top.bin"
            if not bitstream_path.exists():
                raise GatewareBuildError(
                    "Build completed but top.bin was not produced. "
                    f"Build output:\n{proc.stdout[-1000:]}")

            bitstream_data = bitstream_path.read_bytes()
            logger.info(
                "Build succeeded: %d bytes, SHA256 prefix %s",
                len(bitstream_data),
                hashlib.sha256(bitstream_data).hexdigest()[:12])

            if debug:
                self._buildDir = build_dir
                logger.info("Build directory preserved at: %s", build_dir)

            return bitstream_data, proc.stdout

        except Exception:
            # Always clean up on failure even in debug mode to avoid disk leaks,
            # but only if it's not a debug run where the user wants to inspect.
            if not debug:
                shutil.rmtree(build_dir, ignore_errors=True)
            raise  # Never swallow — let the caller see the real error.

        finally:
            if not debug:
                shutil.rmtree(build_dir, ignore_errors=True)

    @staticmethod
    def check_toolchain():
        required_tools = {
            'yosys':         ['--version', 'Yosys'],
            'nextpnr-ice40': ['--version', 'nextpnr-ice40'],
            'icepack':       ['--version', 'icepack'],
        }
        missing = []
        for cmd, (flag, marker) in required_tools.items():
            try:
                result = subprocess.run([cmd, flag], capture_output=True, text=True)
                if marker not in result.stdout and marker not in result.stderr:
                    missing.append(f"{cmd} (unexpected version output)")
            except FileNotFoundError:
                missing.append(cmd)
        if missing:
            raise GatewareBuildError(
                f"Missing required tools: {', '.join(missing)}\n"
                "On Ubuntu/Debian: sudo apt install yosys nextpnr-ice40 fpga-icestorm")

    async def get_bitstream(self, *, debug=False) -> bytes:
        """
        Return the bitstream bytes, building if necessary and caching the result.
        The cache key is plan.bitstream_id, which is a hash of the HDL source files.
        Pass debug=True to preserve the build directory (accessible via plan.buildDir).
        """
        cache_path = platformdirs.user_cache_path("GlasgowEmbedded", appauthor=False)
        bitstream_filename = cache_path / "bitstreams" / self.bitstream_id.hex()
        stdout_filename = bitstream_filename.with_suffix(".output")

        cache_exists = bitstream_filename.exists() and stdout_filename.exists()
        if cache_exists:
            with bitstream_filename.open("rb") as f:
                stored_hash = f.read(hashlib.blake2s().digest_size)
                bitstream_data = f.read()
            if hashlib.blake2s(bitstream_data).digest() != stored_hash:
                logger.warning("Cached bitstream hash mismatch — rebuilding")
                cache_exists = False

        if cache_exists:
            logger.info("bitstream ID %s read from cache at %r",
                        self.bitstream_id.hex(), str(bitstream_filename))
            return bitstream_data

        logger.debug("bitstream ID %s not cached — building", self.bitstream_id.hex())
        bitstream_data, stdout_text = self.execute(debug=debug)

        bitstream_filename.parent.mkdir(parents=True, exist_ok=True)
        stored_hash = hashlib.blake2s(bitstream_data).digest()
        with bitstream_filename.open("wb") as f:
            f.write(stored_hash)
            f.write(bitstream_data)
        with stdout_filename.open("w", encoding="utf-8") as f:
            f.write(stdout_text)
        logger.info("bitstream written to cache at %r", str(bitstream_filename))

        return bitstream_data


class ToolchainBuildPlan:
    """
    Thin wrapper around Amaranth's BuildPlan that exposes the file dict
    and script name needed by GlasgowBuildPlan.execute().

    IMPORTANT: this class must ONLY use files from the Amaranth BuildPlan.
    Do not fall back to BuildScriptUtil — that produces a toy Verilog that
    has no Glasgow register slave and will cause every REQ_REGISTER call to
    time out.
    """
    def __init__(self, inner: BuildPlan):
        self._inner = inner

        if not hasattr(inner, 'files') or not inner.files:
            raise GatewareBuildError(
                "Amaranth BuildPlan has no files. "
                "Ensure target.build_plan() returns a fully elaborated plan before "
                "passing it to GlasgowBuildPlan.")

        self.files = inner.files
        # Amaranth sets BuildPlan.script to "build" for iCE40 (no .sh extension on Linux).
        #-- self.script = getattr(inner, 'script', 'build')
        # Amaranth's BuildPlan.script gives the stem ("build_top"), but on Linux
        # the actual file written is "build_top.sh".  Resolve to whichever variant
        # is present in the file dict, preferring the bare name for back-compat.
        raw_script = getattr(inner, 'script', 'build_top')
        if os.name == "nt":
            windows_script = raw_script if raw_script.endswith('.bat') else raw_script + '.bat'
            if windows_script not in self.files:
                raise GatewareBuildError(
                    f"Windows build script '{windows_script}' is missing. "
                    f"Files present: {sorted(self.files.keys())}")
            self.script = windows_script
        elif raw_script in self.files:
            self.script = raw_script
        elif raw_script + ".sh" in self.files:
            self.script = raw_script + ".sh"
        else:
            # Last resort: pick any .sh file in the plan
            sh_files = [f for f in self.files if f.endswith('.sh')]
            if sh_files:
                self.script = sh_files[0]
            else:
                raise GatewareBuildError(
                    f"Cannot find build script (tried '{raw_script}', '{raw_script}.sh'). "
                    f"Files present: {sorted(self.files.keys())}")

    @property
    def build_files(self):
        return self.files

    @property
    def env_vars(self):
        if hasattr(self._inner, 'env_vars'):
            return self._inner.env_vars
        if hasattr(self._inner, 'toolchain') and hasattr(self._inner.toolchain, 'env_vars'):
            return self._inner.toolchain.env_vars
        return {}

    def extract(self, build_dir):
        os.makedirs(build_dir, exist_ok=True)
        for filename, content in self.files.items():
            file_path = Path(build_dir) / filename
            file_path.parent.mkdir(parents=True, exist_ok=True)
            with open(file_path, 'wb') as f:
                f.write(content if isinstance(content, bytes) else content.encode('utf-8'))
            if filename == self.script or filename.endswith('.sh'):
                file_path.chmod(file_path.stat().st_mode | stat.S_IEXEC)

    def archive(self, file):
        if hasattr(self._inner, 'archive'):
            return self._inner.archive(file)
        raise NotImplementedError("Archive not available")
