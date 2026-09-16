# Safe OBI-derived bus timing profile

The scan controller derives its transaction ordering from the six-state
BusController in the local upstream Open-Beam-Interface checkout at
0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f. It intentionally adds bus-release
dead time around the ownership handoff. At 48 MHz the safe half-period is 4:
one conversion/dwell unit is approximately 166.7 ns (6 MS/s).

Sequence starting at logical ADC clock rising (physical falling with inversion):

| Tick | State | ADC LE | Logical ADC OE | FPGA data OE | DAC latch |
|---|---|---|---|---|---|
| 0 | ADC_Wait trigger | 1 | 1 | 0 | — |
| 1 | ADC_Read | 0 | 1 | 0 | — |
| 2 | Bus_Turnaround | 0 | 0 | 0 | — |
| 3 | X_DAC_Write | 0 | 0 | 1 | — |
| 4 | X_DAC_Write_2 | 0 | 0 | 1 | X |
| 5 | Y_DAC_Write | 0 | 0 | 1 | — |
| 6 | Y_DAC_Write_2 | 0 | 0 | 1 | Y |
| 7 | ADC_Wait release | 0 | 0 | 0 | — |

The FIFO captures the bus at the end of ADC_Read. A complete high-impedance
cycle follows before the FPGA data driver is enabled. The final idle slot also
releases the FPGA before the next ADC window. ADC clock, DAC clock and ADC OE
retain the upstream physical inversion. The ADC data remains right-aligned in
our 16-bit software container; this does not alter the physical 14-bit bus.

The six timing keys remain configurable for controlled FSM troubleshooting.
The active and default JSON files use `4/1/1/1/1/1`. A zero-cycle turnaround
is rejected: logical mutual exclusion alone cannot account for U6 output-disable
and FPGA pad-enable propagation. Configuration is rejected unless the complete
latch, settle, turnaround, and two DAC setup/latch windows fit within one ADC
period. Changing a timing key changes the corresponding gateware state width.

Standalone ADC diagnostics use the same default latch phase (4) and read phase
(5), while retaining continuous OE and input-only data pins. Explicit standalone
phase overrides are diagnostic controls, not scan-FSM settings.

The earlier six-cycle profile was verified cycle-for-cycle against upstream,
but that verifies logical equivalence rather than physical break-before-make.
The safe profile deliberately differs at the bus-owner boundary. Source edits
must be included in the deployed application and its newly built FPGA image
before hardware results can validate this change.

The supplied PCB identifies U6 as the external register: both OE pins connect
to S.WRITE_A and both clock pins to S.LATCH_A. U9 is the ADC; its OE and SHDN
pins connect to GNDA. Therefore changing adc_oe inversion does not control
U9's own OE in this board design.
