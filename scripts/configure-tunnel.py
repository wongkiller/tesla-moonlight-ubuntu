#!/usr/bin/env python3
"""Connect a provided tunnel before TURN provisioning; read its token from stdin."""
import argparse
import base64
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import uuid

from setup import TUNNEL_SERVICE, SERVICE, unit_quote, write_private


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hostname', required=True)
    parser.add_argument('--origin-port', type=int, help='Optional loopback port alias for an existing dashboard route')
    args = parser.parse_args()
    if platform.system() != 'Linux' or os.geteuid() == 0:
        parser.error('Run as the normal Ubuntu desktop user')
    if args.origin_port is not None and not 1024 <= args.origin_port <= 65535:
        parser.error('Origin port must be between 1024 and 65535')
    hostname = args.hostname
    if len(hostname) > 253 or '.' not in hostname or any(
        not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
        for label in hostname.split('.')
    ):
        parser.error('Supply a DNS hostname without scheme, path or port')
    token = sys.stdin.read().strip()
    try:
        decoded = json.loads(base64.b64decode(token, validate=True))
        uuid.UUID(decoded['t'])
        if not decoded.get('a') or not decoded.get('s'):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        parser.error('Input is not a valid Cloudflare connector token')
    binary = shutil.which('cloudflared')
    if not binary:
        parser.error('Install cloudflared first')
    home = Path.home()
    runtime = home / '.local/share/tesla-moonlight-ubuntu'
    config = json.loads((runtime / 'server/config.json').read_text())
    if not config.get('credentials'):
        parser.error('Configure web authentication before publishing a tunnel')
    private = home / '.config/tesla-moonlight-ubuntu'
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(private, 0o700)
    settings_file = private / 'internet.json'
    settings = json.loads(settings_file.read_text()) if settings_file.exists() else {
        'web_password': config['credentials'],
        'cloudflare_turn_token_id': '', 'cloudflare_turn_api_token': ''}
    settings.update(public_hostname=hostname, cloudflare_tunnel_token=token)
    write_private(settings_file, json.dumps(settings, indent=2) + '\n')
    token_file = runtime / 'server/tunnel.token'
    write_private(token_file, token + '\n')
    units = home / '.config/systemd/user'
    if args.origin_port and args.origin_port != 43780:
        proxy = Path('/usr/lib/systemd/systemd-socket-proxyd')
        if not proxy.is_file():
            parser.error('systemd-socket-proxyd is required for the origin port alias')
        write_private(units / 'tesla-moonlight-origin.socket', f'''[Unit]
Description=Loopback port for the Tesla tunnel origin
[Socket]
ListenStream=127.0.0.1:{args.origin_port}
ListenStream=[::1]:{args.origin_port}
BindIPv6Only=ipv6-only
[Install]
WantedBy=sockets.target
''')
        write_private(units / 'tesla-moonlight-origin.service', f'''[Unit]
Description=Forward the Tesla tunnel origin to the authenticated web bridge
Wants={SERVICE}
After={SERVICE}
Requires=tesla-moonlight-origin.socket
[Service]
ExecStart={unit_quote(proxy)} 127.0.0.1:43780
NoNewPrivileges=true
''')
    write_private(units / TUNNEL_SERVICE, f'''[Unit]
Description=Tesla Moonlight HTTPS tunnel
After=network-online.target {SERVICE}

[Service]
ExecStart={unit_quote(binary)} tunnel --no-autoupdate run --token-file {unit_quote(token_file)}
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
''')
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    if args.origin_port and args.origin_port != 43780:
        subprocess.run(['systemctl', '--user', 'enable', '--now', 'tesla-moonlight-origin.socket'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', TUNNEL_SERVICE], check=True)
    subprocess.run(['systemctl', '--user', 'restart', TUNNEL_SERVICE], check=True)
    print(f'Tunnel service started. Dashboard route: {hostname} -> http://localhost:{args.origin_port or 43780}')
    print(f'Private deployment settings saved: {settings_file}')
    print('TURN credentials are still required before internet streaming can be configured and tested.')


if __name__ == '__main__':
    main()
