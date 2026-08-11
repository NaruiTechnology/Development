import asyncio
from pathlib import Path

import pytest

from glasgow_service.coordination import InMemoryLeaseCoordinator, ManualClock
from glasgow_service.execution_authority import (
    AuthorityDenied,
    ExecutionPermit,
    FailoverExecutionAuthority,
    PersistentFencingTokenStore,
    RemoteExecutionAuthority,
    StaleFencingToken,
)
from glasgow_service.executor_lifecycle import ExecutorState
from glasgow_service.failover_executor import FailoverExecutor
from glasgow_service.vacuum import MECHANICAL_PUMP, VacuumController, load_vacuum_config
from glasgow_service.vacuum_device import SimulatedVacuumDevice


CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "vacuumSystem.json"


def make_config():
    return load_vacuum_config(CONFIG_PATH).model_copy(
        deep=True,
        update={"enabled": True, "simulate": True, "error_range": 0.005},
    )


def make_device(config):
    return SimulatedVacuumDevice(
        [pump.write for pump in config.pumps],
        [pump.read for pump in config.pumps],
    )


def test_standby_executor_cannot_start_or_write_vacuum_device():
    async def scenario():
        clock = ManualClock()
        coordinator = InMemoryLeaseCoordinator(clock)
        active = FailoverExecutor("node-a", coordinator, clock=clock)
        standby = FailoverExecutor("node-b", coordinator, clock=clock)
        await active.start()
        await standby.start()
        await active.step()
        await standby.step()

        config = make_config()
        device = make_device(config)
        controller = VacuumController(
            config,
            device=device,
            authority=FailoverExecutionAuthority(standby),
        )

        with pytest.raises(AuthorityDenied, match="does not hold active leadership"):
            await controller.start()
        with pytest.raises(AuthorityDenied, match="does not hold active leadership"):
            await controller.set_power("TurboVacuumPump", True)
        assert device.history == []

    asyncio.run(scenario())


def test_leadership_loss_blocks_automatic_cascade_and_direct_commands():
    async def scenario():
        clock = ManualClock()
        coordinator = InMemoryLeaseCoordinator(clock)
        executor = FailoverExecutor("node-a", coordinator, clock=clock)
        await executor.start()
        await executor.step()

        config = make_config()
        device = make_device(config)
        controller = VacuumController(
            config,
            device=device,
            authority=FailoverExecutionAuthority(executor),
        )
        await controller.start()
        try:
            mechanical = controller._states[MECHANICAL_PUMP]
            mechanical.value = mechanical.threshold

            coordinator.set_reachable("node-a", False)
            await executor.step()
            assert executor.lifecycle.state is ExecutorState.FENCED

            await controller.poll_once()
            turbo = controller._states["TurboVacuumPump"]
            # A denied automatic transition makes the poll fail closed: no
            # previously computed readiness is retained on the fenced node.
            assert mechanical.ready is False
            assert mechanical.border == "error"
            assert turbo.power is False
            assert "does not hold active leadership" in controller.status().last_error

            history_length = len(device.history)
            with pytest.raises(AuthorityDenied):
                await controller.set_power("TurboVacuumPump", True)
            assert len(device.history) == history_length
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_new_leader_uses_newer_permit_and_can_start_its_controller():
    async def scenario():
        clock = ManualClock()
        coordinator = InMemoryLeaseCoordinator(clock)
        node_a = FailoverExecutor("node-a", coordinator, clock=clock)
        node_b = FailoverExecutor("node-b", coordinator, clock=clock)
        await node_a.start()
        await node_b.start()
        await node_a.step()
        old_token = node_a.lease.fencing_token

        coordinator.set_reachable("node-a", False)
        await node_a.step()
        clock.advance(5.0)
        await node_b.step()

        config = make_config()
        controller = VacuumController(
            config,
            device=make_device(config),
            authority=FailoverExecutionAuthority(node_b),
        )
        await controller.start()
        try:
            assert controller.status().running is True
            assert controller._last_permit.holder_id == "node-b"
            assert controller._last_permit.fencing_token > old_token
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_persistent_hardware_fence_rejects_stale_terms_after_restart(tmp_path):
    state_path = tmp_path / "fencing-token.json"
    first_store = PersistentFencingTokenStore(state_path)
    first_store.accept(ExecutionPermit("node-a", 7))

    restarted_store = PersistentFencingTokenStore(state_path)
    assert restarted_store.highest_permit == ExecutionPermit("node-a", 7)
    with pytest.raises(StaleFencingToken, match="older than accepted token 7"):
        restarted_store.accept(ExecutionPermit("node-a", 6))
    with pytest.raises(StaleFencingToken, match="belongs to executor node-a"):
        restarted_store.accept(ExecutionPermit("node-b", 7))

    restarted_store.accept(ExecutionPermit("node-b", 8))
    assert PersistentFencingTokenStore(state_path).highest_permit == ExecutionPermit(
        "node-b", 8
    )


def test_remote_authority_expires_without_heartbeat_and_renews_same_term(tmp_path):
    clock = ManualClock()
    authority = RemoteExecutionAuthority(
        PersistentFencingTokenStore(tmp_path / "fencing-token.json"),
        clock=clock,
        maximum_validity=10.0,
    )

    authority.accept("node-a", 11, 5.0)
    assert authority.require() == ExecutionPermit("node-a", 11)
    clock.advance(5.0)
    with pytest.raises(AuthorityDenied, match="missing or expired"):
        authority.require()

    authority.accept("node-a", 11, 5.0)
    clock.advance(4.0)
    assert authority.require() == ExecutionPermit("node-a", 11)


def test_expired_remote_authority_blocks_device_write(tmp_path):
    async def scenario():
        clock = ManualClock()
        authority = RemoteExecutionAuthority(
            PersistentFencingTokenStore(tmp_path / "fencing-token.json"),
            clock=clock,
        )
        authority.accept("node-a", 1, 5.0)
        config = make_config()
        device = make_device(config)
        controller = VacuumController(config, device=device, authority=authority)
        await controller.start()
        try:
            clock.advance(5.0)
            history_length = len(device.history)
            with pytest.raises(AuthorityDenied, match="missing or expired"):
                await controller.set_power("TurboVacuumPump", True)
            assert len(device.history) == history_length
        finally:
            await controller.close()

    asyncio.run(scenario())
