# Vacuum control sub-target

The vacuum applet owns one ordered channel per `VacuumPumps` entry in
`vacuumSystem.json`:

| Channel field | Source |
| --- | --- |
| Port A output | `write` |
| Port B comparator input | `read` |
| High level | `Glasgow.*.voltage` |
| Comparator target | `value` |
| Allowed target delta | `errorRange` |

For real hardware, the service invokes the supported `control-gpio` applet in
the same short-lived process pattern as `glasgowWriteDataApp.py`. Port A is
driven with the configured pump states and Port B is sampled for the external
IC comparator results. The real-hardware transport does not load the custom
vacuum subtarget or send simulation target-code commands.

In simulation, the custom FPGA target is not loaded. The service invokes the
configured `Actions.writeData` and `Actions.readData` Glasgow GPIO commands,
maps a logical high to the configured voltage, and uses the configured
`errorRange` to generate the simulated comparator result.

## FIFO protocol

Host-to-FPGA commands are byte-oriented:

| Command | Bytes | Meaning |
| --- | --- | --- |
| `0x01` | `0x01, output_mask` | Atomically set all Port A channels |
| `0x02` | `0x02` | Snapshot Port A and synchronized Port B |
| `0x03` | `0x03, channel, target_u32, tolerance_u32` | Configure comparator target |

`ReadStatus` returns `0x80, output_mask, input_mask`. Bit zero corresponds to
the first configured pump. The service converts each bit into either `0.0` or
the configured high voltage before returning API status.

The custom `ConfigureTarget` command remains available for protocol tests and
future comparator-DAC hardware, but it is not used by either current runtime
transport. Simulation continues to use the configured `value` and
`errorRange` to generate logical comparator results.

The protocol supports up to eight uniquely mapped pump channels. Invalid,
empty, duplicate, or oversized channel configurations are rejected before the
FPGA is loaded.
