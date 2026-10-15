# Continuous SBC vacuum-controller failover contract

The vacuum executor is an always-running active/standby service, not a scheduled
task. Both executor processes remain alive, while Redis Sentinel grants exactly
one process a renewable lease and monotonically increasing fencing token.

## Component boundaries

- `VacuumFailoverRuntime` owns active/standby/fenced lifecycle and lease renewal.
- `VacuumController` owns pump sequencing and safety interlocks.
- `SbcVacuumClient` sends fenced commands to the Raspberry Pi vacuum API.
- `RaspberryPiGPIODevice` is the only production vacuum hardware adapter.
- `SimulatedVacuumDevice` provides deterministic software and fault testing.

The standby executor may read status but must not issue mutations. The SBC is
the final authority for GPIO writes and independently rejects stale leaders.

## Executor states

| State | May initiate hardware work? | Meaning |
|---|---:|---|
| `starting` | No | Loading configuration and dependencies. |
| `standby` | No | Healthy and competing for leadership. |
| `active` | Yes | Holds a valid lease and positive fencing token. |
| `draining` | No new work | Finishing or classifying accepted work. |
| `fenced` | No | Coordination is uncertain or leadership was lost. |
| `faulted` | No | Local health or a safety condition failed. |
| `stopped` | No | Terminal process shutdown state. |

Only an active executor with a live lease may initiate work. Lease loss revokes
admission immediately. An operation with an unknown outcome must be reconciled
against SBC status and must never be blindly repeated.

## Safety invariants

1. At most one executor may initiate GPIO mutations.
2. Every mutation carries executor identity, fencing token, and lease lifetime.
3. The SBC rejects expired, lower, or conflicting fencing terms.
4. The mechanical pump cannot be disabled through the normal controller API.
5. A downstream pump cannot start before its upstream status input is ready.
6. Communication failure clears readiness instead of preserving stale input.
7. Without a live lease the SBC still de-energizes and closes (safe-direction
   writes); it never energizes or opens.
8. Simulation opens no physical GPIO device.

## Persistent SBC fencing

Set `SBC_REQUIRE_FENCING=true` on the Raspberry Pi. Mutating requests require:

- `X-Executor-ID`: unique executor identity.
- `X-Fencing-Token`: positive, monotonically increasing leadership term.
- `X-Lease-Valid-For-Ms`: remaining validity window, capped at 30 seconds.

The SBC atomically persists its highest accepted term at `SBC_FENCING_STATE`
(default `/var/lib/vacuum-controller/fencing-token.json`). It rejects lower
terms and a reused term presented by another executor, including after restart.
The executor renews the control window through
`POST /vacuum/leadership/renew`. Without a live lease the SBC energizes
nothing and opens no valve, but its own interlocks still de-energize pumps,
close valves and drop high voltage: fencing stops a stale executor from
driving the hardware, never the SBC from making it safe. A lease gap during
failover is not a device error and does not latch the cascade; the new leader
continues from the measured state. If the renew response shows the SBC
controller is not running (the SBC process restarted under the same term),
the executor acquires it again.

Redis/Sentinel performs leader election; SBC fencing is the independent
single-hardware-owner protection. `RedisSentinelLeaseCoordinator` uses atomic
Lua operations for acquisition, renewal, and owner-verified release, and asks
Redis to acknowledge a new fencing term on a replica before it is used.

## Always-on process

`python -m glasgow_service.vacuum_executor_app` runs continuously and exposes
`/health/live`, `/health/ready`, and `/status`. Configure the executor with
`examples/vacuum-executor.env.example`, configure the Raspberry Pi with
`examples/sbc-vacuum.env.example`, and supervise both with their systemd units.
A stopping executor releases its Redis lease (so the standby takes over at
once) but does not call `/vacuum/release`, which would power the whole system
down; set `VACUUM_EXECUTOR_RELEASE_ON_STOP=true` to get that behaviour back.
The scan and sample-stage services are independent and have no vacuum lifecycle
or hardware-control hooks.
