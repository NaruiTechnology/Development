# OBI bus timing profile

The scan controller follows the six-state BusController in the local upstream
Open-Beam-Interface checkout at 0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f.
At 48 MHz the fixed half-period is 3: one conversion/dwell unit is 125 ns.

Sequence starting at logical ADC clock rising (physical falling with inversion):

| Tick | State | ADC LE | Logical ADC OE | FPGA data OE | DAC latch |
|---|---|---|---|---|---|
| 0 | ADC_Wait trigger | 1 | 1 | 0 | — |
| 1 | ADC_Read | 0 | 1 | 0 | — |
| 2 | X_DAC_Write | 0 | 0 | 1 | — |
| 3 | X_DAC_Write_2 | 0 | 0 | 1 | X |
| 4 | Y_DAC_Write | 0 | 0 | 1 | — |
| 5 | Y_DAC_Write_2 | 0 | 0 | 1 | Y |

The FIFO captures the bus at the end of ADC_Read. There is no additional sample
register, settle state, or turnaround state. ADC clock, DAC clock and ADC OE
retain the upstream physical inversion. The ADC data remains right-aligned in
our 16-bit software container; this does not alter the physical 14-bit bus.

The six timing keys remain configurable for controlled FSM troubleshooting.
The active and default JSON files use `3/1/1/0/1/1`, which reproduces the
upstream sequence above exactly. Configuration is rejected unless the complete
latch, settle, turnaround, and two DAC setup/latch windows fit within one ADC
period. Changing a timing key changes the corresponding gateware state width.

Standalone ADC diagnostics use the same default latch phase (3) and read phase
(4), while retaining continuous OE and input-only data pins. Explicit standalone
phase overrides are diagnostic controls, not scan-FSM settings.

Verification performed: 3,000 cycles of continuous traffic and 3,000 cycles with
input/output stalls compared against upstream. Control signals, DAC bus, ADC
values, last tags and valid/ready signals match cycle by cycle. This establishes
software equivalence, not physical recovery. Source edits must be included in
the deployed application and its newly built FPGA image before hardware
results can validate this change.

The supplied PCB identifies U6 as the external register: both OE pins connect
to S.WRITE_A and both clock pins to S.LATCH_A. U9 is the ADC; its OE and SHDN
pins connect to GNDA. Therefore changing adc_oe inversion does not control
U9's own OE in this board design.
