#!/usr/bin/env python3
"""Supervised service workers. Secrets are read from private files, never argv."""
import json
import os
from pathlib import Path
import select
import socket
import socketserver
import subprocess
import sys
import time
import urllib.request

STATE = Path.home() / '.local/share/tesla-moonlight-ubuntu'
DESKTOP = STATE / 'wsl-desktop'


def environment():
    os.environ.pop('WAYLAND_DISPLAY', None)
    os.environ.update(DISPLAY=':99', XAUTHORITY=str(DESKTOP / 'Xauthority'),
        PULSE_SERVER='unix:' + str(DESKTOP / 'pulse.sock'), PULSE_COOKIE=str(DESKTOP / 'pulse.cookie'),
        PULSE_SINK='tesla_wsl', XDG_SESSION_TYPE='x11', XDG_CURRENT_DESKTOP='XFCE',
        GDK_BACKEND='x11', QT_QPA_PLATFORM='xcb', SDL_VIDEODRIVER='x11', MOZ_ENABLE_WAYLAND='0',
        XDG_CONFIG_HOME=str(DESKTOP / 'config'), XDG_CACHE_HOME=str(DESKTOP / 'cache'),
        XDG_DATA_HOME=str(DESKTOP / 'data'), XDG_RUNTIME_DIR=str(STATE / 'run'),
        DBUS_SESSION_BUS_ADDRESS='unix:path=' + str(STATE / 'run/bus'),
        TESLA_WSL_STATE=str(DESKTOP), TESLA_CONTAINER='1',
        TESLA_HOST_NAME='Ubuntu 26.04 Docker Desktop',
        COCKPIT_DISPLAY_HELPER=str(DESKTOP / 'display-mode.py'),
        COCKPIT_YOUTUBE_CONTROL_TOKEN_FILE=str(STATE / 'youtube-remote/control.token'))


def wait_url(url, timeout=120):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except OSError:
            time.sleep(1)
    raise RuntimeError('Dependency did not become ready: ' + url)


def wait_display():
    for _ in range(120):
        if subprocess.run(['xdpyinfo'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError('X11 did not become ready; check x11.log')


def run(*args):
    os.execvp(str(args[0]), [str(a) for a in args])


class Origin(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(30)
        first = self.request.recv(65536)
        if first.startswith(b'GET /_tesla/health '):
            body = json.dumps({'instance': (STATE / 'server/instance-id').read_text().strip()}).encode()
            self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
            return
        try:
            with socket.create_connection(('127.0.0.1', 43780), timeout=10) as upstream:
                upstream.sendall(first)
                self.request.settimeout(None)
                upstream.settimeout(None)
                while True:
                    readable, _, _ = select.select([self.request, upstream], [], [], 300)
                    if not readable:
                        return
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.request else self.request).sendall(data)
        except (OSError, TimeoutError):
            return


class OriginServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main(role):
    environment()
    if role == 'dbus':
        (STATE / 'run/bus').unlink(missing_ok=True)
        run('dbus-daemon', '--session', '--nofork', '--nopidfile', '--address=' + os.environ['DBUS_SESSION_BUS_ADDRESS'])
    elif role == 'x11':
        run('/usr/lib/xorg/Xorg', ':99', '-config', DESKTOP / 'xorg.conf', '-logfile', DESKTOP / 'Xorg.log',
            '-nolisten', 'tcp', '-noreset', '-novtswitch', '-sharevts', '-auth', DESKTOP / 'Xauthority')
    elif role == 'audio':
        (DESKTOP / 'pulse.sock').unlink(missing_ok=True)
        run('pulseaudio', '-n', '--daemonize=no', '--use-pid-file=no', '--exit-idle-time=-1', '--log-target=stderr', '-F', DESKTOP / 'pulse.pa')
    elif role == 'desktop':
        run('bash', STATE / 'start-wsl-desktop.sh')
    elif role == 'sunshine':
        wait_display()
        for _ in range(120):
            if subprocess.run(['pactl', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(1)
        run('sunshine', DESKTOP / 'sunshine/sunshine.conf')
    elif role == 'web':
        wait_url('http://127.0.0.1:47989/serverinfo')
        settings = json.loads((STATE / 'server/deployment.json').read_text())
        os.environ['CLOUDFLARE_TURN_API_TOKEN'] = settings.get('cloudflare_turn_api_token', '')
        os.chdir(STATE)
        run(STATE / 'web-server')
    elif role == 'origin':
        wait_url('http://127.0.0.1:43780/')
        with OriginServer(('0.0.0.0', 8080), Origin) as server:
            server.serve_forever()
    elif role == 'youtube-control':
        run('node', STATE / 'youtube-remote/exit-server.js', STATE / 'youtube-remote/control.token', STATE / 'youtube-remote/stop.sh')
    elif role == 'youtube-browser':
        wait_display()
        run('google-chrome', '--user-data-dir=' + str(STATE / 'youtube-remote/profile'),
            '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9227',
            '--remote-allow-origins=http://127.0.0.1:9227', '--ozone-platform=x11',
            '--app=https://www.youtube.com/', '--start-fullscreen', '--no-first-run',
            '--no-default-browser-check', '--disable-session-crashed-bubble', '--disable-background-mode',
            '--force-device-scale-factor=1.25', '--disable-gpu', '--disable-quic')
    elif role == 'tunnel':
        wait_url('http://127.0.0.1:8080/')
        run('cloudflared', 'tunnel', '--no-autoupdate', 'run', '--token-file', STATE / 'server/tunnel.token')
    elif role == 'ready':
        wait_url('http://127.0.0.1:43780/')
        subprocess.run(['python3', str(STATE / 'pair-wsl-host.py')], check=True)
        settings = json.loads((STATE / 'server/deployment.json').read_text())
        hostname = settings.get('public_hostname')
        if hostname:
            expected = (STATE / 'server/instance-id').read_text().strip()
            for _ in range(60):
                try:
                    request = urllib.request.Request(f'https://{hostname}/_tesla/health', headers={'User-Agent': 'tesla-moonlight-ubuntu'})
                    with urllib.request.urlopen(request, timeout=5) as response:
                        if json.load(response).get('instance') == expected:
                            print(f'READY: https://{hostname} reaches this container.', flush=True)
                            return
                except (OSError, ValueError):
                    pass
                time.sleep(5)
            raise RuntimeError('Local services are ready, but hostname does not reach this container. Check Tunnel route -> http://localhost:8080, DNS, and old connectors sharing the token.')
        print('READY: local container desktop and YouTube Remote are paired.', flush=True)
    else:
        raise ValueError('Unknown service role')


if __name__ == '__main__':
    main(sys.argv[1])
