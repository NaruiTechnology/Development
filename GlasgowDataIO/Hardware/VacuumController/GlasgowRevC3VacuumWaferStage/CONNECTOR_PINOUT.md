# Connector Pinout

This pinout matches the vacuum wafer stage interface board described in `README.md`.

## J1 - Glasgow control input

| Pin | Signal | Notes |
| --- | --- | --- |
| 1 | `STEP` | Motion pulse input |
| 2 | `DIR` | Direction input |
| 3 | `EN` | Enable input |
| 4 | `GND` | Logic ground |

## J2 - Driver output

| Pin | Signal | Notes |
| --- | --- | --- |
| 1 | `STEP_OUT` | Buffered step command |
| 2 | `DIR_OUT` | Buffered direction command |
| 3 | `EN_OUT` | Buffered enable command |
| 4 | `GND` | Logic ground |

## J3 - Encoder input

| Pin | Signal | Notes |
| --- | --- | --- |
| 1 | `A+` | Differential quadrature channel A positive |
| 2 | `A-` | Differential quadrature channel A negative |
| 3 | `B+` | Differential quadrature channel B positive |
| 4 | `B-` | Differential quadrature channel B negative |
| 5 | `Z+` | Differential index pulse positive |
| 6 | `Z-` | Differential index pulse negative |
| 7 | `+5V_ENC` | Encoder supply, if required |
| 8 | `GND` | Encoder return |

## J4 - Encoder output to controller

| Pin | Signal | Notes |
| --- | --- | --- |
| 1 | `ENC_A` | Single-ended encoder A output |
| 2 | `ENC_B` | Single-ended encoder B output |
| 3 | `ENC_Z` | Single-ended encoder index output |
| 4 | `GND` | Logic ground |

## J5 - Interlock chain

| Pin | Signal | Notes |
| --- | --- | --- |
| 1 | `ESTOP_CHAIN` | Series emergency stop loop |
| 2 | `CHAMBER_OK` | Vacuum system ready |
| 3 | `DRIVER_FAULT` | Driver fault return |
| 4 | `GND` | Interlock ground |
