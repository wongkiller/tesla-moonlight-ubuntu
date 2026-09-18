#!/usr/bin/env python3
"""Supervised service workers. Secrets are read from private files, never argv."""
import json
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime, timezone
import os
from pathlib import Path
import select
import socket
import socketserver
import subprocess
import sys
import time
import ssl
import urllib.error
import urllib.request

STATE = Path.home() / '.local/share/tesla-moonlight-ubuntu'
DESKTOP = STATE / 'wsl-desktop'


def health_logger():
    logger = logging.getLogger('readiness')
    logger.setLevel(logging.INFO)
    formatter = logging.Formatter('%(asctime)s UTC %(levelname)s %(message)s')
    formatter.converter = time.gmtime
    for handler in (logging.StreamHandler(sys.stdout), RotatingFileHandler(
            STATE / 'logs/ready.log', maxBytes=2_000_000, backupCount=2)):
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    return logger


def connection_error(error):
    if isinstance(error, urllib.error.HTTPError):
        hints = {404: 'hostname route missing or points to the wrong service',
                 502: 'Tunnel cannot reach its origin; use http://localhost:8080',
                 503: 'local web service is not ready',
                 403: 'request blocked; check Cloudflare Access or firewall rules',
                 530: 'Cloudflare cannot route to the Tunnel; check connector and DNS'}
        return f'HTTP {error.code}: {hints.get(error.code, "check origin and Cloudflare logs")}'
    reason = getattr(error, 'reason', error)
    if isinstance(reason, socket.gaierror):
        return 'DNS lookup failed: check hostname/DNS propagation; a client may cache an earlier NXDOMAIN'
    if isinstance(reason, ssl.SSLError):
        return 'TLS certificate verification failed; check hostname and Cloudflare certificate status'
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return 'Connection timed out; check network, Tunnel and origin'
    return f'Connection failed ({type(reason).__name__}); check service/network logs'


def check_web(base, expected):
    request = urllib.request.Request(base + '/_tesla/health', headers={'User-Agent': 'tesla-moonlight-ubuntu'})
    with urllib.request.urlopen(request, timeout=8) as response:
        if json.load(response).get('instance') != expected:
            raise ValueError('Hostname reaches another installation; check old connectors and the Tunnel route')
    request = urllib.request.Request(base + '/', headers={'User-Agent': 'tesla-moonlight-ubuntu'})
    with urllib.request.urlopen(request, timeout=8) as response:
        if b'Moonlight' not in response.read(131072):
            raise ValueError('HTTP page is not the Moonlight application; check origin routing')


def monitor_health(logger, hostname):
    expected = (STATE / 'server/instance-id').read_text().strip()
    previous = None
    last_message = 0
    while True:
        status = {'checked_at': datetime.now(timezone.utc).isoformat(), 'ready': False,
                  'local': False, 'public': None if not hostname else False}
        try:
            check_web('http://127.0.0.1:8080', expected)
            status['local'] = True
            if hostname:
                check_web('https://' + hostname, expected)
                status['public'] = True
            status['ready'] = True
            message = 'READY: ' + ('https://' + hostname if hostname else 'local origin') + ' serves this container and the Moonlight page'
        except (OSError, ValueError) as error:
            message = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else connection_error(error)
            message = ('PUBLIC NOT READY: ' if status['local'] else 'LOCAL NOT READY: ') + message
        status['message'] = message
        path = STATE / 'server/health-status.json'
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(status, indent=2))
        temporary.replace(path)
        if message != previous or not status['ready'] or time.monotonic() - last_message >= 300:
            (logger.info if status['ready'] else logger.error)(message)
            last_message = time.monotonic()
        previous = message
        time.sleep(30)


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
            try:
                with urllib.request.urlopen('http://127.0.0.1:43780/', timeout=2):
                    pass
            except OSError:
                self.request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                return
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
        logger = health_logger()
        logger.info('STARTING: waiting for web service and automatic Sunshine pairing')
        try:
            wait_url('http://127.0.0.1:43780/')
            subprocess.run(['python3', str(STATE / 'pair-wsl-host.py')], check=True)
            settings = json.loads((STATE / 'server/deployment.json').read_text())
            monitor_health(logger, settings.get('public_hostname'))
        except Exception as error:
            logger.error('STARTUP FAILED (%s); inspect web.log and sunshine.log. Supervisor will retry.', type(error).__name__)
            raise
    else:
        raise ValueError('Unknown service role')


if __name__ == '__main__':
    main(sys.argv[1])
