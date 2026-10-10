# Five-axis stage control board — prototype design inputs

Release class: **engineering prototype, not approved for fabrication or machine operation**

## Safe scope

This board is a low-voltage command, status, and safety-interface board. It does
not drive motor windings, piezo stacks, brakes, contactors, or safe-torque-off
loads directly. Production motor power remains in separately selected,
certified drives.

## Assumed electrical domains

| Domain | Assumption | Release requirement |
| --- | --- | --- |
| Glasgow logic | 3.3 V CMOS | Verify rev-C3 I/O current and pin assignment |
| Board logic | 3.3 V, locally decoupled | Select regulator only if Glasgow cannot supply it |
| External command | isolated differential STEP/DIR or CW/CCW | Confirm after drive selection |
| External status | isolated 24 V industrial READY/FAULT/HOME/LIMIT | Confirm thresholds and polarity |
| Encoder | isolated RS-422 A/B/Z or vendor serial | Select receiver/isolator after encoder selection |
| Safety | dry-contact/24 V sensing only | Safety relay performs the safety function |
| Shield/chassis | connector-entry bond, no signal-current return | Approve EMC/grounding plan |

## Conservative architecture

1. Glasgow signals enter through a keyed control connector.
2. Each external axis uses galvanically isolated command and status channels.
3. Field inputs use protected 24 V input stages with replaceable TVS and series
   impedance; exact values remain unpopulated until thresholds are known.
4. The board may report permits and safety state, but cannot override the
   independent safety relay.
5. Hardware motion enable is the logical AND of the external safety permit and
   the controller request. Loss of power produces the disabled state.
6. Cable shields terminate at chassis near the connector entry. Logic ground
   and chassis are not joined by an undocumented copper pour.

## Layout constraints

- Minimum four-layer stack: signal / solid logic ground / power / signal.
- Keep field-side and logic-side copper separated according to the selected
  isolator working voltage and applicable pollution degree.
- Do not route copper beneath isolation barriers.
- Place TVS/protection and chassis bonds at connectors.
- Route differential commands and encoder channels as controlled, matched pairs.
- Provide test points for every isolated supply, enable, ready, and fault signal.
- Keep the safety-permit path visually and electrically distinct from software
  status routing.

## Stop conditions

Do not generate an approved fabrication release until all `TBD` entries in the
draft BOM and connector pinout are replaced, the selected drive manuals are
reviewed, and the release checklist is signed.
