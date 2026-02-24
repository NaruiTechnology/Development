from typing import Optional, BinaryIO
import os,time
import logging
import hashlib
import pathlib
import tempfile
import shutil
import subprocess
from pathlib import Path


import platformdirs
from amaranth.build.run import BuildPlan

from .toolchain import Toolchain
from .buildScript import BuildScriptUtil


__all__ = ["GlasgowBuildPlan"]


logger = logging.getLogger(__name__)


class GatewareBuildError(Exception):
    pass


class GlasgowBuildPlan:
    def __init__(self, inner: BuildPlan, toolchain: Toolchain):       
        # Always wrap in our adapter
        self._inner = ToolchainBuildPlan(inner)
        self._toolchain = toolchain
        self._bitstream_id = self._generate_identifier()
        self.project_path = Path.cwd() # self._detect_project_path()
        self._buildDir = self._inner._buildDir

    @property
    def buildDir(self):
        return self._buildDir
    
    def _generate_identifier(self) -> bytes:
        import sys
        """Generate a stable identifier for the build configuration.
            Combines:
            - Toolchain fingerprint
            - Build plan digest (if available)
            - Timestamp for temporal uniqueness
            - System architecture
        """
        hasher = hashlib.blake2s()

        # 1. Include toolchain identification
        if hasattr(self._toolchain, 'identifier'):
            toolchain_id = self._toolchain.identifier
            if toolchain_id is not None:
                hasher.update(toolchain_id)
        
        # 2. Include build plan contents if available
        if hasattr(self._inner, 'digest'):
            hasher.update(self._inner.digest())
        elif hasattr(self._inner, 'files'):
            # Create digest from file contents
            file_hasher = hashlib.blake2s()
            for filename, content in sorted(self._inner.files.items()):
                file_hasher.update(filename.encode())
                file_hasher.update(content if isinstance(content, bytes) else content.encode())
            hasher.update(file_hasher.digest())
        
        # 3. System and temporal factors
        hasher.update(str(time.time_ns()).encode())  # Temporal uniqueness
        hasher.update(sys.platform.encode())         # OS/architecture
        hasher.update(os.uname().version.encode())   # Kernel version if available
        
        # 4. Python environment
        hasher.update(sys.version.encode())
        hasher.update(sys.executable.encode())
        
        # Return first 16 bytes of the hash
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
    def get_build_dir():
        return tempfile.mkdtemp(prefix="glasgow_")
    
    def execute(self, build_dir=None, *, debug=False):
        """Execute the build process"""
        if build_dir is None:
            build_dir = GlasgowBuildPlan.get_build_dir() 
        
        try:

            files = self._inner.build_files
            
            # Write files
            for filename, content in files.items():
                path = pathlib.Path(build_dir) / filename
                with open(path, 'w') as f:
                    f.write(content)
                if filename.endswith('.sh'):
                    path.chmod(0o755)

            # Run build
            proc = subprocess.run(
                ["./build.sh"],
                cwd=build_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True
            )

            # print(proc.stdout)  
            
            if proc.returncode != 0:
                print("--- FULL BUILD LOG ---")
                print(proc.stdout)  # This will show the exact error from Yosys or nextpnr
                raise GatewareBuildError(
                    f"Build failed (code {proc.returncode}):\n"
                    f"{proc.stdout[-500:]}")
            
            # Verify output
            bitstream = pathlib.Path(build_dir) / "top.bin"
            if not bitstream.exists():
                raise GatewareBuildError("Bitstream not generated")
            
            return bitstream.read_bytes(), proc.stdout
        except Exception as e:
            print(str(e))
        finally:
            if not debug:
                shutil.rmtree(build_dir, ignore_errors=True)
    
    def check_toolchain():
        """Add this to your setup"""
        required_tools = {
            'yosys': ['--version', 'Yosys'],
            'nextpnr-ice40': ['--version', 'nextpnr-ice40'],
            'icepack': ['--version', 'icepack']
        }
        
        missing = []
        for cmd, check in required_tools.items():
            try:
                result = subprocess.run([cmd, check[0]], 
                                    capture_output=True, text=True)
                if check[1] not in result.stdout:
                    missing.append(f"{cmd} (wrong version)")
            except FileNotFoundError:
                missing.append(cmd)
        
        if missing:
            raise GatewareBuildError(
                f"Missing required tools: {', '.join(missing)}\n"
                "On Ubuntu/Debian try:\n"
                "  sudo apt install yosys nextpnr-ice40")        

    async def get_bitstream(self, *, debug=False) -> bytes:
        # locate the caches in the platform-appropriate cache directory; bitstreams aren't large,
        # but it is good etiquette to indicate to the OS that they can be wiped without concern
        cache_path = platformdirs.user_cache_path("GlasgowEmbedded", appauthor=False)
        bitstream_filename = cache_path / "bitstreams" / self.bitstream_id.hex()
        stdout_filename = bitstream_filename.with_suffix(".output")
        # ensure that the cache and the build log (a) exist, (b) aren't corrupted; if anything goes
        # wrong at this stage, proceed as-if the cache was never there
        cache_exists = (bitstream_filename.exists() and stdout_filename.exists())
        if cache_exists:
            with bitstream_filename.open("rb") as bitstream_file:
                bitstream_hash = bitstream_file.read(hashlib.blake2s().digest_size)
                bitstream_data = bitstream_file.read()
                if hashlib.blake2s(bitstream_data).digest() != bitstream_hash:
                    cache_exists = False
            with stdout_filename.open("rb") as stdout_file:
                stdout_hash = stdout_file.read(hashlib.blake2s().digest_size * 2 + 1)
                stdout_data = stdout_file.read()
                if hashlib.blake2s(stdout_data).hexdigest().encode() != stdout_hash.rstrip():
                    cache_exists = False
        if cache_exists:
            # the cache exists; skip building the bitstream, and reproduce the stdout to our log
            # if anyone would actually see it
            logger.debug(f"bitstream ID {self.bitstream_id.hex()} is cached")
            logger.info(f"bitstream was read from {str(bitstream_filename)!r}")
            if logger.isEnabledFor(logging.DEBUG):
                for stdout_line in stdout_data.decode().splitlines():
                    logger.info(f"build: %s", stdout_line)
        else:
            # the cache does not exist; build it (`execute` directs the stdout to our log, so we
            # don't have to forward it here) and write the artifacts to the platform-appropriate
            # cache directory
            logger.debug(f"bitstream ID {self.bitstream_id.hex()} is not cached, executing build")
            bitstream_data, stdout_data = self.execute(debug=debug) # TODO
            if bitstream_data:
                bitstream_hash = hashlib.blake2s(bitstream_data).digest()
                # stdout_hash = hashlib.blake2s(stdout_data).hexdigest().encode()
                stdout_hash = hashlib.blake2s(stdout_data.encode('utf-8')).hexdigest()
                bitstream_filename.parent.mkdir(parents=True, exist_ok=True)
                with bitstream_filename.open("wb") as bitstream_file:
                    bitstream_file.write(bitstream_hash)
                    bitstream_file.write(bitstream_data)
                with stdout_filename.open("wb") as stdout_file:
                    stdout_file.write(stdout_hash.encode('utf-8') + b"\n") # keep it a text file
                    stdout_file.write(stdout_data.encode('utf-8'))
                logger.info(f"bitstream was written to {str(bitstream_filename)!r}")
            # finally, we have a bitstream! and chances are, we have obtained it much faster than we
        # would have otherwise.
        return bitstream_data

    
class ToolchainBuildPlan:
    """Complete adapter that handles both BuildPlan and Toolchain cases"""
    def __init__(self, inner):
        self._inner = inner
        self.script = "build"
        
        # Handle different inner types
        if hasattr(inner, 'files'):
            self.files = inner.files
        else:
            self._buildDir = build_dir = GlasgowBuildPlan.get_build_dir()
            self.files = BuildScriptUtil.prepare_build_environment(build_dir) #_prepare_build_files(buld_dir)
            
    @property
    def build_files(self):
        return self.files
            
    @property
    def env_vars(self):
        """Get environment variables from either Toolchain or use empty dict"""
        if hasattr(self._inner, 'env_vars'):
            return self._inner.env_vars
        elif hasattr(self._inner, 'toolchain') and hasattr(self._inner.toolchain, 'env_vars'):
            return self._inner.toolchain.env_vars
        return {}

    def extract(self, build_dir):
        """Standard extract implementation"""
        os.makedirs(build_dir, exist_ok=True)
        for filename, content in self.files.items():
            file_path = os.path.join(build_dir, filename)
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            
            mode = 'wb' if isinstance(content, bytes) else 'w'
            with open(file_path, mode) as f:
                f.write(content)
            
            if filename.endswith('.sh'):
                os.chmod(file_path, 0o755)

    def archive(self, file):
        """Delegate to inner archive if available"""
        if hasattr(self._inner, 'archive'):
            return self._inner.archive(file)
        raise NotImplementedError("Archive not available")