from pathlib import Path
import shutil

class BuildScriptUtil:
    # @staticmethod
    # def _prepare_build_files(build_dir):
    #     """Generate complete build files and ensure constraints are available"""
    #     files = {
    #         "build.sh": BuildScriptUtil._generate_build_script(),
    #         "top.v": BuildScriptUtil._generate_top_verilog()
    #     }
        
    #     # Handle constraints file specially - copy from project if exists
    #     constraints_src = BuildScriptUtil._find_constraints_file()
    #     constraints_dest = Path(build_dir) / "constraints.pcf"
        
    #     if constraints_src:
    #         shutil.copy(str(constraints_src), str(constraints_dest))
    #         print(f"Using constraints from: {constraints_src}")
    #     else:
    #         with open(constraints_dest, 'w') as f:
    #             f.write(BuildScriptUtil._generate_default_constraints())
    #         print("Generated default constraints.pcf")
            
    #     files["constraints.pcf"] = constraints_dest.read_text()
    #     return files

    # @staticmethod
    # def _find_constraints_file():
    #     """Search for existing constraints file in standard locations"""
    #     search_paths = [
    #         Path("constraints") / "board.pcf",
    #         Path("constraints.pcf"),
    #         Path("src") / "constraints.pcf",
    #         Path(__file__).parent.parent / "constraints" / "board.pcf"
    #     ]
        
    #     for path in search_paths:
    #         if path.exists():
    #             return path
    #     return None
    
    # @staticmethod
    # def prepare_build_environment(build_dir):
    #     """Prepare build environment with consistent constraint file naming"""
    #     build_dir = Path(build_dir)
        
    #     # 1. Ensure constraints file uses correct name (top.pcf)
    #     constraints_content = BuildScriptUtil._get_constraints()
    #     constraints_path = build_dir / "top.pcf"  # Changed to expected name
        
    #     with open(constraints_path, 'w') as f:
    #         f.write(constraints_content)
        
    #     # 2. Generate other build files
    #     files = {
    #         "build.sh": BuildScriptUtil._generate_build_script(),
    #         "top.v": BuildScriptUtil._generate_top_verilog(),
    #         "top.pcf": constraints_content  # Using correct name
    #     }
        
    #     for filename, content in files.items():
    #         with open(build_dir / filename, 'w') as f:
    #             f.write(content)
        
    #     (build_dir / "build.sh").chmod(0o755)
    #     return files
    @staticmethod
    def prepare_build_environment(build_dir):
        """Prepare build environment with guaranteed working constraints"""
        build_dir = Path(build_dir)
        build_dir.mkdir(parents=True, exist_ok=True)
        
        # 1. Handle constraints file with strict validation
        constraints_content = BuildScriptUtil._get_valid_constraints()
        constraints_path = build_dir / "top.pcf"
        
        with open(constraints_path, 'w') as f:
            f.write(constraints_content)
        
        # 2. Generate other build files
        files = {
            "build.sh": BuildScriptUtil._generate_build_script(),
            "top.v": BuildScriptUtil._generate_top_verilog(),
            "top.pcf": constraints_content
        }
        
        for filename, content in files.items():
            with open(build_dir / filename, 'w') as f:
                f.write(content)
        
        (build_dir / "build.sh").chmod(0o755)
        return files

    # @staticmethod
    # def _get_constraints():
    #     """Get constraints content with proper Glasgow defaults"""
    #     return """# Glasgow iCE40HX1K-TQ144 Constraints
    #             set_io clk 21       # 12MHz oscillator (pin 21)
    #             set_io led_red 99   # Status LED red (pin 99)
    #             set_io led_green 98 # Status LED green (pin 98)

    #             # USB Interface
    #             set_io usb_dp 43    # USB D+ (pin 43)
    #             set_io usb_dm 44    # USB D- (pin 44)
                # """    @staticmethod
    def _get_valid_constraints():
        """Generate and validate constraints content"""
        constraints = """# Glasgow iCE40HX1K-TQ144 Constraints
                        set_io clk 21       # 12MHz oscillator (pin 21)
                        set_io led_red 99   # Status LED red (pin 99)
                        set_io led_green 98 # Status LED green (pin 98)

                        # USB Interface
                        set_io usb_dp 43    # USB D+ (pin 43)
                        set_io usb_dm 44    # USB D- (pin 44)
                        """
        # Validate the constraints format
        if "set_io" not in constraints:
            raise ValueError("Generated constraints are invalid - no set_io directives")
        return constraints

    @staticmethod
    def _generate_build_script():
        """Generate build script with proper error handling"""
        return r"""#!/bin/bash
            set -euo pipefail

            # 1. File existence checks with proper error messages
            check_file() {
                [ -f "$1" ] || {
                    echo "ERROR: Required file $1 not found in $(pwd)"
                    ls -l
                    exit 1
                }
            }

            check_file "top.v"
            check_file "top.pcf"

            # 2. Verify constraints content
            if ! grep -q "set_io" "top.pcf"; then
                echo "ERROR: Invalid constraints file - no set_io directives"
                echo "File contents:"
                cat "top.pcf"
                exit 1
            fi

            # 3. Run synthesis with proper error capture
            echo "=== Running Synthesis ==="
            yosys -l yosys.log -p "
                read_verilog -lib /usr/share/yosys/ice40/cells_sim.v;
                read_verilog top.v;
                synth_ice40 -top top -json top.json
            " || {
                echo "Synthesis failed:"
                cat yosys.log
                exit 1
            }

            # 4. Place and route with detailed error reporting
            echo "=== Running Place & Route ==="
            nextpnr-ice40 \
                --hx1k \
                --package tq144 \
                --json top.json \
                --pcf top.pcf \
                --asc top.asc \
                --freq 12 \
                2>pnr.log || {
                echo "Place and route failed:"
                cat pnr.log
                exit 1
            }

            # 5. Bitstream generation
            echo "=== Generating Bitstream ==="
            icepack top.asc top.bin || {
                echo "Bitstream generation failed"
                exit 1
            }

            echo "=== Build Successful ==="
            exit 0  # Explicit success exit code
            """


    # @staticmethod
    # def _generate_build_script():
    #     """Generate build script that looks for top.pcf"""
    #     return r"""#!/bin/bash
    #             set -euo pipefail

    #             # Verify required files exist
    #             [ -f top.v ] || { echo "ERROR: top.v not found"; exit 1; }
    #             [ -f top.pcf ] || { echo "ERROR: top.pcf not found"; ls -la; exit 1; }

    #             # Synthesis
    #             yosys -l yosys.log -p "
    #                 read_verilog -lib /usr/share/yosys/ice40/cells_sim.v;
    #                 read_verilog top.v;
    #                 synth_ice40 -top top -json top.json
    #             " || { cat yosys.log; exit 1; }

    #             # Place and Route
    #             nextpnr-ice40 \
    #                 --hx1k \
    #                 --package tq144 \
    #                 --json top.json \
    #                 --pcf top.pcf \  # Now using correct filename
    #                 --asc top.asc \
    #                 --freq 12 \
    #                 2>pnr.log || { cat pnr.log; exit 1; }

    #             # Bitstream generation
    #             icepack top.asc top.bin
    #             echo "Build successful!"
    #             """

    @staticmethod
    def _generate_default_constraints():
        """Generate guaranteed-working constraints for Glasgow hardware"""
        return """# Default constraints for Glasgow iCE40HX1K-TQ144
                # Clock - 12MHz oscillator on pin 21
                set_io clk 21

                # Status LED on pin 99 (red)
                set_io led_red 99

                # Additional Glasgow-specific pins
                set_io led_green 98
                set_io usb_dp 43
                set_io usb_dm 44
                """

    # @staticmethod
    # def _generate_build_script():
    #     """Generate build script with explicit paths"""
    #     return r"""#!/bin/bash
    #     set -euo pipefail

    #     # Verify constraints file exists
    #     if [ ! -f constraints.pcf ]; then
    #         echo "ERROR: constraints.pcf not found in $(pwd)"
    #         exit 1
    #     fi

    #     # Run synthesis
    #     yosys -l yosys.log -p "
    #         read_verilog -lib /usr/share/yosys/ice40/cells_sim.v;
    #         read_verilog top.v;
    #         synth_ice40 -top top -json top.json
    #     " || { cat yosys.log; exit 1; }

    #     # Place and route for Glasgow hardware
    #     nextpnr-ice40 \
    #         --hx1k \
    #         --package tq144 \
    #         --json top.json \
    #         --pcf constraints.pcf \
    #         --asc top.asc \
    #         --freq 12 \
    #         2>pnr.log || { cat pnr.log; exit 1; }

    #     # Generate bitstream
    #     icepack top.asc top.bin

    #     echo "Build successful! Bitstream: top.bin"
    #     """

    # @staticmethod
    # def _generate_top_verilog():
    #     """Generate top.v that matches Glasgow hardware"""
    #     return """module top(
    #         input clk,
    #         output led_red,
    #         output led_green
    #     );
    #         reg [23:0] counter = 0;
    #         always @(posedge clk) begin
    #             counter <= counter + 1;
    #         end
            
    #         assign led_red = counter[23];  // ~1.5Hz blink
    #         assign led_green = counter[22]; // ~3Hz blink
    #     endmodule
    #     """
    
    @staticmethod
    def _generate_top_verilog():
        """Generate verilog matching the constraints"""
        return """module top(
            input clk,
            output led_red,
            output led_green,
            inout usb_dp,
            inout usb_dm
        );
            // Simple LED test pattern
            reg [23:0] counter = 0;
            always @(posedge clk) begin
                counter <= counter + 1;
            end
            
            assign led_red = counter[23];    // ~1.5Hz blink
            assign led_green = counter[22];  // ~3Hz blink
            
            // USB lines - set as inputs by default
            assign usb_dp = 1'bz;
            assign usb_dm = 1'bz;
        endmodule
        """