#!/usr/bin/env python3
"""Read-only checks; never print passwords, pairings or TURN credentials."""
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import urllib.error
import urllib.request


def main():
    if platform.system() != 'Linux':
        raise SystemExit('Run inside Ubuntu: bash install.sh --check')
    wsl = 'microsoft' in platform.release().lower()
    print('Platform:', platform.platform())
    print('Mode:', 'WSL2 with optional isolated X11/Sunshine desktop' if wsl else 'native Linux host')
    for command in ('cargo', 'node', 'sunshine', 'cloudflared'):
        print(command + ':', shutil.which(command) or 'not installed')
    print('Desktop session:', os.environ.get('XDG_SESSION_TYPE', 'not detected'))
    print('Display:', os.environ.get('WAYLAND_DISPLAY') or os.environ.get('DISPLAY') or 'not detected')
    print('DRM devices:', ', '.join(str(p) for p in Path('/dev/dri').glob('*')) or 'none')
    print('uinput writable:', os.access('/dev/uinput', os.W_OK))
    runtime = Path.home() / '.local/share/tesla-moonlight-ubuntu'
    config_file = runtime / 'server/config.json'
    failed = False
    if config_file.exists():
        config = json.loads(config_file.read_text())
        print('Web password configured:', bool(config.get('credentials')))
        print('TURN configured:', bool(config.get('cloudflare_turn')))
        print('Public URL:', config.get('external_url') or 'local only')
        for path in (config_file, runtime / 'server/service.env'):
            private = path.exists() and path.stat().st_mode & 0o077 == 0
            print(path.name + ' private:', private)
            failed |= not private
    else:
        print('Runtime: not installed')
        failed = True
    desktop_installed = (runtime / 'wsl-desktop/sunshine/sunshine.conf').exists()
    host_services = ('tesla-wsl-x11', 'tesla-wsl-audio', 'tesla-wsl-desktop', 'tesla-wsl-sunshine') if desktop_installed else ('app-dev.lizardbyte.app.Sunshine',)
    youtube_installed = (runtime / 'youtube-remote/control.token').exists()
    optional_services = ('tesla-youtube-control',) if youtube_installed else ()
    for service in ('tesla-moonlight-web', *host_services, 'tesla-moonlight-tunnel', *optional_services):
        result = subprocess.run(['systemctl', '--user', 'is-active', service], capture_output=True, text=True)
        print(service + ':', result.stdout.strip() or 'unavailable')
        if (service == 'tesla-moonlight-web' or service in optional_services or desktop_installed and service in host_services) and result.returncode:
            failed = True
    for name, url in [('Web', 'http://127.0.0.1:43780/'), ('Sunshine', 'http://127.0.0.1:47989/serverinfo')]:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                print(name + ' HTTP:', response.status)
        except (OSError, urllib.error.URLError):
            print(name + ' HTTP: unavailable' + (' (expected with a separate host)' if name == 'Sunshine' and not desktop_installed else ''))
            if name == 'Web' or desktop_installed:
                failed = True
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    main()
