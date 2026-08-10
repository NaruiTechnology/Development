# Raspberry Pi vacuum controller

## Runtime topology

```text
Browser UI
  -> ionbeam-web /api/vacuum/*
  -> active vacuum failover executor :8780
  -> fenced SBC vacuum API :8765
  -> simulator OR Raspberry Pi BCM GPIO
```

Scan traffic continues to use `PROXY_TARGET_HTTP`. Every vacuum route uses
`VACUUM_CONTROLLER_URL`, including simulation readback. The UI sends the
configured expected value for every named channel in `POST /vacuum/acquire`
and polls `GET /vacuum` for GPIO state, comparator state, and controller
runtime.

## SBC interface

Run `python -m glasgow_service.sbc_vacuum_app` on the Raspberry Pi. It exposes:

- `GET /status` and `GET /vacuum`
- `POST /vacuum/acquire` with `expected_channels`
- `POST /vacuum/pumps/{name}/power`
- `POST /vacuum/pumps/{name}/read` for simulation input
- `POST /vacuum/stop`, `/vacuum/release`, and `/vacuum/leadership/renew`

`Simulate: false` selects BCM GPIO and `Simulate: true` selects the deterministic
in-process plant. Thus both modes use the same network API, failover path, state
model, and UI. There is no Glasgow vacuum transport selector or fallback.

The committed GPIO numbers are initial BCM assignments and must be checked
against the final carrier/relay wiring before setting `Simulate` to false.
Outputs must drive properly isolated relay/control inputs; pump loads must not
be connected directly to Raspberry Pi GPIO.

## Failover and fencing

Redis Sentinel elects one executor. The active executor forwards all mutations
with its executor ID, monotonically increasing fencing token, and remaining
lease duration. The SBC persists the highest accepted token and rejects stale
or expired leaders. A loss of authority prevents further writes; controller
release de-energizes all managed outputs.

Configure the SBC with `examples/sbc-vacuum.env.example`, the executor with
`examples/vacuum-executor.env.example`, and ionbeam-web with:

```dotenv
PROXY_TARGET_HTTP=http://glasgow-host:8765
VACUUM_CONTROLLER_URL=http://active-executor-or-local-proxy:8780
```

For real hardware install the `sbc` optional dependency and the Raspberry Pi
OS `python3-lgpio` package. The systemd unit runs as a dedicated `vacuum` user
in the `gpio` group.
