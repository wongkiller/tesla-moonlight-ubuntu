#!/usr/bin/python3
"""Resize the private WSL Xorg desktop using a bounded RandR preset."""
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time


def refresh_sunshine_input(env):
    # Sunshine's X11 input backend retains the screen size from startup.
    # Reopen it after RandR changes, before the browser launches its new stream.
    if os.environ.get('TESLA_CONTAINER') == '1':
        command = ['supervisorctl', '-c', '/etc/tesla-moonlight-ubuntu/supervisord.conf', 'restart', 'sunshine']
    else:
        command = ['systemctl', '--user', 'restart', 'tesla-wsl-sunshine.service']
    subprocess.run(command, env=env, check=True, capture_output=True, text=True, timeout=30)
    until = time.monotonic() + 15
    while time.monotonic() < until:
        try:
            with socket.create_connection(('127.0.0.1', 47989), timeout=1):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError('Sunshine did not become ready after display resize; check sunshine.log')


def dimensions(preset, values):
    presets = {'driving': (1600, 1200), 'fullscreen': (1920, 1080), 'native': (1600, 900)}
    if preset not in presets or len(values) not in (0, 2):
        raise ValueError('Expected driving, fullscreen, or native [width height]')
    size = tuple(map(int, values)) if values and preset == 'native' else presets[preset]
    width, height = size
    if not (320 <= width <= 3840 and 240 <= height <= 2160 and width % 2 == height % 2 == 0):
        raise ValueError('Display dimensions must be even and between 320x240 and 3840x2160')
    return width, height


def main():
    width, height = dimensions(sys.argv[1], sys.argv[2:])
    state = Path(os.environ.get('TESLA_WSL_STATE', Path.home() / '.local/share/tesla-moonlight-ubuntu/wsl-desktop'))
    env = dict(os.environ, DISPLAY=':99', XAUTHORITY=str(state / 'Xauthority'))
    # An explicit display is useful for isolated integration tests.
    if os.environ.get('TESLA_DISPLAY_TEST'):
        env['DISPLAY'] = os.environ['TESLA_DISPLAY_TEST']

    def run(*args):
        return subprocess.check_output(['xrandr', *args], env=env, text=True, stderr=subprocess.PIPE, timeout=8)

    query = run('--query')
    current = re.search(r'current (\d+) x (\d+)', query)
    changed = not current or tuple(map(int, current.groups())) != (width, height)
    output = re.search(r'^(DUMMY\d+) connected', query, re.M)
    if not output:
        raise ValueError('A private Xorg dummy output is required; run bash install.sh --wsl')
    mode = f'Tesla-{width}x{height}'
    if not re.search(r'^\s+' + re.escape(mode) + r'\s', query, re.M):
        htotal, vtotal = width + 160, height + 40
        # Timings are for the virtual dummy output only, never a physical monitor.
        try:
            run('--newmode', mode, f'{htotal * vtotal * 60 / 1_000_000:.3f}',
                str(width), str(width + 48), str(width + 80), str(htotal),
                str(height), str(height + 3), str(height + 8), str(vtotal), '+HSync', '-VSync')
        except subprocess.CalledProcessError as error:
            if 'BadName' not in error.stderr:
                raise
        run('--addmode', output.group(1), mode)
    run('--output', output.group(1), '--mode', mode)
    if changed and not os.environ.get('TESLA_DISPLAY_TEST'):
        print(f'Display changed to {width}x{height}; refreshing Sunshine input coordinates', file=sys.stderr)
        refresh_sunshine_input(env)
    print(f'{width}x{height}@60')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, IndexError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from None
