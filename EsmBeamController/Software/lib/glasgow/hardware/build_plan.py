from typing import Optional, BinaryIO
import os,time
import logging
import hashlib
import pathlib
import tempfile
import shutil
import subprocess

import platformdirs
from amaranth.build.run import BuildPlan

from .toolchain import Toolchain


__all__ = ["GlasgowBuildPlan"]


logger = logging.getLogger(__name__)


class GatewareBuildError(Exception):
    pass


class GlasgowBuildPlan:
    def __init__(self, inner: BuildPlan, toolchain: Toolchain):
        # self._inner     = inner
        # self._toolchain = toolchain

        # hasher = hashlib.blake2s()
        # hasher.update(self._inner.digest())
        # hasher.update(self._toolchain.identifier)
        # self._bitstream_id = hasher.digest()[:16]
        
        # # Wrap Toolchain in adapter if needed
        # if isinstance(inner, Toolchain):
        #     self._inner = ToolchainBuildPlan(inner)
        # else:
        #     self._inner = inner
        
        # Always wrap in our adapter
        self._inner = ToolchainBuildPlan(inner)
        self._toolchain = toolchain
        self._bitstream_id = self._generate_identifier()


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

    # this function is only public for paranoid people who don't trust our excellent cache system.
    # it's very unlikely to fail, but people are rightfully distrustful of cache systems, so
    # be sympathetic to that.
    def execute(self, build_dir: Optional[os.PathLike] = None, *,
                debug = False) -> tuple[bytes, str]:
        data = None
        if build_dir is None:
            build_dir = tempfile.mkdtemp(prefix="glasgow_")
        try:
            # Extract build files
            self._inner.extract(build_dir)
            
            # Get environment variables safely
            environ = os.environ.copy()
            environ.update(self._inner.env_vars)
            
            with open(os.path.join(build_dir, 'build_env.log'), 'w') as f:
                f.write("=== Environment Variables ===\n")
                for k, v in environ.items():
                    f.write(f"{k}={v}\n")
                
            if os.name == 'nt':
                args = ["cmd", "/c", f"call {self._inner.script}.bat"]
                # Ensure critical Windows vars are preserved
                for var in ("SYSTEMROOT", "PROCESSOR_ARCHITECTURE"):
                    if var in os.environ:
                        environ[var] = os.environ[var]
            else:
                args = ["sh", f"{self._inner.script}.sh"]

            stdout_lines = []
            with subprocess.Popen(
                    args, cwd=build_dir, env=environ, 
                    stdout=subprocess.PIPE, 
                    stderr=subprocess.PIPE,  # Capture stderr separately
                    text=True) as proc:
                
                # Live output processing
                while True:
                    stdout_line = proc.stdout.readline()
                    stderr_line = proc.stderr.readline()
                    
                    if not stdout_line and not stderr_line and proc.poll() is not None:
                        break
                    
                    if stdout_line:
                        stdout_lines.append(stdout_line)
                        logger.debug(f"stdout: {stdout_line.strip()}")
                    if stderr_line:
                        stdout_lines.append(stderr_line)  # Include in main output
                        logger.error(f"stderr: {stderr_line.strip()}")

                return_code = proc.wait()
                
                # Write full output to file
                with open(os.path.join(build_dir, 'build_output.log'), 'w') as f:
                    f.writelines(stdout_lines)

                if return_code != 0:
                    logger.error(f"Build failed with return code {return_code}")
                    logger.error(f"Working directory: {build_dir}")
                    logger.error("Full environment and output saved in build directory")
                    
                    # Include the last 10 lines of output in the exception
                    last_lines = "\n".join(stdout_lines[-10:]) if stdout_lines else "No output"
                    raise GatewareBuildError(
                        f"Build failed with code {return_code}\n"
                        f"Last output lines:\n{last_lines}\n"
                        f"See {build_dir} for complete logs")

                bitstream_path = os.path.join(build_dir, "top.bin")
                if not os.path.exists(bitstream_path):
                    raise GatewareBuildError("Bitstream file not generated")

                # return open(bitstream_path, 'rb').read(), "".join(stdout_lines) # TODO
                data = open(bitstream_path, 'rb').read(), "".join(stdout_lines)

        except Exception as e:
            if debug:
                logger.error(f"Build failed, preserving build directory: {build_dir}")
            else:
                shutil.rmtree(build_dir, ignore_errors=True)
            # raise # TODO ------------------------- TO fix build script
        return data, stdout_lines
    
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
                stdout_hash = hashlib.blake2s(stdout_data).hexdigest().encode()
                bitstream_filename.parent.mkdir(parents=True, exist_ok=True)
                with bitstream_filename.open("wb") as bitstream_file:
                    bitstream_file.write(bitstream_hash)
                    bitstream_file.write(bitstream_data)
                with stdout_filename.open("wb") as stdout_file:
                    stdout_file.write(stdout_hash + b"\n") # keep it a text file
                    stdout_file.write(stdout_data)
                logger.info(f"bitstream was written to {str(bitstream_filename)!r}")
            # finally, we have a bitstream! and chances are, we have obtained it much faster than we
        # would have otherwise.
        return bitstream_data


# class ToolchainBuildPlan:
#     """Adapter that makes a Toolchain behave like a BuildPlan for GlasgowBuildPlan"""
#     def __init__(self, toolchain):
#         self.toolchain = toolchain
#         self.script = "build"  # Default script name
#         self.files = self._prepare_build_files()

#     def _prepare_build_files(self):
#         """Generate minimal build files expected by the build system"""
#         return {
#             "build.sh": self._generate_build_script(),
#             "constraints.pcf": "# Placeholder constraints file",
#             "top.v": "// Placeholder Verilog file"
#         }

#     def _generate_build_script(self):
#         """Generate a build script that uses the toolchain"""
#         script = [
#             "#!/bin/sh",
#             "# Auto-generated build script",
#             f"# Using toolchain: {self.toolchain}",
#             "",
#             "# Tool commands:"
#         ]
        
#         # Add actual toolchain commands
#         for tool in self.toolchain.tools:
#             script.append(f"echo 'Using {tool.name}: {tool.command}'")
        
#         # Add placeholders for actual build steps
#         script.extend([
#             "",
#             "# Build steps would go here",
#             "echo 'Generating bitstream...'",
#             "touch top.bin  # Placeholder output"
#         ])
        
#         return "\n".join(script)

#     def extract(self, build_dir):
#         """Implement BuildPlan-like extract method"""
#         os.makedirs(build_dir, exist_ok=True)
#         for filename, content in self.files.items():
#             file_path = os.path.join(build_dir, filename)
#             os.makedirs(os.path.dirname(file_path), exist_ok=True)
            
#             mode = 'wb' if isinstance(content, bytes) else 'w'
#             with open(file_path, mode) as f:
#                 f.write(content)
            
#             if filename.endswith('.sh'):
#                 os.chmod(file_path, 0o755)

#     def archive(self, file):
#         """Implement BuildPlan-like archive method"""
#         raise NotImplementedError("Archive not implemented for ToolchainBuildPlan")
    
class ToolchainBuildPlan:
    """Complete adapter that handles both BuildPlan and Toolchain cases"""
    def __init__(self, inner):
        self._inner = inner
        self.script = "build"
        
        # Handle different inner types
        if hasattr(inner, 'files'):
            self.files = inner.files
        else:
            self.files = self._prepare_build_files()

    def _prepare_build_files(self):
        """Generate minimal build files when working with pure Toolchain"""
        return {
            "build.sh": self._generate_build_script(),
            "constraints.pcf": "# Placeholder constraints",
            "top.v": "// Generated top module"
        }

    # def _generate_build_script(self):
    #     """Generate appropriate build script based on available tools"""
    #     script = [
    #         "#!/bin/sh",
    #         "echo 'Running Glasgow build script'",
    #         "set -e"  # Exit on error
    #     ]
        
    #     # Add actual build commands if we can detect tools
    #     if hasattr(self._inner, 'tools'):
    #         script.extend([
    #             "yosys -p 'synth_ice40 -top top -json top.json' top.v",
    #             "nextpnr-ice40 --json top.json --pcf constraints.pcf --asc top.asc",
    #             "icepack top.asc top.bin"
    #         ])
        
    #     return "\n".join(script)
    def _generate_build_script(self):
        """Generate build script with hardcoded fallback path"""
        return r"""#!/bin/bash
                # Use bash for reliable pipefail support
                set -e  # Exit immediately on error

                # Find Ice40 primitives - direct path verified from your system
                PRIMITIVES_PATH="/usr/share/yosys/ice40/cells_sim.v"

                if [ ! -f "$PRIMITIVES_PATH" ]; then
                    echo "ERROR: Missing Ice40 primitives at $PRIMITIVES_PATH"
                    echo "On Ubuntu/Debian try: sudo apt install yosys-ice40"
                    exit 1
                fi

                # Synthesis
                yosys -l yosys.log -p "
                    read_verilog -lib $PRIMITIVES_PATH;
                    read_verilog top.v;
                    synth_ice40 -top top -json top.json
                " || {
                    echo "Yosys synthesis failed:"
                    cat yosys.log
                    exit 1
                }

                # Place and Route
                nextpnr-ice40 --json top.json --pcf constraints.pcf --asc top.asc || {
                    echo "Place and route failed"
                    exit 1
                }

                # Bitstream generation
                icepack top.asc top.bin || {
                    echo "Bitstream generation failed"
                    exit 1
                }

                echo "Build completed successfully"
                """
            
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