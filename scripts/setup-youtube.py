#!/usr/bin/env python3
"""Install the original Tesla YouTube controls with Ubuntu app services."""
import json
import os
from pathlib import Path
import platform
import secrets
import shlex
import shutil
import subprocess
import time

from setup import ROOT, unit_quote, write_private


def main():
    if platform.system() != 'Linux' or os.geteuid() == 0:
        raise SystemExit('Run as the normal Ubuntu desktop user')
    chrome = shutil.which('google-chrome') or shutil.which('chromium')
    node = shutil.which('node')
    if not chrome or not node:
        raise SystemExit('Install Chrome and Node.js 22+: bash install.sh --install-youtube-deps')
    if int(subprocess.check_output([node, '--version'], text=True).strip().lstrip('v').split('.')[0]) < 22:
        raise SystemExit('Node.js 22+ is required for the native WebSocket API')
    runtime = Path.home() / '.local/share/tesla-moonlight-ubuntu'
    if not (runtime / 'server/config.json').exists():
        raise SystemExit('Install the web bridge first')
    wsl = 'microsoft' in platform.release().lower()
    desktop = runtime / 'wsl-desktop'
    apps_path = desktop / 'sunshine/apps.json' if wsl else Path.home() / '.config/sunshine/apps.json'
    sunshine_service = 'tesla-wsl-sunshine' if wsl else 'app-dev.lizardbyte.app.Sunshine'
    apps = json.loads(apps_path.read_text())
    state = runtime / 'youtube-remote'
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ('exit-server.js', 'app.py', 'stop.sh'):
        shutil.copy2(ROOT / 'extensions/youtube-remote' / name, state / name)
    os.chmod(state / 'stop.sh', 0o700)
    for name in ('chrome-extension', 'assets'):
        shutil.copytree(ROOT / 'extensions/youtube-remote' / name, state / name, dirs_exist_ok=True)
    token = state / 'control.token'
    if not token.exists():
        write_private(token, secrets.token_hex(32) + '\n')
    units = Path.home() / '.config/systemd/user'
    environment = ''
    dependencies = 'After=graphical-session.target\n'
    rendering = ''
    if wsl:
        # Use the same isolated X11 and PulseAudio environment as Sunshine.
        environment = '\n'.join(line for line in (units / 'tesla-wsl-desktop.service').read_text().splitlines()
                                if line.startswith(('Environment=', 'UnsetEnvironment='))) + '\n'
        dependencies = 'Requires=tesla-wsl-desktop.service\nAfter=tesla-wsl-desktop.service\n'
        # Xdummy has no GPU. QUIC can stall Google pages on WSL NAT; use HTTPS/TCP.
        rendering = ' --disable-gpu --disable-quic'
    write_private(units / 'tesla-youtube-control.service', f'''[Unit]
Description=Tesla YouTube direct controls
[Service]
ExecStart={unit_quote(node)} {unit_quote(state / 'exit-server.js')} {unit_quote(token)} {unit_quote(state / 'stop.sh')}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
[Install]
WantedBy=default.target
''')
    write_private(units / 'tesla-youtube-browser.service', f'''[Unit]
Description=Isolated YouTube Remote browser
{dependencies}[Service]
{environment}ExecStart={unit_quote(chrome)} {unit_quote('--user-data-dir=' + str(state / 'profile'))} --remote-debugging-address=127.0.0.1 --remote-debugging-port=9227 --remote-allow-origins=http://127.0.0.1:9227 --ozone-platform=x11 --app=https://www.youtube.com/ --start-fullscreen --no-first-run --no-default-browser-check --disable-session-crashed-bubble --disable-background-mode --force-device-scale-factor=1.25{rendering}
Restart=no
TimeoutStopSec=10
UMask=0077
''')
    write_private(units / 'tesla-moonlight-web.service.d/youtube.conf', f'''[Unit]
Wants=tesla-youtube-control.service
After=tesla-youtube-control.service
[Service]
Environment={unit_quote('COCKPIT_YOUTUBE_CONTROL_TOKEN_FILE=' + str(token))}
''')
    launch = '/usr/bin/python3 ' + shlex.quote(str(state / 'app.py'))
    app = {'name': 'YouTube Remote', 'output': str(state / 'launch.log'),
           'prep-cmd': [{'do': '', 'undo': launch + ' cleanup'}],
           'detached': [launch + ' launch'], 'image-path': str(state / 'assets/youtube-remote.png')}
    backup = state / 'backups' / f'apps-{time.time_ns()}.json'
    write_private(backup, json.dumps(apps, indent=2))
    apps['apps'] = [item for item in apps.get('apps', []) if item.get('name') != 'YouTube Remote'] + [app]
    write_private(apps_path, json.dumps(apps, indent=2) + '\n')
    # Admin stays local and authenticated; offer a desktop menu shortcut.
    applications = desktop / 'data/applications' if wsl else Path.home() / '.local/share/applications'
    write_private(applications / 'tesla-sunshine.desktop', '''[Desktop Entry]
Type=Application
Name=Sunshine Settings
Comment=Local Sunshine applications and streaming settings
Exec=xdg-open https://localhost:47990
Icon=preferences-desktop-remote-desktop
Categories=Settings;Network;
''', 0o644)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', 'tesla-youtube-control'], check=True)
    subprocess.run(['systemctl', '--user', 'restart', 'tesla-youtube-control', sunshine_service, 'tesla-moonlight-web'], check=True)
    print('Installed YouTube Remote with its original Tesla menu, isolated profile, and local Sunshine Settings shortcut.')


if __name__ == '__main__':
    main()
