#!/usr/bin/env python3
"""Start a loopback-only WSL/Ubuntu bridge with a generated local password."""
import json
from pathlib import Path
import secrets
import subprocess

from setup import ROOT, write_private


def main():
    runtime = Path.home() / '.local/share/tesla-moonlight-ubuntu'
    existing = runtime / 'server/config.json'
    tunnel_unit = Path.home() / '.config/systemd/user/tesla-moonlight-tunnel.service'
    if tunnel_unit.exists() or (existing.exists() and json.loads(existing.read_text()).get('external_url')):
        raise SystemExit('An internet deployment already exists; refusing to replace it with local test settings.')
    settings_file = Path.home() / '.config/tesla-moonlight-ubuntu/local-test.json'
    if not settings_file.exists():
        settings = json.loads((ROOT / 'config/install.example.json').read_text())
        settings['web_password'] = secrets.token_urlsafe(24)
        write_private(settings_file, json.dumps(settings, indent=2) + '\n')
    subprocess.run(['python3', str(ROOT / 'scripts/setup.py'), '--bridge-only', '--config', str(settings_file)], check=True)
    print(f'Generated password is stored in {settings_file} (web_password).')
    print('Local test only: http://localhost:43780. No public tunnel was enabled.')


if __name__ == '__main__':
    main()
