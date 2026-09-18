#!/usr/bin/env python3
"""Fetch the pinned Ubuntu 26.04 amd64 runtime with archive and file hashes."""
import hashlib
from pathlib import Path
import platform
import shutil
import tarfile
import tempfile
import urllib.request
from setup import ROOT, verify_build

URL = ('https://github.com/wongkiller/tesla-moonlight-ubuntu/releases/download/v0.2.0/'
       'tesla-moonlight-ubuntu-0.2.0-ubuntu26.04-amd64.tar.gz')
SHA256 = 'f09fb675567325b79d9b098e26887929cc3df58d87fdaf607648142e1ff165dc'
PREFIX = 'tesla-moonlight-ubuntu/build/runtime/'


def main():
    if platform.machine() != 'x86_64':
        raise SystemExit('The bundled runtime requires Ubuntu 26.04 amd64.')
    with tempfile.TemporaryDirectory(prefix='tesla-runtime-') as directory:
        temporary = Path(directory)
        archive = temporary / 'runtime.tar.gz'
        request = urllib.request.Request(URL, headers={'User-Agent': 'tesla-moonlight-ubuntu'})
        with urllib.request.urlopen(request, timeout=90) as response, archive.open('wb') as output:
            shutil.copyfileobj(response, output)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
            raise SystemExit('Runtime archive checksum mismatch; installation stopped.')
        staged = temporary / 'runtime'
        staged.mkdir()
        with tarfile.open(archive) as package:
            for member in package.getmembers():
                if not member.name.startswith(PREFIX):
                    continue
                name = member.name[len(PREFIX):]
                target = (staged / name).resolve()
                if not member.isfile() or not target.is_relative_to(staged.resolve()):
                    raise SystemExit('Unsafe runtime archive member; installation stopped.')
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.extractfile(member) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
        verify_build(staged)
        destination = ROOT / 'build/runtime'
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copytree(staged, destination, dirs_exist_ok=True)
        for name in ('web-server', 'streamer'):
            (destination / name).chmod(0o755)
    print('Pinned Linux runtime downloaded and checksums verified.')


if __name__ == '__main__':
    main()
