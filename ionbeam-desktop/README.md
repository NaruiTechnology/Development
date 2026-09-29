# Ion Beam Desktop Scanner

The desktop app packages the scan control page inside an Electron window. It
uses a local Node API on `127.0.0.1:14000` for authorization and scan records,
and a private Unix socket to stream acquisition samples from the Glasgow
device service. The device service remains the owner of hardware acquisition.

On an x64 Ubuntu build machine with Node.js, npm, and `dpkg-deb` installed:

```bash
python3 Scripts/build-desktop.py
```

The installable package and SHA-256 file are written to
`ionbeam-desktop/release/`. Build with `--install-deps` to install the locked
Node dependencies first.

To install on a local instrument workstation, run:

```bash
python3 Scripts/deploy-desktop.py
```

This builds the complete distribution with the desktop API and scanner package,
then runs the standard deployment workflow. It installs the package, registers
`ionbeam://` links for the current user, enables the Glasgow service's private
scanner socket, and restarts the local services. Subsequent
`Development/Scripts/manage-local-system.sh restart` calls preserve that socket
setting as long as the desktop package remains installed. The desktop API reads its configuration from
`~/IobeamPlatform/Development/ionbeam-web/backend/.env`; set
`IONBEAM_SITE_ROOT` in the user's `desktop.env` when the platform is installed
elsewhere. A link such as `ionbeam://scan?mode=vector` opens the desktop UI in
the requested scan tab. It never starts acquisition by itself.
