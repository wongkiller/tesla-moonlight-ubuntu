#!/usr/bin/env python3
"""Run the actual container stack with a temporary local password, then stop it.

Never modifies the user's repo config, starts a Tunnel or prints credentials.
Run in a clean container before applying a real deployment config.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STATE = Path('/home/sunshine/.local/share/tesla-moonlight-ubuntu')
CONTROL = ['supervisorctl', '-c', '/etc/tesla-moonlight-ubuntu/supervisord.conf']


def main():
    password = secrets.token_urlsafe(24)
    with tempfile.TemporaryDirectory(prefix='tesla-local-test-') as directory:
        config = Path(directory) / 'local.json'
        config.write_text(json.dumps({'web_password': password, 'public_hostname': '',
            'cloudflare_turn_token_id': '', 'cloudflare_turn_api_token': '', 'cloudflare_tunnel_token': ''}))
        config.chmod(0o600)
        subprocess.run(['python3', str(ROOT / 'scripts/container-setup.py'), 'install', str(config)], check=True)
    supervisor_log = (STATE / 'logs/self-test-supervisor.log').open('a')
    process = subprocess.Popen(['supervisord', '-n', '-c', '/etc/tesla-moonlight-ubuntu/supervisord.conf'],
                               stdout=supervisor_log, stderr=subprocess.STDOUT)
    try:
        def request(path, body=None, auth=True):
            req = urllib.request.Request('http://127.0.0.1:8080' + path,
                data=json.dumps(body).encode() if body is not None else None,
                headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + password} if auth else {})})
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, response.read()

        for _ in range(120):
            if process.poll() is not None:
                raise RuntimeError('Supervisor exited; inspect self-test-supervisor.log')
            try:
                request('/_tesla/health', auth=False)
                break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError('Origin did not become ready; inspect service logs')
        try:
            request('/api/hosts', auth=False)
        except urllib.error.HTTPError as error:
            assert error.code in (401, 403), error.code
        else:
            raise RuntimeError('Anonymous protected API access was not rejected')
        for _ in range(60):
            _, data = request('/api/hosts')
            hosts = json.loads(data)['hosts']
            paired = [h for h in hosts if h.get('paired') == 'Paired']
            if paired:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Automatic Sunshine pairing failed; inspect ready.log')
        host_id = paired[0]['host_id']
        _, data = request('/api/apps?host_id=' + str(host_id))
        assert b'YouTube Remote' in data and b'Ubuntu Docker Desktop' in data
        for mode in ('driving', 'fullscreen', 'native'):
            subprocess.run(['runuser', '-u', 'sunshine', '--', 'python3', str(STATE / 'display-mode.py'), mode], check=True)
        # Use the same app lifecycle that Sunshine invokes, including the original
        # authenticated controller's attachment health check.
        app = ['runuser', '-u', 'sunshine', '--', 'env', 'TESLA_CONTAINER=1', 'python3', str(STATE / 'youtube-remote/app.py')]
        subprocess.run([*app, 'launch'], check=True, timeout=100)
        subprocess.run([*app, 'launch'], check=True, timeout=30)
        subprocess.run([*app, 'stop'], check=True, timeout=30)
        print('PASS: authenticated origin, automatic pairing, both apps, three real display sizes, sandboxed Chrome launch/relaunch/stop.', flush=True)
    finally:
        process.terminate()
        try:
            process.wait(timeout=45)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        supervisor_log.close()


if __name__ == '__main__':
    main()
