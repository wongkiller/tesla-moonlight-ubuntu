#!/usr/bin/env python3
"""Provision an isolated X11/audio desktop and Sunshine for an actual WSL stream."""
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import subprocess
from setup import ROOT, write_private, unit_quote


def main():
    if os.geteuid() == 0 or 'microsoft' not in platform.release().lower():
        raise SystemExit('Run as your normal user inside WSL2.')
    for name in ('Xorg', 'xauth', 'pulseaudio', 'xfwm4', 'xfce4-panel', 'xfdesktop', 'xfce4-terminal', 'sunshine'):
        if not shutil.which(name):
            raise SystemExit(f'Missing {name}; install WSL desktop prerequisites first.')
    home = Path.home()
    state = home / '.local/share/tesla-moonlight-ubuntu/wsl-desktop'
    units = home / '.config/systemd/user'
    previous_x11 = units / 'tesla-wsl-x11.service'
    migrate_display = previous_x11.exists() and '/Xvfb ' in previous_x11.read_text()
    if not Path('/usr/lib/xorg/modules/drivers/dummy_drv.so').exists():
        raise SystemExit('Install xserver-xorg-video-dummy first: bash install.sh --install-wsl-deps')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    for directory in ('sunshine', 'config', 'cache', 'data', 'Desktop'):
        (state / directory).mkdir(exist_ok=True, mode=0o700)
    auth = state / 'Xauthority'
    if not auth.exists():
        write_private(auth, '')
        subprocess.run(['xauth', '-f', str(auth), 'add', ':99', '.', secrets.token_hex(16)], check=True)
    cookie = state / 'pulse.cookie'
    if not cookie.exists():
        fd = os.open(cookie, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(secrets.token_bytes(256))
    pulse_socket = state / 'pulse.sock'
    write_private(state / 'pulse.pa', f'''load-module module-native-protocol-unix socket={pulse_socket} auth-cookie={cookie}
load-module module-null-sink sink_name=tesla_wsl sink_properties=device.description=Tesla_WSL_Desktop rate=48000 channels=2
set-default-sink tesla_wsl
set-default-source tesla_wsl.monitor
''')
    write_private(state / 'config/user-dirs.dirs', f'XDG_DESKTOP_DIR="{state}/Desktop"\n')
    panel = state / 'config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml'
    if not panel.exists() and Path('/etc/xdg/xfce4/panel/default.xml').exists():
        write_private(panel, Path('/etc/xdg/xfce4/panel/default.xml').read_text())
    write_private(state / 'welcome.sh', '''#!/usr/bin/env bash
printf '\\033[2J\\033[H'
printf 'Ubuntu 26.04 — Tesla streaming desktop\\n\\n'
printf 'Sunshine captures this X11 desktop; Window / Full / Auto resize it.\\n'
printf 'Audio is routed through a private Tesla WSL output.\\n\\n'
printf 'Try typing here, dragging this window, or opening Firefox.\\n'
printf 'This is a separate WSL desktop; your Windows desktop is unchanged.\\n\\n'
exec bash --noprofile --norc
''', 0o700)
    shutil.copy2(ROOT / 'scripts/start-wsl-desktop.sh', state / 'start-desktop.sh')
    shutil.copy2(ROOT / 'config/wsl-xorg.conf', state / 'xorg.conf')
    shutil.copy2(ROOT / 'scripts/display-mode.py', state / 'display-mode.py')
    os.chmod(state / 'display-mode.py', 0o700)
    common = f'''Environment=DISPLAY=:99
Environment=XAUTHORITY={auth}
Environment=PULSE_SERVER=unix:{pulse_socket}
Environment=PULSE_COOKIE={cookie}
Environment=PULSE_SINK=tesla_wsl
Environment=XDG_SESSION_TYPE=x11
Environment=XDG_CURRENT_DESKTOP=XFCE
Environment=GDK_BACKEND=x11
Environment=QT_QPA_PLATFORM=xcb
Environment=SDL_VIDEODRIVER=x11
Environment=MOZ_ENABLE_WAYLAND=0
Environment=XDG_CONFIG_HOME={state}/config
Environment=XDG_CACHE_HOME={state}/cache
Environment=XDG_DATA_HOME={state}/data
Environment=TESLA_WSL_STATE={state}
UnsetEnvironment=WAYLAND_DISPLAY
'''
    definitions = {
        'tesla-wsl-x11': f'''[Unit]
Description=Private Tesla WSL X11 display
[Service]
ExecStart=/usr/lib/xorg/Xorg :99 -config {unit_quote(state / 'xorg.conf')} -logfile {unit_quote(state / 'Xorg.log')} -nolisten tcp -noreset -novtswitch -sharevts -auth {unit_quote(auth)}
Restart=on-failure
RestartSec=3
UMask=0077
[Install]
WantedBy=default.target
''',
        'tesla-wsl-audio': f'''[Unit]
Description=Private Tesla WSL audio
[Service]
ExecStart=/usr/bin/pulseaudio -n --daemonize=no --use-pid-file=no --exit-idle-time=-1 --log-target=journal -F {unit_quote(state / 'pulse.pa')}
Restart=on-failure
RestartSec=3
UMask=0077
[Install]
WantedBy=default.target
''',
        'tesla-wsl-desktop': f'''[Unit]
Description=Tesla WSL XFCE desktop
Requires=tesla-wsl-x11.service tesla-wsl-audio.service
After=tesla-wsl-x11.service tesla-wsl-audio.service
[Service]
{common}ExecStart=/usr/bin/dbus-run-session -- /bin/bash {unit_quote(state / 'start-desktop.sh')}
Restart=on-failure
RestartSec=3
UMask=0077
[Install]
WantedBy=default.target
''',
        'tesla-wsl-sunshine': f'''[Unit]
Description=Sunshine for the Tesla WSL desktop
Requires=tesla-wsl-desktop.service
After=tesla-wsl-desktop.service
[Service]
{common}ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/sunshine {unit_quote(state / 'sunshine/sunshine.conf')}
Restart=on-failure
RestartSec=5
UMask=0077
[Install]
WantedBy=default.target
'''
    }
    config = state / 'sunshine/sunshine.conf'
    if not config.exists():
        write_private(config, f'''sunshine_name = Ubuntu 26.04 WSL Desktop
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
min_log_level = info
file_apps = {state}/sunshine/apps.json
''')
    apps = state / 'sunshine/apps.json'
    if not apps.exists():
        write_private(apps, json.dumps({'env': {}, 'apps': [{'name': 'Ubuntu WSL Desktop', 'image-path': 'desktop.png'}]}, indent=2))
    credentials = home / '.config/tesla-moonlight-ubuntu/sunshine-wsl.json'
    if not credentials.exists():
        password = secrets.token_urlsafe(24)
        write_private(credentials, json.dumps({'username': 'tesla', 'password': password}, indent=2))
    if not (state / 'config/sunshine/sunshine_state.json').exists():
        saved = json.loads(credentials.read_text())
        subprocess.run(['sunshine', str(config), '--creds', saved['username'], saved['password']], check=True,
                       env=dict(os.environ, XDG_CONFIG_HOME=str(state / 'config')),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for name, unit in definitions.items():
        write_private(units / (name + '.service'), unit)
    # The bridge waits for this dedicated host without changing an existing
    # native Sunshine installation or the user's ordinary XFCE settings.
    write_private(units / 'tesla-moonlight-web.service.d/wsl.conf', f'''[Unit]
Wants=tesla-wsl-sunshine.service
After=tesla-wsl-sunshine.service
[Service]
Environment={unit_quote('COCKPIT_DISPLAY_HELPER=' + str(state / 'display-mode.py'))}
Environment={unit_quote('TESLA_WSL_STATE=' + str(state))}
''')
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', *[name + '.service' for name in definitions]], check=True)
    if migrate_display:
        subprocess.run(['systemctl', '--user', 'restart', 'tesla-wsl-x11', 'tesla-wsl-desktop', 'tesla-wsl-sunshine'], check=True)
    print(f'WSL desktop installed at {state}; Sunshine admin credentials are in {credentials}')


if __name__ == '__main__':
    main()
