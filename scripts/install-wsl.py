#!/usr/bin/env python3
"""Install the complete WSL desktop, Sunshine and paired browser bridge."""
import argparse
import os
from pathlib import Path
import platform
import subprocess
import time
import urllib.error
import urllib.request

from setup import ROOT, verify_build


def wait_for(url):
    for _ in range(60):
        try:
            with urllib.request.urlopen(url, timeout=1):
                return
        except (OSError, urllib.error.URLError):
            time.sleep(1)
    raise SystemExit(f'Service did not become ready: {url}; run bash install.sh --check')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, help='Private deployment JSON; omitted for local trial')
    args = parser.parse_args()
    if platform.system() != 'Linux' or os.geteuid() == 0 or 'microsoft' not in platform.release().lower():
        parser.error('Run as your normal Ubuntu WSL2 user')
    verify_build(ROOT / 'build/runtime')

    def run(script, *arguments):
        subprocess.run(['python3', str(ROOT / 'scripts' / script), *arguments], check=True)

    run('setup-wsl-desktop.py')
    wait_for('http://127.0.0.1:47989/serverinfo')
    if args.config:
        run('setup.py', '--bridge-only', '--config', str(args.config.expanduser().resolve()))
    else:
        run('setup-local-test.py')
    wait_for('http://127.0.0.1:43780/')
    run('pair-wsl-host.py')
    print('Sunshine is paired. Open http://localhost:43780 and launch Ubuntu WSL Desktop.')
    print('For Tesla internet access, configure the HTTPS tunnel and TURN fields; see README.md.')


if __name__ == '__main__':
    main()
