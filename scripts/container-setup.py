#!/usr/bin/env python3
"""Idempotent configuration for an unprivileged desktop inside Ubuntu Docker."""
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import sys

from setup import ROOT, render_config, validate, verify_build, write_private

HOME = Path('/home/sunshine')
STATE = HOME / '.local/share/tesla-moonlight-ubuntu'
BASE_KEYS = {'public_hostname', 'web_password', 'cloudflare_turn_token_id',
             'cloudflare_turn_api_token', 'cloudflare_tunnel_token'}


def read_settings(path):
    settings = json.loads(Path(path).read_text())
    if not isinstance(settings, dict) or set(settings) - BASE_KEYS - {'cloudflare_api_token', 'cloudflare_zone_id'}:
        raise ValueError('Unknown configuration keys; use config/internet.example.json')
    if any(not isinstance(v, str) or any(c in v for c in '\r\n\0') for v in settings.values()):
        raise ValueError('Configuration values must be single-line strings')
    validate({k: v for k, v in settings.items() if k in BASE_KEYS})
    if settings.get('public_hostname') and not settings.get('cloudflare_tunnel_token'):
        raise ValueError('Public container setup needs cloudflare_tunnel_token')
    if settings.get('cloudflare_api_token') and not settings.get('cloudflare_zone_id'):
        raise ValueError('Automatic DNS setup needs cloudflare_zone_id')
    return settings


def install(config_path):
    settings = read_settings(config_path)
    verify_build(ROOT / 'build/runtime')
    os.umask(0o077)
    account = pwd.getpwnam('sunshine')
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    desktop = STATE / 'wsl-desktop'  # Shared layout with the tested WSL capture helper.
    for name in ('sunshine', 'config', 'cache', 'data/applications', 'Desktop'):
        (desktop / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ('server', 'run', 'logs'):
        (STATE / name).mkdir(exist_ok=True, mode=0o700)
    if (STATE / 'run/supervisor.sock').exists():
        active = subprocess.run(['supervisorctl', '-c', '/etc/tesla-moonlight-ubuntu/supervisord.conf', 'pid'],
                                capture_output=True, text=True)
        if active.returncode == 0 and active.stdout.strip().isdigit():
            raise ValueError('Services are already running. Restart the container to apply configuration changes.')
        (STATE / 'run/supervisor.sock').unlink(missing_ok=True)
        (STATE / 'run/supervisord.pid').unlink(missing_ok=True)
    for name in ('web-server', 'streamer'):
        temporary = STATE / (name + '.new')
        shutil.copy2(ROOT / 'build/runtime' / name, temporary)
        temporary.chmod(0o755)
        temporary.replace(STATE / name)
    shutil.copytree(ROOT / 'build/runtime/static', STATE / 'static', dirs_exist_ok=True)
    for name in ('container-service.py', 'pair-wsl-host.py', 'display-mode.py', 'start-wsl-desktop.sh'):
        shutil.copy2(ROOT / 'scripts' / name, STATE / name)
    shutil.copy2(ROOT / 'scripts/display-mode.py', desktop / 'display-mode.py')
    (desktop / 'display-mode.py').chmod(0o700)
    shutil.copy2(ROOT / 'config/wsl-xorg.conf', desktop / 'xorg.conf')
    write_private(desktop / 'welcome.sh', '#!/bin/bash\necho "Ubuntu 26.04 — Tesla Docker Desktop"\nexec bash --noprofile --norc\n', 0o700)
    write_private(desktop / 'config/user-dirs.dirs', f'XDG_DESKTOP_DIR="{desktop}/Desktop"\n')
    auth = desktop / 'Xauthority'
    if not auth.exists():
        write_private(auth, '')
        subprocess.run(['xauth', '-f', str(auth), 'add', ':99', '.', secrets.token_hex(16)], check=True)
    cookie = desktop / 'pulse.cookie'
    if not cookie.exists():
        cookie.write_bytes(secrets.token_bytes(256))
        cookie.chmod(0o600)
    write_private(desktop / 'pulse.pa', f'''load-module module-native-protocol-unix socket={desktop}/pulse.sock auth-cookie={cookie}
load-module module-null-sink sink_name=tesla_wsl sink_properties=device.description=Tesla_Docker_Desktop rate=48000 channels=2
set-default-sink tesla_wsl
set-default-source tesla_wsl.monitor
''')
    sunshine_config = desktop / 'sunshine/sunshine.conf'
    write_private(sunshine_config, f'''sunshine_name = Ubuntu 26.04 Docker Desktop
capture = x11
encoder = software
sw_preset = ultrafast
sw_tune = zerolatency
hevc_mode = 1
av1_mode = 1
audio_sink = tesla_wsl
virtual_sink = tesla_wsl
upnp = disabled
origin_web_ui_allowed = pc
system_tray = disabled
file_apps = {desktop}/sunshine/apps.json
''')
    private = HOME / '.config/tesla-moonlight-ubuntu'
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    credentials = private / 'sunshine-wsl.json'
    if not credentials.exists():
        write_private(credentials, json.dumps({'username': 'tesla', 'password': secrets.token_urlsafe(24)}))
    youtube = STATE / 'youtube-remote'
    youtube.mkdir(exist_ok=True, mode=0o700)
    shutil.copytree(ROOT / 'extensions/youtube-remote', youtube, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    (youtube / 'stop.sh').chmod(0o700)
    if not (youtube / 'control.token').exists():
        write_private(youtube / 'control.token', secrets.token_hex(32) + '\n')
    apps_path = desktop / 'sunshine/apps.json'
    apps = json.loads(apps_path.read_text()) if apps_path.exists() else {'env': {}, 'apps': []}
    names = {'Ubuntu Docker Desktop', 'YouTube Remote'}
    apps['apps'] = [a for a in apps['apps'] if a.get('name') not in names] + [
        {'name': 'Ubuntu Docker Desktop', 'image-path': 'desktop.png'},
        {'name': 'YouTube Remote', 'detached': [f'/usr/bin/python3 {youtube}/app.py launch'],
         'prep-cmd': [{'do': '', 'undo': f'/usr/bin/python3 {youtube}/app.py pause'}],
         'output': str(youtube / 'launch.log'), 'image-path': str(youtube / 'assets/youtube-remote.png')}]
    write_private(apps_path, json.dumps(apps, indent=2))
    write_private(desktop / 'data/applications/tesla-sunshine.desktop', '''[Desktop Entry]
Type=Application
Name=Sunshine Settings
Exec=google-chrome --ozone-platform=x11 --disable-gpu --disable-quic https://localhost:47990
Icon=preferences-desktop-remote-desktop
Categories=Settings;Network;
''', 0o644)
    previous = STATE / 'server/config.json'
    existing = json.loads(previous.read_text()) if previous.exists() else None
    write_private(previous, json.dumps(render_config(settings, STATE, existing), indent=2))
    # Worker reads secrets directly; neither command lines nor Supervisor files contain them.
    write_private(STATE / 'server/deployment.json', json.dumps({k: v for k, v in settings.items() if k in BASE_KEYS}))
    if settings.get('cloudflare_tunnel_token'):
        write_private(STATE / 'server/tunnel.token', settings['cloudflare_tunnel_token'])
    if not (STATE / 'server/instance-id').exists():
        write_private(STATE / 'server/instance-id', secrets.token_hex(16))
    for parent, dirs, files in os.walk(HOME):
        os.chown(parent, account.pw_uid, account.pw_gid)
        for name in dirs + files:
            # Chrome Singleton* entries are symlinks to ephemeral sockets/cookies.
            # Own the link itself, never follow it into /tmp or another directory.
            os.chown(Path(parent) / name, account.pw_uid, account.pw_gid, follow_symlinks=False)
    if not (desktop / 'config/sunshine/sunshine_state.json').exists():
        saved = json.loads(credentials.read_text())
        subprocess.run(['runuser', '-u', 'sunshine', '--', 'env', f'XDG_CONFIG_HOME={desktop}/config',
                        'sunshine', str(sunshine_config), '--creds', saved['username'], saved['password']],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    supervisor = f'''[unix_http_server]
file={STATE}/run/supervisor.sock
chmod=0700
chown=sunshine:sunshine
[supervisord]
nodaemon=true
logfile={STATE}/logs/supervisord.log
pidfile={STATE}/run/supervisord.pid
childlogdir={STATE}/logs
user=root
[rpcinterface:supervisor]
supervisor.rpcinterface_factory=supervisor.rpcinterface:make_main_rpcinterface
[supervisorctl]
serverurl=unix://{STATE}/run/supervisor.sock
'''
    roles = ['dbus', 'x11', 'audio', 'desktop', 'sunshine', 'web', 'origin', 'youtube-control', 'youtube-browser', 'ready']
    if settings.get('cloudflare_tunnel_token'):
        roles.append('tunnel')
    for index, role in enumerate(roles):
        supervisor += f'''
[program:{role}]
command=/usr/bin/python3 {STATE}/container-service.py {role}
user=sunshine
directory={STATE}
environment=HOME="{HOME}",USER="sunshine"
priority={10 + index}
autostart={'false' if role == 'youtube-browser' else 'true'}
autorestart={'false' if role == 'youtube-browser' else 'unexpected'}
startsecs={0 if role == 'ready' else 2}
startretries=5
stopasgroup=true
killasgroup=true
stopwaitsecs=15
stdout_logfile={'/dev/stdout' if role == 'ready' else str(STATE / 'logs' / (role + '.log'))}
stdout_logfile_maxbytes={'0' if role == 'ready' else '5MB'}
stdout_logfile_backups=2
redirect_stderr=true
'''
    write_private(Path('/etc/tesla-moonlight-ubuntu/supervisord.conf'), supervisor, 0o644)
    Path('/etc/tesla-moonlight-ubuntu').chmod(0o755)
    print('Configured private desktop, Sunshine, Chrome, web bridge, automatic pairing and optional Tunnel.')


if __name__ == '__main__':
    try:
        action = sys.argv[1]
        if action == 'validate':
            read_settings(sys.argv[2])
            print('Configuration valid (values hidden).')
        elif action == 'verify-build':
            verify_build(ROOT / 'build/runtime')
        elif action == 'install':
            install(sys.argv[2])
        else:
            raise ValueError('Expected validate, verify-build or install')
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        # JSON errors only report location, never echo the invalid document.
        message = f'Invalid JSON at line {error.lineno}' if isinstance(error, json.JSONDecodeError) else str(error)
        raise SystemExit('Container setup: ' + message) from None
