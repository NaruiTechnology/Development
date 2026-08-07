import asyncio

from glasgow_service.coordination import InMemoryLeaseCoordinator, ManualClock
from glasgow_service.executor_lifecycle import ExecutorState
from glasgow_service.failover_executor import FailoverExecutor


def make_cluster(*, ttl=5.0):
    clock = ManualClock()
    coordinator = InMemoryLeaseCoordinator(clock)
    node_a = FailoverExecutor("node-a", coordinator, lease_ttl=ttl, clock=clock)
    node_b = FailoverExecutor("node-b", coordinator, lease_ttl=ttl, clock=clock)
    return clock, coordinator, node_a, node_b


def test_only_one_of_two_executors_becomes_active():
    async def scenario():
        _clock, coordinator, node_a, node_b = make_cluster()
        await node_a.start()
        await node_b.start()
        await asyncio.gather(node_a.step(), node_b.step())
        active = [node for node in (node_a, node_b) if node.may_execute]
        assert len(active) == 1
        assert (await coordinator.current_lease()).holder_id == active[0].instance_id

    asyncio.run(scenario())


def test_standby_takes_over_after_hung_leader_lease_expires():
    async def scenario():
        clock, coordinator, node_a, node_b = make_cluster()
        await node_a.start()
        await node_b.start()
        await node_a.step()
        await node_b.step()
        assert node_a.may_execute is True
        first_token = node_a.lease.fencing_token

        clock.advance(5.0)
        assert node_a.may_execute is False
        await node_b.step()
        assert node_b.may_execute is True
        assert node_b.lease.fencing_token > first_token
        assert (await coordinator.current_lease()).holder_id == "node-b"

    asyncio.run(scenario())


def test_partitioned_leader_fences_immediately_and_cannot_release_successor():
    async def scenario():
        clock, coordinator, node_a, node_b = make_cluster()
        await node_a.start()
        await node_b.start()
        await node_a.step()
        old_token = node_a.lease.fencing_token

        coordinator.set_reachable("node-a", False)
        await node_a.step()
        assert node_a.lifecycle.state is ExecutorState.FENCED
        assert node_a.may_execute is False

        clock.advance(5.0)
        await node_b.step()
        assert node_b.may_execute is True
        assert node_b.lease.fencing_token > old_token

        coordinator.set_reachable("node-a", True)
        assert await coordinator.renew("node-a", old_token, 5.0) is None
        assert await coordinator.release("node-a", old_token) is False
        assert (await coordinator.current_lease()).holder_id == "node-b"

    asyncio.run(scenario())


def test_continuous_run_loop_stops_cleanly():
    async def scenario():
        clock = ManualClock()
        coordinator = InMemoryLeaseCoordinator(clock)
        node = FailoverExecutor(
            "node-a",
            coordinator,
            lease_ttl=1.0,
            poll_interval=0.01,
            clock=clock,
        )
        stop_event = asyncio.Event()
        task = asyncio.create_task(node.run(stop_event))
        for _ in range(10):
            await asyncio.sleep(0)
            if node.may_execute:
                break
        assert node.may_execute is True

        stop_event.set()
        await task
        assert node.lifecycle.state is ExecutorState.STOPPED
        assert node.may_execute is False
        assert await coordinator.current_lease() is None

    asyncio.run(scenario())


def test_recovered_fenced_node_returns_to_standby_without_preempting_leader():
    async def scenario():
        clock, coordinator, node_a, node_b = make_cluster()
        await node_a.start()
        await node_b.start()
        await node_a.step()
        coordinator.set_reachable("node-a", False)
        await node_a.step()
        clock.advance(5.0)
        await node_b.step()
        coordinator.set_reachable("node-a", True)
        await node_a.step()
        assert node_a.lifecycle.state is ExecutorState.STANDBY
        assert node_a.may_execute is False
        assert node_b.may_execute is True

    asyncio.run(scenario())


def test_clean_stop_releases_lease_for_immediate_takeover():
    async def scenario():
        _clock, coordinator, node_a, node_b = make_cluster()
        await node_a.start()
        await node_b.start()
        await node_a.step()
        first_token = node_a.lease.fencing_token
        await node_a.stop()
        assert node_a.lifecycle.state is ExecutorState.STOPPED
        assert node_a.may_execute is False
        await node_b.step()
        assert node_b.may_execute is True
        assert node_b.lease.fencing_token > first_token
        assert (await coordinator.current_lease()).holder_id == "node-b"

    asyncio.run(scenario())

