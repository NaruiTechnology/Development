#-------------------------------------------------------------------------------
# This file contains 'Framework Code' and is licensed as such
# under the terms of your license agreement with your
# vendor. This file may not be modified, except as allowed by
# additional terms of your license agreement.
#
## @file
# Author: Henry Li
#

# This software and associated documentation (if any) is furnished
# under a license and may only be used or copied in accordance
# with the terms of the license. Except as permitted by such
# license, no part of this software or documentation may be
# reproduced, stored in a retrieval system, or transmitted in any
# form or by any means without the express written consent of
#-------------------------------------------------------------------------------
"""Per-name singleton wrapper around Python's :mod:`logging` module.

Each distinct *name* maps to exactly one ``AutomationLog`` instance, kept
in a class-level registry. Re-constructing with the same name returns
the existing instance untouched; passing a new name builds (and caches)
a fresh one with its own log file.

Two calling styles are both supported:

* **Legacy / classmethod style** (works without changing any existing
  code that pre-dates this refactor)::

      AutomationLog('myapp')                       # init at startup
      logger = AutomationLog.GetLogger('Comp')     # any caller, anywhere
      path   = AutomationLog.GetFileName()
      AutomationLog.TryAddConsole('Comp')

* **New / instance style** (preferred for code that owns multiple log
  files, e.g. a service plus a CLI)::

      logName     = 'GlasgowService'
      logInstance = AutomationLog(logName, console=True)   # one step
      logger      = logInstance.GetLogger(logName)         # already on console

  The ``console=True`` kwarg pre-creates a logger named after the
  instance and attaches an INFO-level :class:`logging.StreamHandler` to
  it -- equivalent to the explicit form below, just consolidated::

      logInstance = AutomationLog(logName)        # construct
      logInstance.GetLogger(logName)              # register the logger
      AutomationLog.TryAddConsole(logName)        # then wire console

  Both forms remain supported.  ``console`` defaults to ``False`` so
  existing call sites that pass only a name behave exactly as before.

Class-level calls route to the most recently constructed instance, which
matches the original module's behaviour when only one instance ever
existed.
"""
import logging
import os

from AutomationPy.buildingblocks.utils import InvalidArgumentException


# ---- internal: hybrid (class-or-instance) method descriptor --------------

class _hybridmethod:
    """Descriptor: the wrapped function works whether called on the
    class or on an instance.

    * ``Cls.method(...)`` -> first arg is ``Cls._default_instance(...)``
      (legacy classmethod-style entry point).  When the call carries a
      ``name`` kwarg or a leading positional name, that name is passed
      to ``_default_instance`` as a hint, so e.g.
      ``AutomationLog.GetLogger(name='X')`` lands on (and if needed
      creates) the instance keyed by ``'X'`` rather than the generic
      ``automation`` placeholder.
    * ``instance.method(...)`` -> first arg is ``instance``
      (normal method).
    """
    def __init__(self, func):
        self.func = func
        self.__doc__ = func.__doc__
        self.__name__ = func.__name__

    @staticmethod
    def _extract_name_hint(args, kwargs):
        """Best-effort: pull a logger/instance name out of the call.
        Returns ``None`` when nothing string-shaped is supplied."""
        hint = kwargs.get('name')
        if hint is None and args and isinstance(args[0], str):
            hint = args[0]
        return hint

    def __get__(self, instance, owner):
        if instance is not None:
            target = instance

            def bound(*args, **kwargs):
                return self.func(target, *args, **kwargs)
        else:
            # Defer target resolution until we see the call args, so
            # we can pass a name hint to _default_instance().
            def bound(*args, **kwargs):
                hint = self._extract_name_hint(args, kwargs)
                resolved = owner._default_instance(name_hint=hint)
                return self.func(resolved, *args, **kwargs)

        bound.__name__ = self.func.__name__
        bound.__doc__  = self.func.__doc__
        return bound


# ---- AutomationLog -------------------------------------------------------

class AutomationLog(object):
    """Per-name singleton log container.

    Each instance owns:
      * one log file: ``<n>.log`` in the current working directory,
      * one shared :class:`logging.FileHandler` writing to that file,
      * a registry of named :class:`logging.Logger` objects attached to
        the file handler,
      * the set of logger names that already have a console handler
        (so :meth:`TryAddConsole` is idempotent).
    """

    # name -> AutomationLog instance.  Lookup-or-create lives in __new__.
    _instances: dict = {}

    # Most recently constructed instance.  Backs the legacy classmethod
    # API: AutomationLog.GetLogger(...), AutomationLog.GetFileName().
    _last_created: "AutomationLog | None" = None

    # ---- lifecycle -------------------------------------------------------

    def __new__(cls, name: str = None, *args, **kwargs):
        key = name or 'automation'
        existing = cls._instances.get(key)
        if existing is not None:
            cls._last_created = existing
            return existing
        instance = super().__new__(cls)
        cls._instances[key] = instance
        cls._last_created = instance
        return instance

    def __init__(self, name: str = None, console: bool = False):
        # __new__ may have handed back an already-initialised instance;
        # __init__ still fires in that case.  We guard the heavy setup
        # with a flag, but still honour a late ``console=True`` upgrade
        # so re-constructing with the kwarg attaches the console even
        # if it wasn't requested the first time.
        if getattr(self, '_initialized', False):
            if console:
                self._attach_console()
            return
        self._initialized = True

        self._name = name or 'automation'
        self._logfile = os.path.join(os.getcwd(), f'{self._name}.log')

        self._file_handler = logging.FileHandler(self._logfile, mode='a')
        self._file_handler.setLevel(logging.DEBUG)
        self._file_handler.setFormatter(logging.Formatter(
            '%(asctime)s %(name)-12s %(levelname)-8s %(message)s',
            datefmt='%m-%d %H:%M',
        ))

        self._loggers: dict = {}             # logger-name -> logging.Logger
        self._console_attached: set = set()  # logger-names with a console handler

        if console:
            self._attach_console()

    def _attach_console(self) -> None:
        """Pre-create the logger named after this instance and wire it
        to a console handler. Idempotent -- safe to call repeatedly."""
        self.GetLogger(self._name)
        type(self).TryAddConsole(self._name)

    @classmethod
    def _default_instance(cls, name_hint: str = None) -> "AutomationLog":
        """Return the instance used for legacy classmethod-style calls.

        Resolution order:
          1. If ``name_hint`` matches an existing instance, return it.
             This makes ``AutomationLog.GetLogger(name='X')`` reach the
             instance keyed by ``'X'`` even if it isn't the most recent.
          2. The most recently constructed instance (legacy behaviour:
             ``AutomationLog('App')`` then ``AutomationLog.GetLogger(...)``
             routes to ``App``).
          3. The first instance in the registry (covers the unusual case
             where ``_last_created`` was reset but instances remain).
          4. Auto-create.  When ``name_hint`` is supplied, use it as the
             instance name (so the auto-created log file is named after
             the requested logger -- fixes the case where a caller does
             ``AutomationLog.GetLogger(name='StreamData')`` without a
             prior ``AutomationLog('StreamData')`` construction).
             Otherwise fall back to the generic ``automation`` default.
        """
        if name_hint and name_hint in cls._instances:
            return cls._instances[name_hint]
        if cls._last_created is not None:
            return cls._last_created
        if cls._instances:
            return next(iter(cls._instances.values()))
        return cls(name_hint) if name_hint else cls()

    # ---- accessors (work as classmethod OR instance method) -------------

    @_hybridmethod
    def GetFileName(self) -> str:
        return self._logfile

    @staticmethod
    def GetFormater() -> logging.Formatter:
        # Spelling preserved from the original API ("Formater", one 't').
        return logging.Formatter('%(name)-12s: %(levelname)-8s %(message)s')

    @_hybridmethod
    def GetLogger(self, name: str):
        """Return (and lazily create) a :class:`logging.Logger` named
        *name*, wired to this instance's file handler."""
        if not name:
            return None

        logger = self._loggers.get(name)
        if logger is None:
            logger = logging.getLogger(name)
            logger.setLevel(logging.DEBUG)
            # Guard against re-adding the same handler if the same
            # underlying logging.Logger is shared between AutomationLog
            # instances (logging.getLogger is itself a global singleton).
            if self._file_handler not in logger.handlers:
                logger.addHandler(self._file_handler)
            self._loggers[name] = logger
        return logger

    # ---- console handler -------------------------------------------------

    @classmethod
    def TryAddConsole(cls, logname: str) -> None:
        """Attach an INFO-level console handler to the logger named
        *logname*. Searches every live :class:`AutomationLog` instance
        to find which one owns the logger. Idempotent."""
        try:
            if not logname:
                raise InvalidArgumentException(
                    'Cannot find the log from dictionary.'
                )
            owner = cls._find_owner(logname)
            if owner is None:
                raise InvalidArgumentException(
                    'Cannot find the log from dictionary.'
                )
            if logname in owner._console_attached:
                return  # already wired up; nothing to do

            console = logging.StreamHandler()
            console.setLevel(logging.INFO)
            console.setFormatter(cls.GetFormater())
            owner._loggers[logname].addHandler(console)
            owner._console_attached.add(logname)
        except Exception as e:
            print(str(e))
            raise

    @classmethod
    def _find_owner(cls, logger_name: str):
        """Locate the :class:`AutomationLog` instance whose registry
        contains *logger_name*, or ``None`` if no instance owns it."""
        # Fast path: by convention, an instance keyed by its own name
        # also registers a logger under that same name (see the
        # instance-style usage example in the module docstring).
        candidate = cls._instances.get(logger_name)
        if candidate is not None and logger_name in candidate._loggers:
            return candidate
        for instance in cls._instances.values():
            if logger_name in instance._loggers:
                return instance
        return None

    # ---- shutdown --------------------------------------------------------

    @classmethod
    def Close(cls) -> None:
        """Close handlers on every live :class:`AutomationLog` instance
        and clear the registry. After this call, constructing
        ``AutomationLog(name)`` again rebuilds the instance from
        scratch with a fresh file handler."""
        for instance in list(cls._instances.values()):
            for logger in instance._loggers.values():
                for handler in logger.handlers[:]:
                    handler.close()
                    logger.removeHandler(handler)
            instance._loggers.clear()
            instance._console_attached.clear()
            instance._initialized = False
        cls._instances.clear()
        cls._last_created = None
