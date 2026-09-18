#!/usr/bin/env python3
"""Download an official release package for this Ubuntu release and architecture."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('component', choices=['sunshine', 'cloudflared'])
    parser.add_argument('--tag', help='Explicit release tag; default is the latest official release')
    args = parser.parse_args()
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    if os_release.get('ID', '').strip('"') != 'ubuntu':
        parser.error('This helper requires Ubuntu')
    version = os_release['VERSION_ID'].strip('"')
    arch = subprocess.check_output(['dpkg', '--print-architecture'], text=True).strip()
    if arch not in ('amd64', 'arm64'):
        parser.error('Supported package architectures: amd64, arm64')
    repo = 'LizardByte/Sunshine' if args.component == 'sunshine' else 'cloudflare/cloudflared'
    ref = 'tags/' + urllib.parse.quote(args.tag, safe='') if args.tag else 'latest'
    request = urllib.request.Request(f'https://api.github.com/repos/{repo}/releases/{ref}',
                                     headers={'User-Agent': 'tesla-moonlight-ubuntu'})
    with urllib.request.urlopen(request, timeout=30) as response:
        release = json.load(response)
    suffix = f'ubuntu{version}_{arch}.deb'
    if args.component == 'sunshine':
        assets = [a for a in release['assets'] if a['name'].startswith('sunshine_') and a['name'].endswith(suffix)]
    else:
        assets = [a for a in release['assets'] if a['name'] == f'cloudflared-linux-{arch}.deb']
    if len(assets) != 1:
        raise SystemExit(f'No unique official {args.component} package for Ubuntu {version} {arch} in {release["tag_name"]}. '
                         'No older distro package was substituted. See upstream installation instructions.')
    asset = assets[0]
    if Path(asset['name']).name != asset['name']:
        raise SystemExit('Unexpected package filename')
    digest = asset.get('digest') or ''
    if not re.fullmatch(r'sha256:[a-fA-F0-9]{64}', digest):
        raise SystemExit('Release asset has no SHA-256 digest; install it manually after verifying provenance.')
    url = asset['browser_download_url']
    if not url.startswith(f'https://github.com/{repo}/releases/download/'):
        raise SystemExit('Unexpected release download URL')
    print(f'Downloading {asset["name"]} ({release["tag_name"]})', flush=True)
    with tempfile.TemporaryDirectory(prefix='tesla-package-') as temporary:
        package = Path(temporary) / asset['name']
        urllib.request.urlretrieve(url, package)
        actual = hashlib.sha256(package.read_bytes()).hexdigest()
        if actual != digest.split(':')[1].lower():
            raise SystemExit('Downloaded package checksum does not match the release digest')
        subprocess.run(['sudo', 'apt-get', 'install', '-y', str(package)], check=True)
    print(f'{args.component} package installed. Run the setup from your logged-in desktop user.')


if __name__ == '__main__':
    main()
