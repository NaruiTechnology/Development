# Connector pinout — draft contract

Status: **pin numbering is provisional until connector families and drive I/O are selected**

## J1 — Glasgow control

| Pin | Signal | Direction | Notes |
| --- | --- | --- | --- |
| 1 | +3V3_LOGIC | power | Current budget TBD |
| 2 | GND_LOGIC | return | Logic only |
| 3 | X_CMD_CLK | out | X SPI clock/prototype command |
| 4 | X_CMD_DATA | out | X SPI data/prototype command |
| 5 | X_STATUS_DATA | in | X SPI/status return |
| 6 | X_SELECT | out | X chip select |
| 7 | Y_CMD_CLK | out | Y SPI clock/prototype command |
| 8 | Y_CMD_DATA | out | Y SPI data/prototype command |
| 9 | Y_STATUS_DATA | in | Y SPI/status return |
| 10 | Y_SELECT | out | Y chip select |
| 11 | Z_COMMAND | out | Protocol TBD |
| 12 | T_COMMAND | out | Protocol TBD |
| 13 | R_COMMAND | out | Protocol TBD |
| 14 | MOTION_ENABLE_REQUEST | out | Cannot bypass safety permit |
| 15 | SYSTEM_READY | in | Aggregated status |
| 16 | SYSTEM_FAULT | in | Aggregated fault |

## J2–J6 — axis field connector, one per X/Y/Z/T/R

| Pin | Signal | Direction | Notes |
| --- | --- | --- | --- |
| 1 | COMMAND+ | out | Isolated differential command |
| 2 | COMMAND− | out | Pair with pin 1 |
| 3 | ENABLE+ | out | Isolated, fail-disabled |
| 4 | ENABLE− | out | Pair with pin 3 |
| 5 | READY+ | in | Isolated drive-ready input |
| 6 | READY− | in | Pair with pin 5 |
| 7 | FAULT+ | in | Isolated drive-fault input |
| 8 | FAULT− | in | Pair with pin 7 |
| 9 | HOME+ | in | Omit/DNP for continuous R if unused |
| 10 | HOME− | in | Pair with pin 9 |
| 11 | LIMIT_NEG+ | in | DNP where mechanically inapplicable |
| 12 | LIMIT_NEG− | in | Pair with pin 11 |
| 13 | LIMIT_POS+ | in | DNP where mechanically inapplicable |
| 14 | LIMIT_POS− | in | Pair with pin 13 |
| 15 | SHIELD | chassis | Bond at entry |
| 16 | CHASSIS | chassis | Never use as signal return |

Encoder feedback uses a separate keyed connector after encoder protocol
selection. Do not combine an unknown encoder supply with command/status wiring.

## J7 — safety relay monitoring (not the safety function)

| Pin | Signal | Direction | Notes |
| --- | --- | --- | --- |
| 1 | SAFETY_PERMIT_A | in | Isolated sense of safety relay output |
| 2 | SAFETY_PERMIT_B | in | Independent channel sense |
| 3 | STO_FEEDBACK | in | Drive/contactor feedback only |
| 4 | RESET_STATUS | in | Manual-reset state |
| 5 | FIELD_RETURN | return | Defined by selected 24 V interface |
| 6 | CHASSIS | chassis | Connector shield bond |

The PCB must not source the safety reset or implement the emergency-stop safety
function in ordinary logic.
