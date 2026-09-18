#!/usr/bin/env python3
"""Install a user-scoped Ubuntu bridge without overwriting pairings or host config."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'tesla-moonlight-web.service'
TUNNEL_SERVICE = 'tesla-moonlight-tunnel.service'


def write_private(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(content)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate(settings):
    expected = {'public_hostname', 'web_password', 'cloudflare_turn_token_id',
                'cloudflare_turn_api_token', 'cloudflare_tunnel_token'}
    if not isinstance(settings, dict) or set(settings) - expected:
        raise ValueError('Unknown configuration keys; use config/install.example.json')
    if any(not isinstance(value, str) or any(c in value for c in '\n\r\x00')
           for value in settings.values()):
        raise ValueError('Settings must be single-line strings')
    password = settings.get('web_password', '')
    if len(password) < 16 or 'CHANGE_ME' in password:
        raise ValueError('Set a unique web_password of at least 16 characters')
    hostname = settings.get('public_hostname', '')
    if hostname and (len(hostname) > 253 or '.' not in hostname or
                     any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
                         for label in hostname.split('.'))):
        raise ValueError('public_hostname must be a DNS hostname, without scheme, port or path')
    token_id = settings.get('cloudflare_turn_token_id', '')
    token = settings.get('cloudflare_turn_api_token', '')
    if bool(token_id) != bool(token):
        raise ValueError('Supply both TURN token ID and API token, or leave both empty')
    if hostname and not token:
        raise ValueError('Public tunnel mode requires TURN credentials for the media connection')
    if settings.get('cloudflare_tunnel_token') and not hostname:
        raise ValueError('A tunnel token requires public_hostname')
    return settings


def render_config(settings, runtime, previous=None):
    config = json.loads((ROOT / 'config/config.example.json').read_text())
    if previous:
        config.update(previous)
    config.update(credentials=settings['web_password'], bind_address='127.0.0.1:43780',
                  bind_address_https=None, certificate=None, data_path='server/data.json',
                  streamer_path=str(runtime / 'streamer'), pair_device_name='Tesla Ubuntu',
                  external_url=('https://' + settings['public_hostname']) if settings.get('public_hostname') else None)
    config['cloudflare_turn'] = ({'token_id': settings['cloudflare_turn_token_id'],
                                 'api_token_env': 'CLOUDFLARE_TURN_API_TOKEN', 'ttl': 86400}
                                if settings.get('cloudflare_turn_token_id') else None)
    return config


def env_quote(value):
    # systemd EnvironmentFile, not shell: $ and % remain literal.
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def unit_quote(value):
    # Unit paths/commands expand % specifiers; ExecStart also expands $ variables.
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def render_service(runtime, bridge_only, sunshine_service='app-dev.lizardbyte.app.Sunshine.service'):
    # Avoid ExecStart's environment expansion ambiguity in custom install paths.
    if '$' in str(runtime) or any(c in str(runtime) for c in '\r\n'):
        raise ValueError('Install path cannot contain $, CR or LF')
    after = 'network-online.target' + ('' if bridge_only else ' ' + sunshine_service)
    return f'''[Unit]
Description=Tesla Moonlight Web (Ubuntu)
After={after}
{'Wants=' + sunshine_service if not bridge_only else ''}

[Service]
Type=simple
WorkingDirectory={str(runtime).replace('%', '%%')}
EnvironmentFile={str(runtime / 'server/service.env').replace('%', '%%')}
ExecStart=/bin/bash {unit_quote(runtime / 'start-moonlight-web.sh')}
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
'''


def verify_build(build):
    manifest = json.loads((build / 'manifest.json').read_text())
    if manifest['architecture'] != platform.machine():
        raise ValueError('Build architecture does not match this machine; rebuild locally')
    files = manifest['sha256']
    for required in ('web-server', 'streamer', 'static/index.html', 'static/stream.js'):
        if required not in files:
            raise ValueError(f'Build manifest missing {required}')
    for name, expected in files.items():
        path = (build / name).resolve()
        if not path.is_relative_to(build.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f'Build checksum mismatch: {name}')
    for name in ('web-server', 'streamer'):
        with (build / name).open('rb') as source:
            if source.read(4) != b'\x7fELF':
                raise ValueError('Runtime is not a Linux executable')


def systemctl(*args):
    subprocess.run(['systemctl', '--user', *args], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare-config', action='store_true')
    parser.add_argument('--bridge-only', action='store_true', help='Use a separately managed Sunshine service or host')
    parser.add_argument('--no-start', action='store_true', help='Install files only; do not enable/start services')
    parser.add_argument('--config', type=Path, default=ROOT / 'config/install.json')
    parser.add_argument('--build-dir', type=Path, default=ROOT / 'build/runtime')
    parser.add_argument('--prefix', type=Path, default=Path.home() / '.local/share/tesla-moonlight-ubuntu')
    args = parser.parse_args()
    os.umask(0o077)
    if args.prepare_config:
        if not args.config.exists():
            write_private(args.config, (ROOT / 'config/install.example.json').read_text())
        print(f'Edit {args.config}; existing configuration was preserved.')
        return
    if platform.system() != 'Linux' or os.geteuid() == 0:
        parser.error('Run as your normal Ubuntu user, not root or Windows Python')
    if 'microsoft' in platform.release().lower() and not args.bridge_only:
        parser.error('Use bash install.sh --wsl for the complete WSL desktop, or --bridge-only for a separate host')
    settings = validate(json.loads(args.config.read_text()))
    os.chmod(args.config, 0o600)
    build = args.build_dir.resolve()
    verify_build(build)
    runtime = args.prefix.expanduser().resolve()
    service_text = render_service(runtime, args.bridge_only)
    if not args.bridge_only and not shutil.which('sunshine'):
        parser.error('Install Sunshine first (see README.md), or use --bridge-only for a separate host')
    tunnel = settings.get('cloudflare_tunnel_token', '')
    cloudflared = shutil.which('cloudflared')
    if tunnel and not cloudflared:
        parser.error('Install cloudflared first (see README.md)')
    units = Path.home() / '.config/systemd/user'
    if not args.no_start:
        subprocess.run(['systemctl', '--user', 'show-environment'], check=True, stdout=subprocess.DEVNULL)
        for name in (SERVICE, TUNNEL_SERVICE):
            if (units / name).exists():
                systemctl('stop', name)
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = runtime / 'server'
    server.mkdir(exist_ok=True, mode=0o700)
    os.chmod(server, 0o700)
    previous = json.loads((server / 'config.json').read_text()) if (server / 'config.json').exists() else None
    # Copy executables using replace so an existing process never sees a partial file.
    for name in ('web-server', 'streamer'):
        temp = runtime / (name + '.new')
        shutil.copy2(build / name, temp)
        os.chmod(temp, 0o755)
        os.replace(temp, runtime / name)
    if (runtime / 'static').exists():
        shutil.rmtree(runtime / 'static')
    shutil.copytree(build / 'static', runtime / 'static')
    shutil.copy2(ROOT / 'scripts/start-moonlight-web.sh', runtime / 'start-moonlight-web.sh')
    write_private(server / 'config.json', json.dumps(render_config(settings, runtime, previous), indent=2) + '\n')
    environment = 'CLOUDFLARE_TURN_API_TOKEN=' + env_quote(settings.get('cloudflare_turn_api_token', '')) + '\n'
    environment += 'COCKPIT_WAIT_FOR_SUNSHINE=' + ('0' if args.bridge_only else '1') + '\n'
    write_private(server / 'service.env', environment)
    write_private(units / SERVICE, service_text)
    if tunnel:
        # cloudflared reads the credential from a file, never process arguments.
        write_private(server / 'tunnel.token', tunnel + '\n')
        write_private(units / TUNNEL_SERVICE, f'''[Unit]
Description=Tesla Moonlight HTTPS tunnel
After=network-online.target {SERVICE}

[Service]
ExecStart={unit_quote(cloudflared)} tunnel --no-autoupdate run --token-file {unit_quote(server / 'tunnel.token')}
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
''')
    elif (units / TUNNEL_SERVICE).exists():
        if not args.no_start:
            systemctl('disable', TUNNEL_SERVICE)
        (units / TUNNEL_SERVICE).unlink()
        (server / 'tunnel.token').unlink(missing_ok=True)
    if not args.bridge_only:
        sunshine = Path.home() / '.config/sunshine'
        sunshine.mkdir(parents=True, exist_ok=True)
        for name in ('sunshine.conf', 'apps.json'):
            if not (sunshine / name).exists():
                write_private(sunshine / name, (ROOT / f'config/{name}.example').read_text())
    if not args.no_start:
        systemctl('daemon-reload')
        if not args.bridge_only:
            desktop_env = [key for key in ('DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE') if key in os.environ]
            if desktop_env:
                systemctl('import-environment', *desktop_env)
            systemctl('enable', '--now', 'app-dev.lizardbyte.app.Sunshine.service')
        systemctl('enable', '--now', SERVICE)
        systemctl('restart', SERVICE)
        if tunnel:
            systemctl('enable', '--now', TUNNEL_SERVICE)
            systemctl('restart', TUNNEL_SERVICE)
    print(f'Installed Linux runtime: {runtime}')
    print('Open http://localhost:43780; log in with your configured web_password.')
    print('Add Sunshine host 127.0.0.1 (or your separate host IP), then pair using its PIN page.')
    if settings.get('public_hostname'):
        print(f'Cloudflare route: https://{settings["public_hostname"]} -> http://127.0.0.1:43780')
        print('Create/check this route in the Cloudflare dashboard. Tunnel alone does not carry WebRTC media.')
    if args.no_start:
        print('Services are not started. Run systemctl --user daemon-reload before starting them.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'Setup failed: {error}') from None
