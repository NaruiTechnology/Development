"""Prepare a separate remote-database.env handoff from source-host secrets.

Run on the source computer, then transfer the output beside
distributionDeployApp.py on the target. Never include it in a build archive.
"""
import argparse
import csv
import os
import subprocess
import tempfile

import secretsSupport


def prepare(output):
    store = secretsSupport.load()
    names = ('IOBEAM_ADMIN_CONFIG_DB_HOST', 'IOBEAM_ADMIN_CONFIG_DB_USER',
             'IOBEAM_ADMIN_CONFIG_DB_PASSWORD')
    values = {name: store.expand('${' + name + '}', strict=True) for name in names}
    output = os.path.abspath(output)
    if os.path.exists(output):
        raise RuntimeError('Output already exists; choose a new path.')
    # Restrict access before any credential is written.
    fd, temporary = tempfile.mkstemp(dir=os.path.dirname(output), prefix='.remote-db-')
    os.close(fd)
    try:
        if os.name == 'nt':
            identity = subprocess.check_output(['whoami.exe', '/user', '/fo', 'csv', '/nh'], text=True)
            sid = next(csv.reader([identity.strip()]))[1]
            subprocess.run(['icacls.exe', temporary, '/inheritance:r', '/grant:r', '*' + sid + ':F'],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        else:
            os.chmod(temporary, 0o600)
        # Write directly so atomic replacement cannot discard the restricted ACL.
        with open(temporary, 'w', encoding='utf-8') as handle:
            for name, value in values.items():
                if '\n' in value or '\r' in value:
                    raise RuntimeError('Credential contains a newline: ' + name)
                handle.write(name + '=' + store.quote(value) + '\n')
        # Refuse to overwrite an existing handoff.
        os.link(temporary, output)
    finally:
        os.unlink(temporary)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, help='Separate credential handoff path')
    args = parser.parse_args()
    try:
        print('Prepared remote database credential handoff: ' + prepare(args.output))
    except Exception as error:
        parser.exit(1, str(error) + '\n')
