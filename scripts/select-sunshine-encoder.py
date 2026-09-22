#!/usr/bin/env python3
"""Pick Sunshine encoder: VAAPI when /dev/dri is usable, otherwise software.

Used at install (container-setup / setup-wsl-desktop) and every container
start (container-entrypoint) so a GPU-less host never stays stuck on vaapi.
"""
from pathlib import Path
import os
import re
import subprocess
import sys

RENDER = Path('/dev/dri/renderD128')


def vaapi_available():
    if not RENDER.exists():
        return False
    try:
        fd = os.open(RENDER, os.O_RDWR)
        os.close(fd)
    except OSError:
        return False
    return True


def prepare_dri():
    if not Path('/dev/dri').is_dir():
        return
    for path in Path('/dev/dri').iterdir():
        try:
            os.chmod(path, 0o666)
        except OSError:
            pass
    if os.geteuid() == 0:
        subprocess.run(['usermod', '-aG', 'video,render', 'sunshine'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def apply_encoder(config_path):
    path = Path(config_path)
    encoder = 'vaapi' if vaapi_available() else 'software'
    if not path.exists():
        print(encoder)
        return encoder
    text = path.read_text()
    updated, n = re.subn(r'^encoder\s*=\s*\S+', f'encoder = {encoder}', text, count=1, flags=re.M)
    if n == 0:
        updated = text.rstrip() + f'\nencoder = {encoder}\n'
    if updated != text:
        path.write_text(updated)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    print(encoder)
    return encoder


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == '--apply':
        prepare_dri()
        apply_encoder(sys.argv[2])
        return
    print('vaapi' if vaapi_available() else 'software')


if __name__ == '__main__':
    main()
