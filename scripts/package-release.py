#!/usr/bin/env python3
"""Package the port's source and verified runtime, never local configuration."""
import hashlib
from pathlib import Path
import tarfile

from setup import ROOT, verify_build


def main():
    verify_build(ROOT / 'build/runtime')
    version = (ROOT / 'FRONTEND_BUILD_VERSION').read_text().strip().removeprefix('ubuntu-')
    output = ROOT / f'build/tesla-moonlight-ubuntu-{version}-ubuntu26.04-amd64.tar.gz'
    excluded = {'.git', 'node_modules', 'target', 'dist', '__pycache__'}
    files = [ROOT / name for name in ('README.md', 'LICENSE', 'UPSTREAM.md',
             'install.sh', 'FRONTEND_BUILD_VERSION', '.gitignore', '.gitattributes')]
    for name in ('scripts', 'tests', 'docs', 'extensions', '.github', 'moonlight-web-stream-tsla', 'build/runtime'):
        for path in (ROOT / name).rglob('*'):
            if path.is_file() and not (excluded & set(path.relative_to(ROOT / name).parts)) and path.suffix != '.pyc':
                files.append(path)
    files.extend((ROOT / 'config').glob('*.example*'))
    files.append(ROOT / 'config/wsl-xorg.conf')
    with tarfile.open(output, 'w:gz') as archive:
        for path in sorted(files):
            archive.add(path, arcname=str(Path('tesla-moonlight-ubuntu') / path.relative_to(ROOT)), recursive=False)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    (ROOT / 'build/SHA256SUMS').write_text(f'{digest}  {output.name}\n')
    print(f'Packaged {len(files)} files: {output} ({output.stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
