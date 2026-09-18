#!/usr/bin/env python3
"""Run the real installer twice in an isolated HOME and preserve private state."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='tesla-install-') as temporary:
        home = Path(temporary)
        runtime = home / 'runtime with spaces'
        config = home / 'install.json'
        settings = json.loads((ROOT / 'config/install.example.json').read_text())
        settings['web_password'] = secrets.token_urlsafe(32)
        config.write_text(json.dumps(settings))
        env = dict(os.environ, HOME=str(home))
        command = ['python3', str(ROOT / 'scripts/setup.py'), '--bridge-only', '--no-start',
                   '--config', str(config), '--prefix', str(runtime)]
        subprocess.run(command, env=env, check=True, stdout=subprocess.DEVNULL)
        state = runtime / 'server'
        (state / 'data.json').write_text('{"preserve":"pairing-data"}')
        (state / 'sessions.json').write_text('{"preserve":"sessions"}')
        configured = json.loads((state / 'config.json').read_text())
        configured['totp_secret'] = 'PRESERVED_TEST_SECRET'
        (state / 'config.json').write_text(json.dumps(configured))
        subprocess.run(command, env=env, check=True, stdout=subprocess.DEVNULL)
        assert json.loads((state / 'config.json').read_text())['totp_secret'] == 'PRESERVED_TEST_SECRET'
        assert json.loads((state / 'data.json').read_text())['preserve'] == 'pairing-data'
        assert json.loads((state / 'sessions.json').read_text())['preserve'] == 'sessions'
        assert (state / 'config.json').stat().st_mode & 0o777 == 0o600
        assert (state / 'service.env').stat().st_mode & 0o777 == 0o600
        assert state.stat().st_mode & 0o777 == 0o700
        unit = home / '.config/systemd/user/tesla-moonlight-web.service'
        verification = subprocess.run(['systemd-analyze', '--user', 'verify', str(unit)], check=True,
                                      capture_output=True, text=True)
        assert str(unit) not in verification.stderr, verification.stderr
        print('PASS: installer repeat run, spaced paths, systemd unit verification, private permissions and pairing/TOTP preservation')


if __name__ == '__main__':
    main()
