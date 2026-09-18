#!/usr/bin/python3
"""Lifecycle of the isolated YouTube app; never stops a user's other browser."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

STATE = Path(__file__).resolve().parent


def control(path, body=None):
    token = (STATE / 'control.token').read_text().strip()
    request = urllib.request.Request('http://127.0.0.1:9228/' + path,
        data=json.dumps(body or {}).encode(), headers={
            'Content-Type': 'application/json', 'x-cockpit-control-token': token})
    with urllib.request.urlopen(request, timeout=4) as response:
        return json.load(response)


def cancel_cleanup():
    if os.environ.get('TESLA_CONTAINER') == '1':
        return
    subprocess.run(['systemctl', '--user', 'stop', 'tesla-youtube-pause.timer',
                    'tesla-youtube-pause.service'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main(action):
    container = os.environ.get('TESLA_CONTAINER') == '1'
    manager = ['supervisorctl', '-c', '/etc/tesla-moonlight-ubuntu/supervisord.conf']
    if action == 'launch':
        cancel_cleanup()
        if container:
            status = subprocess.run([*manager, 'status', 'youtube-browser'], capture_output=True, text=True)
            if 'RUNNING' not in status.stdout:
                subprocess.run([*manager, 'start', 'youtube-browser'], check=True)
        else:
            subprocess.run(['systemctl', '--user', 'start', 'tesla-youtube-control', 'tesla-youtube-browser'], check=True)
        for _ in range(60):
            try:
                control('attach')
                print('YouTube Remote ready')
                return
            except (OSError, urllib.error.URLError):
                time.sleep(.25)
        raise SystemExit('YouTube did not become ready; inspect tesla-youtube-browser/control journals')
    elif action == 'cleanup':
        if container:
            main('pause')
            return
        cancel_cleanup()
        subprocess.run(['systemd-run', '--user', '--collect', '--unit=tesla-youtube-pause',
                        '--on-active=15s', '/usr/bin/python3', str(STATE / 'app.py'), 'pause'], check=True)
    elif action == 'pause':
        try:
            control('control', {'action': 'pause'})
        except (OSError, urllib.error.URLError):
            pass  # Closed apps do not need cleanup.
    elif action == 'stop':
        cancel_cleanup()
        subprocess.run([*manager, 'stop', 'youtube-browser'] if container else
                       ['systemctl', '--user', 'stop', 'tesla-youtube-browser'], check=True)
    else:
        raise SystemExit('Expected launch, cleanup, pause or stop')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) == 2 else '')
