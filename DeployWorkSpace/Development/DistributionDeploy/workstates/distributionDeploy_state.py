#-------------------------------------------------------------------------------
# distributionDeploy_state.py
#
# Abstract base class for all DistributionDeploy work-states.
# Mirrors LoadFPGAImage/workstates/loadFpgaImage_state.py.
#
# Concrete states either:
#   1. Subclass executeShellCommand_state (which itself derives from this) and
#      drive the action purely off the JSON 'commandFormat' template, OR
#   2. Subclass this base directly and override DoWork() when the step
#      requires custom branching, iteration, or in-process logic that can't
#      be captured by a single shell template.
#-------------------------------------------------------------------------------
from abc import abstractmethod
import copy
import os
import shlex
import asyncio

from buildingblocks.workflow.workstate import WorkState

import secretsSupport


@abstractmethod
class distributionDeploy_state(WorkState):
    """Abstract base for every DistributionDeploy work-state."""

    def __init__(self, parent):
        super(distributionDeploy_state, self).__init__(parent)
        # populated by the thread's IntialWork() right after construction
        self._config = None
        self._logger = None

    # ---- attributes assigned by the parent thread ------------------------
    @property
    def Config(self):
        return self._config

    @Config.setter
    def Config(self, val):
        self._config = val

    @property
    def Logger(self):
        return self._logger

    @Logger.setter
    def Logger(self, val):
        self._logger = val

    # ---- helpers used by every concrete state ----------------------------
    def aptInstallCommand(self, packages, verify):
        """Build a noninteractive, labelled package repair/install sequence."""
        apt = ("sudo -n DEBIAN_FRONTEND=noninteractive apt-get "
               "-o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef "
               "-o Dpkg::Options::=--force-confold")
        configure = ("sudo -n DEBIAN_FRONTEND=noninteractive dpkg "
                     "--force-confdef --force-confold --configure -a")
        return (
            "deploy_step() {{ label=$1; shift; "
            "echo \"Deployment package step: $label\"; \"$@\"; result=$?; "
            "if [ $result -ne 0 ]; then "
            "echo \"Deployment package step failed: $label (exit $result)\" >&2; fi; "
            "return $result; }}; "
            "deploy_step sudo-credential sudo -n true && "
            # Interrupted dpkg must be configured before apt can run. Missing
            # dependencies may make this fail; apt repair must still get a turn.
            "{{ deploy_step dpkg-configure {configure} || "
            "echo 'dpkg configuration incomplete; attempting apt dependency repair' >&2; }} && "
            "deploy_step apt-update {apt} update && "
            "deploy_step apt-repair {apt} --fix-broken install -y && "
            "deploy_step dpkg-configure-after-repair {configure} && "
            "deploy_step apt-install {apt} install -y --no-install-recommends {packages} && "
            "deploy_step verify-packages sh -c {verify}"
        ).format(apt=apt, configure=configure,
                 packages=" ".join(shlex.quote(str(p)) for p in packages),
                 verify=shlex.quote(verify))

    def deployRoot(self):
        """Return the deploy root directory configured for this run."""
        thread = self.ParentWorkThread
        if thread is not None and hasattr(thread, "deployRoot"):
            return thread.deployRoot
        return "."

    async def runArguments(self, arguments, timeout, env=None):
        """Run an argument vector without platform-dependent shell quoting."""
        process = await asyncio.create_subprocess_exec(
            *arguments, cwd=self.deployRoot(), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            self._stdout, self._stderr = await asyncio.wait_for(
                process.communicate(), timeout=timeout or None)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            process.kill()
            self._stdout, self._stderr = await process.communicate()
            self._returncode = process.returncode
            raise
        self._returncode = process.returncode
        return process.returncode == 0

    def workRoot(self):
        """Return the DistributionDeploy working directory for this run."""
        thread = self.ParentWorkThread
        if thread is not None and hasattr(thread, "workRoot"):
            return thread.workRoot
        return os.getcwd()

    def deploymentConfig(self):
        """Return the top-level Deployment block with ${VAR} secrets resolved."""
        return self.expandSecrets(self.rawDeploymentConfig())

    def rawDeploymentConfig(self):
        """Return the Deployment block exactly as written in the manifest."""
        thread = self.ParentWorkThread
        config = getattr(thread, "Config", None) if thread is not None else None
        if isinstance(config, dict):
            deployment = config.get("Deployment", {})
        else:
            deployment = getattr(config, "Deployment", {}) if config is not None else {}
        return deployment if isinstance(deployment, dict) else {}

    def secretStore(self):
        """The shared secretstore module (see secretsSupport.py)."""
        return secretsSupport.load()

    def expandSecrets(self, value):
        """Resolve ${VAR} placeholders from the environment / secrets file.

        Unresolved required placeholders become "" so a state falls back to
        its normal defaults; provisionSecrets has already failed the run if a
        required value is missing.
        """
        return self.secretStore().expand(value, strict=False, blank=True)

    def deploymentValue(self, key, default=None):
        """Read a value from the top-level Deployment block."""
        return self.deploymentConfig().get(key, default)

    def isProduction(self):
        """Return the workflow-wide production flag."""
        thread = self.ParentWorkThread
        if thread is not None and hasattr(thread, "_isProduction"):
            return bool(thread._isProduction)
        return bool(self.deploymentValue("IsProduction", False))

    def resolvedStateConfig(self, stateConfig):
        """Return a copy of the action config with production overrides applied."""
        if not isinstance(stateConfig, dict):
            return stateConfig

        # ${VAR} secrets stay unresolved here: they are expanded only where
        # used (deploymentConfig, resolveEnvValue) so a credential is never
        # copied into a command line or a log message by accident.
        resolved = copy.deepcopy(stateConfig)
        actionData = resolved.get("actionData", {})
        if not isinstance(actionData, dict):
            return resolved

        productionConfig = actionData.pop("ProductionConfig", {}) or {}
        if self.isProduction():
            resolved["actionData"] = self._mergeProductionConfig(actionData, productionConfig)
        else:
            resolved["actionData"] = actionData
        return resolved

    def resolvedActionData(self, stateConfig):
        """Return the actionData block with production overrides applied."""
        resolved = self.resolvedStateConfig(stateConfig)
        if not isinstance(resolved, dict):
            return {}
        actionData = resolved.get("actionData", {})
        return actionData if isinstance(actionData, dict) else {}

    def _mergeProductionConfig(self, base, override):
        if not isinstance(base, dict):
            return copy.deepcopy(override) if isinstance(override, dict) else base
        merged = copy.deepcopy(base)
        if not isinstance(override, dict):
            return merged
        for key, value in override.items():
            if value in (None, "", [], {}):
                continue
            current = merged.get(key)
            if isinstance(current, dict) and isinstance(value, dict):
                merged[key] = self._mergeProductionConfig(current, value)
            else:
                merged[key] = copy.deepcopy(value)
        return merged

    def resolveWorkPath(self, path):
        """Resolve a JSON path relative to the DistributionDeploy folder."""
        if not path:
            return path
        expanded = os.path.expanduser(str(path))
        if os.path.isabs(expanded):
            return os.path.abspath(expanded)
        return os.path.abspath(os.path.join(self.workRoot(), expanded))

    def resolveDeployPath(self, path):
        """Resolve a JSON path relative to the configured deploy root."""
        if not path:
            return path
        expanded = os.path.expanduser(str(path))
        if os.path.isabs(expanded):
            return os.path.abspath(expanded)
        return os.path.abspath(os.path.join(self.deployRoot(), expanded))

    def resolveEnvValue(self, value):
        """Resolve path-like env values; lists become os.pathsep-separated."""
        value = self.expandSecrets(value)
        if isinstance(value, dict):
            raw = value.get("value", "")
            if value.get("resolve", True):
                return self.resolveEnvValue(raw)
            return raw
        if isinstance(value, (list, tuple)):
            return os.pathsep.join(self.resolveDeployPath(v) for v in value)
        if isinstance(value, str) and value and not value.startswith(("http://", "https://", "ws://", "wss://")):
            return self.resolveDeployPath(value)
        return value

    def info(self, msg):
        if self._logger is not None:
            self._logger.info(msg)
        else:
            print(msg)

    def warn(self, msg):
        if self._logger is not None:
            self._logger.warning(msg)
        else:
            print("WARN: " + msg)

    def error(self, msg):
        if self._logger is not None:
            self._logger.error(msg)
        else:
            print("ERROR: " + msg)
