# Continuous vacuum-controller failover contract

This service is an infinitely running active/standby vacuum controller. Failover
is not a scheduled task. Both executor processes remain alive; coordination
grants exactly one process permission to initiate vacuum work.

## Component boundaries

- The **executor lifecycle** owns active/standby/fenced state and the renewable
  leader lease.
- `VacuumController` owns the pump cascade and safety interlocks.
- `VacuumDevice` is the hardware-neutral digital I/O boundary.
- `SimulatedVacuumDevice` is used for deterministic software and fault testing.
- The production Glasgow adapter remains the exclusive owner of the one FPGA.

The standby executor must not open the Glasgow device or issue device commands.
The Glasgow process and physical FPGA remain a documented availability boundary
until a safe, positively fenced hardware-transfer mechanism is designed.

## Executor states

| State | May initiate hardware work? | Meaning |
|---|---:|---|
| `starting` | No | Loading configuration and dependencies. |
| `standby` | No | Healthy and competing for leadership. |
| `active` | Yes | Holds a valid lease and positive fencing token. |
| `draining` | No new work | Finishing or classifying an accepted operation. |
| `fenced` | No | Coordination is uncertain or leadership was lost. |
| `faulted` | No | Local health or safety condition failed. |
| `stopped` | No | Terminal process shutdown state. |

Only `active` with a valid fencing token permits new work. Losing lease renewal
must immediately revoke admission. An in-flight hardware operation is then
drained or classified as outcome-unknown; it is never blindly repeated.

## Safety invariants

1. At most one executor may initiate hardware work.
2. A non-active executor issues no new Glasgow command.
3. A new leadership term uses a fencing token greater than every prior term.
4. The mechanical pump cannot be disabled through the normal controller API.
5. Downstream pumps cannot start until their upstream comparator is ready.
6. Communication failure clears readiness rather than preserving stale input.
7. Unknown hardware outcomes require reconciliation before retry.
8. Simulation uses no physical Glasgow connection.

## Implemented simulation scope

The first iteration established the lifecycle model, device protocol,
deterministic vacuum simulator, and tests. The second iteration adds a
transport-neutral lease coordinator, monotonic fencing tokens, deterministic
lease time, per-executor coordination partitions, and the infinitely running
executor orchestration loop.

The in-memory coordinator is a simulation authority, not a production
distributed lock. Redis/Sentinel integration must implement the same contract
and preserve its atomic ownership and monotonically increasing token behavior.
Persistence, network listeners, SBC configuration, and physical hardware
switching remain outside the current scope.
