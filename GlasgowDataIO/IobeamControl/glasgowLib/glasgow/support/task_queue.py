from os import sync
import time
import asyncio
from collections import deque

import logging
logger = logging.getLogger(__name__)

__all__ = ["TaskQueue"]

class TaskQueue:
    """
    A queue of asyncio tasks that can be used for pipelining operations.

    Consider a situation where a small buffer must be emptied with a low latency.Submitting
    a single large read wouldn't meet the latency requirements, and submitting small reads in
    a loop will cause buffer overflows due to the fact that Python's runtime (and probably the OS)
    are not real-time. Submitting many small reads in sequence, and immediately resubmitting
    another read after one finishes, avoids overflow and ensures low latency.
    """
    def __init__(self):
        self._done = deque()
        self._wait_time = 0.0
        self._wait_count = 0
        self._live = set()
        self._waiters = []
        self._exception = None  # NEW: Track the hardware error

    def set_exception(self, exc):
        """NEW: Called by the Glasgow driver when LIBUSB_ERROR_IO occurs"""
        self._exception = exc
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_exception(exc)

               
    def _callback(self, future):
        self._live.remove(future)
        self._done.append(future)
        pass

    def submit(self, coro):
        """
        Submit a task to the queue. The task may return ``None`` or a Future-like object; in
        the latter case, the returned future is submitted to the queue as well.
        """
        future = asyncio.ensure_future(coro)
        self._live.add(future)
        future.add_done_callback(self._callback)

    async def cancel(self):
        """
        Cancel all tasks in the queue, and wait until cancellation is finished.

        After cancelling them, waits until all the pending tasks become finished, and then awaits
        every finished task, ignoring cancellation errors. If some of the tasks raised an exception
        before or during being cancelled, the first exception will be re-raised, and the other ones
        will be consumed.
        """
        for task in self._live:
            task.cancel()
        if self._live:
            await asyncio.wait(self._live, return_when=asyncio.ALL_COMPLETED)
        exception = None
        while self._done:
            task = self._done.popleft()
            if task.cancelled():
                continue
            if task.exception() is not None and exception is None:
                exception = task.exception()
        if exception is not None:
            raise exception

    async def poll(self):
        """
        Processes finished tasks and PROPAGATES exceptions.
        """
        had_done = bool(self._done)
        while self._done:
            task = self._done.popleft()
            # If a USBErrorIO happened, this 'await' will raise it.
            # DO NOT wrap this in a try/except that swallows the error.
            await task 
        return had_done

    async def wait_one(self):
        if self._exception:
            raise self._exception # Immediately stop if a hardware error was reported

        if not self._live and not self._done:
            raise ConnectionError("USB TaskQueue is empty.")

        if not self._done:
            await asyncio.wait(self._live, return_when=asyncio.FIRST_COMPLETED)
            
        return await self.poll()    
    
    async def wait_all(self):
            """
            Await all tasks in the queue, if any.
            """
            if self._live:
                started_at = time.monotonic()
                await asyncio.wait(self._live, return_when=asyncio.ALL_COMPLETED)
                self._wait_time += time.monotonic() - started_at
                self._wait_count += 1
            await self.poll()

    def __bool__(self):
        """Check whether there are any tasks in the queue."""
        return bool(self._live) or bool(self._done)

    def __len__(self):
        """Count tasks in the queue."""
        return len(self._live) + len(self._done)

    @property
    def total_wait_time(self):
        """Determine the total duration spent waiting for pending tasks in the queue to finish."""
        return self._wait_time

    @property
    def total_wait_count(self):
        """Determine the total number of calls to :meth:`wait_one` or :meth:`wait_all` that had
        to wait for a pending task in the queue to finish."""
        return self._wait_count
