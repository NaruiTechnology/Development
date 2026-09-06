# OBI Data Interconnect pinout

The Glasgow connector is J1, a 2x22, 1.27 mm receptacle. The field headers are 2x10, 2.54 mm:

| Header | Odd signal pins | Even pins |
|---|---|---|
| J3 | pin 3 D-1, 5 D-2, 7 D-3, 9 D-4, 11 D-5, 13 D-6, 15 D-7, 17 D-8 | GNDD |
| J4 | pin 3 D-9, 5 D-10, 7 D-11, 9 D-12, 11 D-13, 13 D-14, 15 D-15, 17 D-16 | GNDD |
| J2 | pin 3 D-17, 5 D-18, 7 D-19, 9 D-20, 11 D-21, 13 D-22, 15 D-23, 17 D-24 | GNDD |

J2/J3/J4 pin 2 is the selected +3.3 V rail. Pins 19 and 20 are reserved/no-connect in the source design.

## Glasgow J1 signal mapping

The connector keeps the existing OBI mapping: D1/D2/D3/D4, E1/E2/E3, F1/F2/F3/F4, G1/G2/G3, H1/H2/H3, and K1/J1/Z12 control/clock signals remain on their original Glasgow pins. The exact pin-level mapping is captured by the KiCad net names and is audited by `tools/audit_interconnect.py`.

The scan subtarget consumes D-1..D-14 as the shared bus and uses G1/H2/G3/F3/H3/H1 for ADC clock, latch, output-enable, DAC clock, X latch, and Y latch respectively. ADC and DAC ownership is time-multiplexed by the Glasgow applet; this passive board does not add a second bus or an analogue switch.
