#!/usr/bin/env python3
"""Exercise the real Linux binary on loopback with isolated disposable state."""
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    build = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='tesla-smoke-') as temporary:
        work = Path(temporary)
        for binary in ('web-server', 'streamer'):
            shutil.copy2(build / binary, work / binary)
        shutil.copytree(build / 'static', work / 'static')
        # Debug binaries serve dist; release binaries serve static.
        (work / 'dist').symlink_to(work / 'static', target_is_directory=True)
        (work / 'server').mkdir()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        password = secrets.token_urlsafe(32)
        config = json.loads((ROOT / 'config/config.example.json').read_text())
        config.update(credentials=password, bind_address=f'127.0.0.1:{port}',
                      cloudflare_turn=None, streamer_path=str(work / 'streamer'))
        (work / 'server/config.json').write_text(json.dumps(config))
        base = f'http://127.0.0.1:{port}'

        def request(path, body=None, token=None):
            headers = {'Content-Type': 'application/json'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                         headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=3) as response:
                    return response.status, response.read(), response.headers
            except urllib.error.HTTPError as error:
                return error.code, error.read(), error.headers

        with (work / 'log').open('w+') as log:
            environment = dict(os.environ)
            environment.pop('COCKPIT_DISPLAY_HELPER', None)
            process = subprocess.Popen([str(work / 'web-server')], cwd=work, stdout=log, stderr=log, env=environment)
            try:
                for _ in range(100):
                    if process.poll() is not None:
                        raise AssertionError('Server exited before becoming ready')
                    try:
                        if request('/')[0] == 200:
                            break
                    except OSError:
                        pass
                    time.sleep(.1)
                else:
                    raise AssertionError('Server did not become ready')
                status, page, headers = request('/')
                assert status == 200 and b'<html' in page.lower()
                assert 'no-store' in headers['Cache-Control']
                assert request('/stream.js')[0] == 200
                assert request('/platform.js')[0] == 200
                assert request('/api/display/preset', {'preset': 'fullscreen'})[0] == 401
                assert request('/api/auth/login', {'password': 'wrong'})[0] == 401
                status, body, _ = request('/api/auth/login', {'password': password})
                assert status == 200
                token = json.loads(body)['session_token']
                for preset in ('driving', 'fullscreen', 'native'):
                    status, body, _ = request('/api/display/preset', {'preset': preset}, token)
                    assert status == 200
                    assert json.loads(body)['mode'] == 'stream-only'
                    assert json.loads(body)['display_changed'] is False
                assert request('/api/display/preset', {'preset': 'shell-command'}, token)[0] == 400
                assert request('/api/display/preset', {'preset': 'native', 'width': 1440, 'height': 1080}, token)[0] == 200
                for dimensions in ({'width': 1440}, {'width': 99999, 'height': 1080},
                                   {'width': 1439, 'height': 1080}, {'width': 0, 'height': 0}):
                    assert request('/api/display/preset', {'preset': 'native', **dimensions}, token)[0] == 400
                assert b'CLOUDFLARE_TURN_API_TOKEN' not in request('/config.js')[1]
                print('PASS: real Linux HTTP, static assets, cache, login, auth guard, all display presets and invalid input')
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        # Linux services must fail visibly rather than wait for interactive input.
        (work / 'server/config.json').write_text('{invalid json')
        result = subprocess.run([str(work / 'web-server')], cwd=work, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        assert result.returncode != 0, 'Bad config must produce a nonzero exit for systemd'
        print('PASS: invalid configuration exits nonzero')


if __name__ == '__main__':
    main()
