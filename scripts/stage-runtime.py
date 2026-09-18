#!/usr/bin/env python3
"""Stage only compiled Linux assets; private state never enters a build."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    binaries = Path(sys.argv[1]).resolve()
    destination = ROOT / 'build/runtime'
    for name in ('web-server', 'streamer'):
        if (binaries / name).read_bytes()[:4] != b'\x7fELF':
            raise SystemExit(f'{name} is not a Linux ELF executable')
    destination.mkdir(parents=True, exist_ok=True)
    static = destination / 'static'
    if static.exists():
        shutil.rmtree(static)
    shutil.copytree(ROOT / 'moonlight-web-stream-tsla/moonlight-web/web-server/dist', static)
    for name in ('web-server', 'streamer'):
        shutil.copy2(binaries / name, destination / name)
        os.chmod(destination / name, 0o755)
    hashes = {str(p.relative_to(destination)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(destination.rglob('*')) if p.is_file() and p.name != 'manifest.json'}
    (destination / 'manifest.json').write_text(json.dumps({
        'platform': platform.platform(), 'architecture': platform.machine(),
        'frontend': (ROOT / 'FRONTEND_BUILD_VERSION').read_text().strip(),
        'sha256': hashes,
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
