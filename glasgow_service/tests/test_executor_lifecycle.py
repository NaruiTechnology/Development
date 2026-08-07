import pytest

from glasgow_service.executor_lifecycle import (
    ExecutorLifecycle,
    ExecutorState,
    InvalidExecutorTransition,
)


def test_executor_requires_new_positive_fencing_token_for_each_active_term():
    lifecycle = ExecutorLifecycle()
    lifecycle.transition(ExecutorState.STANDBY)
    with pytest.raises(InvalidExecutorTransition, match="positive fencing token"):
        lifecycle.transition(ExecutorState.ACTIVE)

    lifecycle.transition(ExecutorState.ACTIVE, fencing_token=7)
    assert lifecycle.may_execute is True
    lifecycle.transition(ExecutorState.FENCED)
    assert lifecycle.may_execute is False
    lifecycle.transition(ExecutorState.STANDBY)

    with pytest.raises(InvalidExecutorTransition, match="newer fencing token"):
        lifecycle.transition(ExecutorState.ACTIVE, fencing_token=7)
    lifecycle.transition(ExecutorState.ACTIVE, fencing_token=8)
    assert lifecycle.may_execute is True


def test_executor_never_executes_while_draining_or_fenced():
    lifecycle = ExecutorLifecycle()
    lifecycle.transition(ExecutorState.STANDBY)
    lifecycle.transition(ExecutorState.ACTIVE, fencing_token=1)
    lifecycle.transition(ExecutorState.DRAINING)
    assert lifecycle.may_execute is False
    lifecycle.transition(ExecutorState.FENCED)
    assert lifecycle.may_execute is False


def test_executor_rejects_unsafe_transition():
    lifecycle = ExecutorLifecycle()
    with pytest.raises(InvalidExecutorTransition, match="starting to active"):
        lifecycle.transition(ExecutorState.ACTIVE, fencing_token=1)

