#-------------------------------------------------------------------------------
# provisionSecrets_state.py
#
# Create or complete the owner-only secrets file every Iobeam component reads
# credentials from (see Development/secretstore), without asking the
# installer anything. Runs right after stopLocalSystem and BEFORE
# createDeployFolder deletes DeployRoot, so values can still be carried over
# from the installation being replaced.
#
# Where values come from, first match wins:
#   1. a prepared file passed with  distributionDeployApp.py --secrets-file F
#      (or actionData.secretsSeedFile) -- replaces stored values
#   2. the existing secrets file (kept across deployments)
#   3. the deploy shell's environment (export NAME=...)
#   4. what earlier releases left on this host:
#        - the installation in DeployRoot (JSON files, backend .env)
#        - DeployWorkspace_* handoff archives / folders of earlier releases
#          next to this one, in ~ , ~/Downloads and /tmp (deploy manifest
#          and dist_app.zip)
#        - ~/.bashrc  (export GLASGOW_TOKEN=... appended by exportEnv)
#        - /etc/glasgow-svc.env
#   5. generated: GLASGOW_TOKEN, the local runtime DB password
#   6. only if actionData.prompt is true and stdin is a terminal: a prompt
#
# A value that is still unknown does not stop the deployment: the
# installation runs without it (local admin database, FTP upload off) and the
# log ends with a summary of what is not configured and how to set it later.
# No secret value is ever logged.
#-------------------------------------------------------------------------------
import os
import tempfile
import subprocess
import sys

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state

ENV_SEED_FILE = "IOBEAM_SECRETS_SEED"
TRACE_FILES = ("~/.bashrc", "/etc/glasgow-svc.env")


class provisionSecrets_state(distributionDeploy_state):
    def __init__(self, parent):
        super(provisionSecrets_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        self._success = False
        name = type(self).__name__
        try:
            store = self.secretStore()
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            secretsFile = actionData.get("secretsFile") or ""
            secretsFile = (os.path.abspath(os.path.expanduser(secretsFile))
                           if secretsFile else store.default_secrets_path())
            # Later states, child processes and manage-local-system.sh must
            # all agree on the location.
            os.environ[store.ENV_SECRETS_FILE] = secretsFile
            variables = actionData.get("variables") or store.VARIABLES

            self.info("[{}] secrets file: {} ({})".format(
                name, secretsFile, "exists" if os.path.isfile(secretsFile) else "will be created"))

            seed = None
            seedFile = os.environ.get(ENV_SEED_FILE) or actionData.get("secretsSeedFile") or ""
            if seedFile:
                seedFile = os.path.abspath(os.path.expanduser(seedFile))
                seed = store.read_seed(seedFile)
                self.info("[{}] using {} value(s) from {}".format(name, len(seed), seedFile))

            harvested = {}
            if actionData.get("harvestFromDeployRoot", True):
                harvested = self._harvestEverything(store, variables, secretsFile, seed or {})

            ask = None
            if actionData.get("prompt", False) and sys.stdin.isatty():
                ask = store.prompt

            result = store.provision(secretsFile, variables, seed=seed, harvested=harvested, ask=ask)
            for variable in sorted(result.sources):
                self.info("[{}] {} <- {}".format(name, variable, result.sources[variable]))
            if result.written:
                self.info("[{}] wrote {} value(s) to {} (mode 600)".format(
                    name, len(result.written), secretsFile))

            missing = list(result.missing)
            missing += [v for v in store.missing(self._deploymentBlock(), secretsFile) if v not in missing]
            if missing:
                self.error("[{}] required credentials are missing: {}. Nothing was removed. "
                           "Provide them with --secrets-file FILE or export them, then rerun."
                           .format(name, ", ".join(missing)))
                return

            store.load_into_environ(secretsFile)
            self._reportUnconfigured(store, variables, secretsFile)
            self._success = True
        except KeyboardInterrupt:
            self.error("[{}] cancelled; nothing was removed. Values gathered so far are kept in "
                       "the secrets file.".format(name))
            self._success = False
        except EOFError:
            self.error("[{}] the terminal closed before every value was entered; nothing was "
                       "removed. Values entered so far are kept.".format(name))
            self._success = False
        except Exception as e:
            self.error("[{}] error: {}".format(name, e))
            self._success = False

    # -- sources -----------------------------------------------------------------
    def _harvestEverything(self, store, variables, secretsFile, seed):
        """Values earlier releases left on this host, in priority order."""
        # Every credential name an earlier release could have used, not only
        # the provisioned variables (runtime / operation DB logins, SMTP...).
        wanted = ({str(v["name"]) for v in variables} | set(store.LEGACY_ENV_KEYS)
                  | {name for _, _, name in store.SECRET_BINDINGS if not name.endswith("_URL")})
        current = store.read_file(secretsFile)

        def needed():
            return {n for n in wanted if not current.get(n) and not seed.get(n)
                    and not os.environ.get(n) and n not in harvested}

        harvested = {}

        def take(label, values):
            new = {k: v for k, v in values.items() if k in needed()}
            harvested.update(new)
            if new:
                self.info("[{}] carried over {} value(s) from {}".format(
                    type(self).__name__, len(new), label))

        development = self.resolveDeployPath("Development")
        if os.path.isdir(development):
            take("the installation at {}".format(development), store.harvest(development))
        else:
            self.info("[{}] no previous installation at {}".format(type(self).__name__, development))

        if needed():
            for handoff in store.find_handoffs(self._handoffSearchDirs()):
                if not needed():
                    break
                take("earlier release archive {}".format(handoff), store.harvest_handoff(handoff))

        if needed():
            for trace in TRACE_FILES:
                text = self._readTrace(os.path.expanduser(trace))
                if text:
                    take(trace, store.assignments(text))
        return harvested

    def _handoffSearchDirs(self):
        dirs = []
        work = os.path.abspath(self.workRoot())
        # workRoot is <handoff>/DeployWorkSpace/Development: look beside the
        # folder the current archive was extracted into.
        parts = work.split(os.sep)
        if "DeployWorkSpace" in parts:
            handoff = os.sep.join(parts[:parts.index("DeployWorkSpace")]) or os.sep
            dirs += [handoff, os.path.dirname(handoff)]
        home = os.path.expanduser("~")
        dirs += [home, os.path.join(home, "Downloads"), tempfile.gettempdir()]
        return [d for d in dict.fromkeys(dirs) if os.path.isdir(d)]

    def _readTrace(self, path):
        if not os.path.isfile(path):
            return ""
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return handle.read()
        except PermissionError:
            result = subprocess.run(["sudo", "-n", "cat", path], capture_output=True, text=True)
            return result.stdout if result.returncode == 0 else ""
        except OSError:
            return ""

    # -- reporting ---------------------------------------------------------------
    def _reportUnconfigured(self, store, variables, secretsFile):
        unset = [v for v in store.unresolved_variables(variables, secretsFile) if v.get("unset")]
        if not unset:
            self.info("[{}] all credentials are configured".format(type(self).__name__))
            return
        effects = {}
        for variable in unset:
            effects.setdefault(variable["unset"], []).append(variable["name"])
        lines = ["Not configured (no value found on this host; the deployment continues):"]
        for effect, names in effects.items():
            lines.append("  - {}: {}".format(", ".join(names), effect))
        lines += [
            "Set them later without redeploying: in the web app (Settings > Admin > Database or",
            "FTP), or with  python3 -m secretstore set NAME  from DistributionDeploy/vendor,",
            "then  Development/Scripts/manage-local-system.sh restart .",
        ]
        self.warn("[{}] {}".format(type(self).__name__, "\n".join(lines)))

    def _deploymentBlock(self):
        """The manifest's Deployment block, as written (placeholders intact)."""
        deployment = self.rawDeploymentConfig()
        if deployment:
            return deployment
        deployment = getattr(self.Config, "Deployment", None)
        return deployment if isinstance(deployment, dict) else {}
