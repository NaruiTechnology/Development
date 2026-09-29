"""Install the packaged Electron scanner and enable its private API socket."""
import asyncio
import os
import tempfile

from buildingblocks.decorators import overrides
from .distributionDeploy_state import distributionDeploy_state


class installDesktopScanner_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installDesktopScanner_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            if self.isProduction():
                raise ValueError("the desktop scanner can only be installed on a local workstation")
            artifact = os.path.abspath(os.path.expanduser(str(self.deploymentValue("DesktopArtifact", ""))))
            checksum = artifact + ".sha256"
            if not artifact or not os.path.isfile(artifact) or not os.path.isfile(checksum):
                raise FileNotFoundError("desktop .deb and adjacent .sha256 file are required")
            self.info("[{}] installing {}".format(type(self).__name__, artifact))
            await self._run(["sudo", "apt-get", "install", "-y", artifact])

            await self._run(["xdg-mime", "default", "ionbeam-desktop.desktop",
                             "x-scheme-handler/ionbeam"])

            # The Glasgow device API owns acquisition. This systemd drop-in
            # enables its user-private Unix socket for the Electron transport.
            contents = "[Service]\nEnvironment=GLASGOW_DESKTOP_ENABLED=1\n"
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as stream:
                stream.write(contents)
                temporary = stream.name
            try:
                await self._run(["sudo", "install", "-d", "-m", "0755",
                                 "/etc/systemd/system/glasgow-svc.service.d"])
                await self._run(["sudo", "install", "-m", "0644", temporary,
                                 "/etc/systemd/system/glasgow-svc.service.d/desktop-scanner.conf"])
                await self._run(["sudo", "systemctl", "daemon-reload"])
            finally:
                os.unlink(temporary)
            self._success = True
        except Exception as exc:
            self.error("[{}] installation failed: {}".format(type(self).__name__, exc))
            self._success = False

    async def _run(self, command):
        self.info("[{}] >> {}".format(type(self).__name__, " ".join(command)))
        process = await asyncio.create_subprocess_exec(
            *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            cwd=self.deployRoot())
        stdout, stderr = await process.communicate()
        if stdout:
            self.info(stdout.decode(errors="replace").rstrip())
        if process.returncode:
            raise RuntimeError(stderr.decode(errors="replace").strip() or
                               "command exited {}".format(process.returncode))
