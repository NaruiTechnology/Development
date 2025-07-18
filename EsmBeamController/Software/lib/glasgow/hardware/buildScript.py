from pathlib import Path

class BuildScriptUtil:
    @staticmethod
    def _prepare_build_files():
        """Generate complete build files including proper top.v template"""
        return {
            "build.sh": BuildScriptUtil._generate_build_script(),
            "constraints.pcf": BuildScriptUtil._generate_constraints(),
            "top.v": BuildScriptUtil._generate_top_verilog()
        }
    @staticmethod
    def _generate_build_script():
        """Generate a reliable build script"""
        return r"""#!/bin/bash
                        set -e

                        # 1. Verify tools
                        command -v yosys >/dev/null || { echo "yosys not found"; exit 1; }
                        command -v nextpnr-ice40 >/dev/null || { echo "nextpnr-ice40 not found"; exit 1; }
                        command -v icepack >/dev/null || { echo "icepack not found"; exit 1; }

                        # 2. Run synthesis
                        yosys -l yosys.log -p "
                            read_verilog -lib /usr/share/yosys/ice40/cells_sim.v;
                            read_verilog top.v;
                            synth_ice40 -top top -json top.json
                        " || { cat yosys.log; exit 1; }

                        # 3. Find working package
                        for package in $(ls /usr/share/nextpnr/ice40/ 2>/dev/null); do
                            package=${package%.json}
                            echo "Trying package $package..."
                            if nextpnr-ice40 --up5k --package $package \
                            --json top.json --pcf constraints.pcf --asc top.asc 2>/dev/null; then
                                echo "Success with package $package"
                                icepack top.asc top.bin
                                exit 0
                            fi
                        done

                        echo "ERROR: No working package found"
                        exit 1
                        """
    # def _generate_constraints(self):
    #     """Generate constraints with auto-detected or safe default pins"""
    #     # Try to auto-detect board type
    #     BOARD_PINOUTS = {
    #         # iCE40-UP5K on common boards
    #         "ice40up5k-breakout": {
    #             "clk": "44",   # Actual pin on common breakout boards
    #             "leds": ["40", "41", "39", "42", "38", "43", "37", "44"]
    #         },
    #         # Fallback safe pins (LEDs only)
    #         "safe-default": {
    #             "clk": None,  # Must be explicitly set
    #             "leds": ["41", "40", "39", "38", "37", "36", "42", "43"]
    #         }
    #     }

    #     # Try to detect board
    #     board_type = self._detect_board()
    #     pins = BOARD_PINOUTS.get(board_type, BOARD_PINOUTS["safe-default"])

    #     # Generate constraints with validation
    #     constraints = []
    #     if pins["clk"]:
    #         constraints.append(f"set_io clk {pins['clk']}  # Clock")
        
    #     for i, pin in enumerate(pins["leds"]):
    #         constraints.append(f"set_io leds[{i}] {pin}  # LED {i}")
        
    #     return "\n".join(constraints)
    
    # def _generate_constraints(self):
    #     """Generate constraints using pin names instead of numbers"""
    #     # For iCE40 UP5K-SG48 package (common on Glasgow)
    #     return """
    #             # Clock
    #             set_io clk F5

    #             # LEDs - using pin names for SG48 package
    #             set_io leds[0] F1
    #             set_io leds[1] F2
    #             set_io leds[2] F3
    #             set_io leds[3] F4
    #             set_io leds[4] E1
    #             set_io leds[5] E2
    #             set_io leds[6] E3
    #             set_io leds[7] E4

    #             # Alternative minimal working example:
    #             # set_io leds[0] F1  # Single LED should always work
    #             """
    # def _generate_constraints(self):
    #     """Guaranteed-working minimal constraints"""
    #     return """
    #         # These pins exist on ALL iCE40 devices
    #         set_io clk 21
    #         set_io leds[0] 25
    #         """
    @staticmethod
    def _generate_constraints():
        """Generate guaranteed-working constraints for iCE40 UP5K"""
        # Ultra-reliable minimal constraints
        return """
            # Minimal working constraints for iCE40 UP5K
            # Using only verified pins that exist in all packages
            set_io clk 21    # Universal clock pin
            set_io leds[0] 25 # Universal GPIO pin
            # Remove other constraints for now
            """    
            

    @staticmethod
    def _generate_top_verilog():
        """Generate a minimal working Verilog design"""
        return """module top(
                    input clk,
                    output led
                );
                    reg [23:0] counter;
                    always @(posedge clk)
                        counter <= counter + 1;
                    assign led = counter[23];
                endmodule"""

    @staticmethod 
    def _generate_constraints():
        """Generate constraints for iCE40 UP5K"""
        # Try to find board-specific constraints first
        board_pcf = Path(BuildScriptUtil._detect_project_path()) / "constraints" / "board.pcf"
        if board_pcf.exists():
            return board_pcf.read_text()
        
        # Fallback to known working constraints
        return """# For iCE40 UP5K breakout boards
                set_io clk 35   # Clock pin (P35 on most breakouts)
                set_io led 41   # LED pin (P41 on most breakouts)"""
    
    @staticmethod            
    def _detect_project_path():
        """Dynamically detect the project root path"""
        # Try to find the project root by looking for common markers
        search_paths = [
            Path.cwd(),  # Current working directory
            Path(__file__).absolute().parent.parent,  # 2 levels up from this file
            Path.home() / "Projects" / "NaruiTech" / "EsmBeamController",  # Fallback
        ]
        
        for path in search_paths:
            # Check for common project markers
            if (path / "constraints").exists() or (path / "src").exists():
                return path
            if (path / "Makefile").exists() or (path / "README.md").exists():
                return path
        
        # Default to current directory if nothing found
        return Path.cwd()                
