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
from .buildScript import BuildScriptUtil


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
        self.project_path = BuildScriptUtil._detect_project_path()

    # def _detect_project_path(self):
    #     """Dynamically detect the project root path"""
    #     # Try to find the project root by looking for common markers
    #     search_paths = [
    #         Path.cwd(),  # Current working directory
    #         Path(__file__).absolute().parent.parent,  # 2 levels up from this file
    #         Path.home() / "Projects" / "NaruiTech" / "EsmBeamController",  # Fallback
    #     ]
        
    #     for path in search_paths:
    #         # Check for common project markers
    #         if (path / "constraints").exists() or (path / "src").exists():
    #             return path
    #         if (path / "Makefile").exists() or (path / "README.md").exists():
    #             return path
        
    #     # Default to current directory if nothing found
    #     return Path.cwd()

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
    # def execute(self, build_dir: Optional[os.PathLike] = None, *,
    #             debug = False) -> tuple[bytes, str]:
    #     data = None
    #     if build_dir is None:
    #         build_dir = tempfile.mkdtemp(prefix="glasgow_")
    #     try:
    #         # Extract build files
    #         self._inner.extract(build_dir)
            
    #         # Get environment variables safely
    #         environ = os.environ.copy()
    #         environ.update(self._inner.env_vars)
            
    #         with open(os.path.join(build_dir, 'build_env.log'), 'w') as f:
    #             f.write("=== Environment Variables ===\n")
    #             for k, v in environ.items():
    #                 f.write(f"{k}={v}\n")
                
    #         if os.name == 'nt':
    #             args = ["cmd", "/c", f"call {self._inner.script}.bat"]
    #             # Ensure critical Windows vars are preserved
    #             for var in ("SYSTEMROOT", "PROCESSOR_ARCHITECTURE"):
    #                 if var in os.environ:
    #                     environ[var] = os.environ[var]
    #         else:
    #             args = ["sh", f"{self._inner.script}.sh"]

    #         stdout_lines = []
    #         with subprocess.Popen(
    #                 args, cwd=build_dir, env=environ, 
    #                 stdout=subprocess.PIPE, 
    #                 stderr=subprocess.PIPE,  # Capture stderr separately
    #                 text=True) as proc:
                
    #             # Live output processing
    #             while True:
    #                 stdout_line = proc.stdout.readline()
    #                 stderr_line = proc.stderr.readline()
                    
    #                 if not stdout_line and not stderr_line and proc.poll() is not None:
    #                     break
                    
    #                 if stdout_line:
    #                     stdout_lines.append(stdout_line)
    #                     logger.debug(f"stdout: {stdout_line.strip()}")
    #                 if stderr_line:
    #                     stdout_lines.append(stderr_line)  # Include in main output
    #                     logger.error(f"stderr: {stderr_line.strip()}")

    #             return_code = proc.wait()
                
    #             # Write full output to file
    #             with open(os.path.join(build_dir, 'build_output.log'), 'w') as f:
    #                 f.writelines(stdout_lines)

    #             if return_code != 0:
    #                 logger.error(f"Build failed with return code {return_code}")
    #                 logger.error(f"Working directory: {build_dir}")
    #                 logger.error("Full environment and output saved in build directory")
                    
    #                 # Include the last 10 lines of output in the exception
    #                 last_lines = "\n".join(stdout_lines[-10:]) if stdout_lines else "No output"
    #                 raise GatewareBuildError(
    #                     f"Build failed with code {return_code}\n"
    #                     f"Last output lines:\n{last_lines}\n"
    #                     f"See {build_dir} for complete logs")

    #             bitstream_path = os.path.join(build_dir, "top.bin")
    #             if not os.path.exists(bitstream_path):
    #                 raise GatewareBuildError("Bitstream file not generated")

    #             # return open(bitstream_path, 'rb').read(), "".join(stdout_lines) # TODO
    #             data = open(bitstream_path, 'rb').read(), "".join(stdout_lines)

    #     except Exception as e:
    #         if debug:
    #             logger.error(f"Build failed, preserving build directory: {build_dir}")
    #         else:
    #             shutil.rmtree(build_dir, ignore_errors=True)
    #         # raise # TODO ------------------------- TO fix build script
    #     return data, stdout_lines
    # def execute(self, build_dir=None, *, debug=False):
    #     """Execute the build process"""
    #     if build_dir is None:
    #         build_dir = tempfile.mkdtemp(prefix="glasgow_")
        
    #     try:
    #         # Prepare build files
    #         files = BuildScriptUtil._prepare_build_files()
    #         for filename, content in files.items():
    #             path = os.path.join(build_dir, filename)
    #             with open(path, 'w') as f:
    #                 f.write(content)
    #             if filename.endswith('.sh'):
    #                 os.chmod(path, 0o755)

    #         # Run build
    #         proc = subprocess.run(
    #             ["./build.sh"],
    #             cwd=build_dir,
    #             stdout=subprocess.PIPE,
    #             stderr=subprocess.STDOUT,
    #             text=True
    #         )
            
    #         if proc.returncode != 0:
    #             raise GatewareBuildError(
    #                 f"Build failed (code {proc.returncode}):\n"
    #                 f"{proc.stdout[-500:]}")
            
    #         # Verify output
    #         bitstream = os.path.join(build_dir, "top.bin")
    #         if not os.path.exists(bitstream):
    #             raise GatewareBuildError("Bitstream not generated")
            
    #         return open(bitstream, 'rb').read(), proc.stdout
    #     finally:
    #         if not debug:
    #             shutil.rmtree(build_dir, ignore_errors=True)
    
    def execute(self, build_dir=None, *, debug=False):
        """Execute the build process"""
        if build_dir is None:
            build_dir = tempfile.mkdtemp(prefix="glasgow_")
        
        try:
            # Prepare build files
            files = {
                "top.v": BuildScriptUtil._generate_top_verilog(),
                "constraints.pcf": BuildScriptUtil._generate_constraints(),
                "build.sh": BuildScriptUtil._generate_build_script()
            }
            
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

            data = None
            suppressBuildError = True #----------------!!!!!! TODO -------------------------
            if suppressBuildError:
                return data, proc.stdout

            if proc.returncode != 0:
                raise GatewareBuildError(
                    f"Build failed (code {proc.returncode}):\n"
                    f"{proc.stdout[-500:]}")
            
            # Verify output
            bitstream = pathlib.Path(build_dir) / "top.bin"
            if not bitstream.exists():
                raise GatewareBuildError("Bitstream not generated")
            
            return bitstream.read_bytes(), proc.stdout
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

    
class ToolchainBuildPlan:
    """Complete adapter that handles both BuildPlan and Toolchain cases"""
    def __init__(self, inner):
        self._inner = inner
        self.script = "build"
        
        # Handle different inner types
        if hasattr(inner, 'files'):
            self.files = inner.files
        else:
            try:
                self.files = BuildScriptUtil._prepare_build_files()
            except Exception as e:
                print(str(e))

    # # def _prepare_build_files(self):
    # #     """Generate minimal build files when working with pure Toolchain"""
    # #     return {
    # #         "build.sh": self._generate_build_script(),
    # #         "constraints.pcf": "# Placeholder constraints",
    # #         "top.v": "// Generated top module"
    # #     }
    # def _prepare_build_files(self):
    #     """Generate complete build files including proper top.v template"""
    #     return {
    #         "build.sh": self._generate_build_script(),
    #         "constraints.pcf": self._generate_constraints(),
    #         "top.v": self._generate_top_verilog()
    #     }

    # def _generate_top_verilog(self):
    #     """Generate foolproof top.v with strict Verilog-2005 syntax"""
    #     return """// Auto-generated top module with explicit ports
    #             module top (
    #                 // Basic clock and reset
    #                 input  wire clk,
    #                 input  wire reset_n,
                    
    #                 // Example 8-bit LED output
    #                 output reg [7:0] leds
    #             );
    #                 // Simple heartbeat counter
    #                 reg [23:0] counter;
                    
    #                 always @(posedge clk or negedge reset_n) begin
    #                     if (!reset_n) begin
    #                         counter <= 0;
    #                         leds <= 8'h01;
    #                     end else begin
    #                         counter <= counter + 1;
    #                         if (counter == 0)
    #                             leds <= {leds[6:0], leds[7]};
    #                     end
    #                 end
    #             endmodule
    #             """

    # # def _generate_constraints(self):
    # #     """Generate constraints with auto-detected or safe default pins"""
    # #     # Try to auto-detect board type
    # #     BOARD_PINOUTS = {
    # #         # iCE40-UP5K on common boards
    # #         "ice40up5k-breakout": {
    # #             "clk": "44",   # Actual pin on common breakout boards
    # #             "leds": ["40", "41", "39", "42", "38", "43", "37", "44"]
    # #         },
    # #         # Fallback safe pins (LEDs only)
    # #         "safe-default": {
    # #             "clk": None,  # Must be explicitly set
    # #             "leds": ["41", "40", "39", "38", "37", "36", "42", "43"]
    # #         }
    # #     }

    # #     # Try to detect board
    # #     board_type = self._detect_board()
    # #     pins = BOARD_PINOUTS.get(board_type, BOARD_PINOUTS["safe-default"])

    # #     # Generate constraints with validation
    # #     constraints = []
    # #     if pins["clk"]:
    # #         constraints.append(f"set_io clk {pins['clk']}  # Clock")
        
    # #     for i, pin in enumerate(pins["leds"]):
    # #         constraints.append(f"set_io leds[{i}] {pin}  # LED {i}")
        
    # #     return "\n".join(constraints)
    
    # # def _generate_constraints(self):
    # #     """Generate constraints using pin names instead of numbers"""
    # #     # For iCE40 UP5K-SG48 package (common on Glasgow)
    # #     return """
    # #             # Clock
    # #             set_io clk F5

    # #             # LEDs - using pin names for SG48 package
    # #             set_io leds[0] F1
    # #             set_io leds[1] F2
    # #             set_io leds[2] F3
    # #             set_io leds[3] F4
    # #             set_io leds[4] E1
    # #             set_io leds[5] E2
    # #             set_io leds[6] E3
    # #             set_io leds[7] E4

    # #             # Alternative minimal working example:
    # #             # set_io leds[0] F1  # Single LED should always work
    # #             """
    # # def _generate_constraints(self):
    # #     """Guaranteed-working minimal constraints"""
    # #     return """
    # #         # These pins exist on ALL iCE40 devices
    # #         set_io clk 21
    # #         set_io leds[0] 25
    # #         """
    # def _generate_constraints(self):
    #     """Generate guaranteed-working constraints for iCE40 UP5K"""
    #     # Ultra-reliable minimal constraints
    #     return """
    #         # Minimal working constraints for iCE40 UP5K
    #         # Using only verified pins that exist in all packages
    #         set_io clk 21    # Universal clock pin
    #         set_io leds[0] 25 # Universal GPIO pin
    #         # Remove other constraints for now
    #         """    
            
    # def _detect_board(self):    
    #     """Try to identify the FPGA board"""
    #     # Check common board detection methods
    #     if self._check_pin_exists("44"):  # Common breakout pin
    #         return "ice40up5k-breakout"
    #     return "safe-default"

    # def _check_pin_exists(self, pin):
    #     """Verify if pin exists on the current board"""
    #     try:
    #         # Try to query pin (implementation varies by board)
    #         return subprocess.run(
    #             ["board_query", "--pin", pin],
    #             capture_output=True
    #         ).returncode == 0
    #     except:
    #         return False  # Fallback to safe defaults
        
    # # def _generate_build_script(self):
    # #     """Generate robust build script with syntax checking"""
    # #     return r"""#!/bin/bash
    # #             set -e

    # #             # First validate Verilog syntax
    # #             if ! yosys -qp "read_verilog -sv top.v; hierarchy -check" 2>/dev/null; then
    # #                 echo "ERROR: Verilog syntax validation failed"
    # #                 echo "Showing first 20 lines with line numbers:"
    # #                 cat -n top.v | head -20
    # #                 exit 1
    # #             fi

    # #             # Then run full synthesis
    # #             yosys -l yosys.log -p "
    # #                 read_verilog -lib /usr/share/yosys/ice40/cells_sim.v;
    # #                 read_verilog top.v;
    # #                 hierarchy -check -top top;
    # #                 synth_ice40 -top top -json top.json
    # #             " || {
    # #                 echo "=== Synthesis Failed ==="
    # #                 cat yosys.log | grep -A10 -B5 -i "error\\|warning"
    # #                 exit 1
    # #             }

    # #             # Continue with PnR and packing...
    # #             nextpnr-ice40 --json top.json --pcf constraints.pcf --asc top.asc
    # #             icepack top.asc top.bin
    # #             """
    # # def _generate_build_script(self):
    # #     """Generate build script with proper device specification"""
    # #     return r"""#!/bin/bash
    # #             set -e

    # #             # Synthesis
    # #             yosys -l yosys.log -p "
    # #                 read_verilog -lib /usr/share/yosys/ice40/cells_sim.v;
    # #                 read_verilog top.v;
    # #                 hierarchy -check -top top;
    # #                 synth_ice40 -top top -json top.json
    # #             " || {
    # #                 cat yosys.log
    # #                 exit 1
    # #             }

    # #             # Place and Route for iCE40 UP5K in SG48 package
    # #             nextpnr-ice40 \
    # #                 --up5k \
    # #                 --package sg48 \
    # #                 --json top.json \
    # #                 --pcf constraints.pcf \
    # #                 --asc top.asc || {
    # #                 echo "Place and route failed. Common issues:"
    # #                 echo "1. Wrong FPGA package specified"
    # #                 echo "2. Invalid pin names in constraints.pcf"
    # #                 echo "3. Clock constraints missing"
    # #                 cat constraints.pcf
    # #                 exit 1
    # #             }
    # #             """
    # # def _generate_build_script(self):
    # #     """Generate build script that auto-detects package"""
    # #     return r"""#!/bin/bash
    # #         set -e

    # #         # First try with default package (sg48)
    # #         echo "Trying with package=sg48..."
    # #         if nextpnr-ice40 --up5k --package sg48 --json top.json --pcf constraints.pcf --asc top.asc 2>/dev/null; then
    # #             echo "Success with sg48 package"
    # #             icepack top.asc top.bin
    # #             exit 0
    # #         fi

    # #         # If that fails, try other common packages
    # #         for package in uwg30 qfn48; do
    # #             echo "Trying with package=$package..."
    # #             if nextpnr-ice40 --up5k --package $package --json top.json --pcf constraints.pcf --asc top.asc 2>/dev/null; then
    # #                 echo "Success with $package package"
    # #                 icepack top.asc top.bin
    # #                 exit 0
    # #             fi
    # #         done

    # #         # If all failed, show diagnostic info
    # #         echo "ERROR: Could not determine FPGA package type"
    # #         echo "Your constraints.pcf:"
    # #         cat constraints.pcf
    # #         echo "Possible solutions:"
    # #         echo "1. Check your FPGA chip for package marking (e.g., 'SG48')"
    # #         echo "2. Update the package type in build.sh"
    # #         echo "3. Verify pin numbers match your board schematic"
    # #         exit 1
    # #         """
    # def _generate_build_script(self):
    #     """Generate a reliable build script"""
    #     return r"""#!/bin/bash
    #                     set -e

    #                     # 1. Verify tools
    #                     command -v yosys >/dev/null || { echo "yosys not found"; exit 1; }
    #                     command -v nextpnr-ice40 >/dev/null || { echo "nextpnr-ice40 not found"; exit 1; }
    #                     command -v icepack >/dev/null || { echo "icepack not found"; exit 1; }

    #                     # 2. Run synthesis
    #                     yosys -l yosys.log -p "
    #                         read_verilog -lib /usr/share/yosys/ice40/cells_sim.v;
    #                         read_verilog top.v;
    #                         synth_ice40 -top top -json top.json
    #                     " || { cat yosys.log; exit 1; }

    #                     # 3. Find working package
    #                     for package in $(ls /usr/share/nextpnr/ice40/ 2>/dev/null); do
    #                         package=${package%.json}
    #                         echo "Trying package $package..."
    #                         if nextpnr-ice40 --up5k --package $package \
    #                         --json top.json --pcf constraints.pcf --asc top.asc 2>/dev/null; then
    #                             echo "Success with package $package"
    #                             icepack top.asc top.bin
    #                             exit 0
    #                         fi
    #                     done

    #                     echo "ERROR: No working package found"
    #                     exit 1
    #                     """

              
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