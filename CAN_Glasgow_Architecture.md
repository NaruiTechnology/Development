# Glasgow CAN Control Architecture

## Recommendation

Glasgow Interface Explorer is a good fit for a lab prototype, validation rig, or protocol-development gateway for CAN-connected equipment. It is not the right choice as the sole production controller unless you are willing to build and maintain the full CAN stack, isolation hardware, and fail-safe behavior yourself.

## Why Glasgow Fits

Glasgow is an FPGA-based interface explorer with a Python host stack. That makes it practical for custom digital protocols and for building a CAN controller in software and gateware.

Relevant local evidence:

- The device is designed around reconfigurable interface logic and host-side Python applets.
- The current Glasgow applet registry includes UART, SPI, I2C, JTAG, MDIO, GPIO, sensors, memory, audio, and video, but no CAN applet.
- The existing `glasgow_service` package is scan-oriented, so CAN support would be a new subsystem rather than a small extension.

## Why It Is Not Enough By Itself

CAN bus support is not just waveform generation. A production-ready controller also needs:

- a CAN physical layer transceiver
- bus termination
- ESD and surge protection
- optional galvanic isolation
- deterministic arbitration and error handling
- bus-off recovery policy
- logging and diagnostics

Glasgow can host the digital side, but it does not provide the physical CAN layer on its own.

## Proposed System

### Hardware

Use Glasgow as the USB-attached control core, and add a dedicated CAN interface board:

- Glasgow revC board
- isolated CAN transceiver, such as an ISO1042-class or equivalent device
- optional isolated DC/DC supply for the transceiver side
- selectable 120 ohm termination
- TVS diode protection on CANH and CANL
- common-mode choke if the cable environment is noisy
- connector choice based on the equipment harness:
  - DB9 for lab use
  - pluggable terminal block for field wiring
  - automotive-style connector if needed

Recommended signal split:

- Glasgow port A or B for the FPGA-side digital interface
- transceiver board for CANH/CANL
- leave the LVDS connector unused for field CAN unless you add protection and level management externally

### Software

Split the software into three layers:

1. FPGA/gateware layer
2. host daemon layer
3. application integration layer

#### 1. FPGA/Gateware

Implement a new Glasgow applet for CAN. At minimum, it needs:

- bit timing generation
- transmit serialization
- receive deserialization
- arbitration monitoring
- CRC generation and checking
- bit stuffing and de-stuffing
- ACK, error frame, and bus-off state handling

If you want CAN FD, that should be a separate phase. Start with Classical CAN first.

#### 2. Host Daemon

Build a long-lived process that owns the Glasgow device and exposes a stable API.

Recommended interface:

- Linux: SocketCAN bridge if the target environment is Linux
- otherwise: a small REST or WebSocket service for higher-level automation

Responsibilities:

- open and configure the Glasgow device
- manage one active bus session at a time
- expose transmit and receive queues
- translate device errors into structured status codes
- publish bus state: error active, error passive, bus off, disconnected
- log frame metadata and timing

#### 3. Application Integration

Expose a clean domain API for equipment automation:

- send frame
- receive frame
- periodic transmit
- request/response transaction
- bus health query
- reset bus interface
- capture trace for debug

If the equipment automation stack is already using your existing web backend, add a dedicated CAN service and keep it separate from the current scan service.

## Suggested Control Model

For equipment automation, treat CAN as a transport, not as the business logic layer.

Recommended pattern:

- application commands map to CAN frames
- a protocol adapter converts high-level operations into frame sequences
- watchdogs enforce timeouts and expected acknowledgments
- the automation layer records outcomes and retries at the command level

Do not let UI code talk directly to raw frames.

## Safety And Reliability

If this is for real equipment, the interface board should include:

- isolation if the equipment side has its own power domain
- explicit termination control
- power-good monitoring
- default-recessive behavior on boot and fault
- a hard timeout that disables transmit on host disconnect
- electrical protection for cable faults and miswiring

If the bus is shared with safety-critical equipment, use a dedicated hardware watchdog or an upstream supervisor, not host-side software alone.

## Implementation Phases

### Phase 1

- confirm bus speed, topology, voltage domain, and isolation requirements
- pick the transceiver and connector
- prototype a minimal transceiver daughterboard
- validate signal integrity and termination

### Phase 2

- implement a Classical CAN Glasgow applet
- add a host daemon with send/receive and status endpoints
- verify with a second CAN node and a bus analyzer

### Phase 3

- integrate with the equipment automation application
- add command mapping, retries, and health checks
- add persistence, trace capture, and structured logs

### Phase 4

- add fault injection tests
- add bus-off recovery policy
- consider CAN FD only if the equipment actually requires it

## Local Codebase Impact

Current local code shows:

- `glasgow_service` is scan-specific
- `ionbeam-web` proxies that scan service
- the Glasgow source tree has no CAN applet registered today

That means the CAN work should be implemented as a new subsystem, not as a tweak to the existing scan service.

## Bottom Line

Use Glasgow for:

- CAN protocol development
- bench validation
- automation gateway prototypes

Do not use it as the only production controller unless you are prepared to own the full CAN hardware and firmware stack.
