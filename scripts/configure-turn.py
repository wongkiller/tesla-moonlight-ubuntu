#!/usr/bin/env python3
"""Validate TURN credentials from stdin and finish the private WSL deployment."""
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

from setup import ROOT, validate, write_private


def main():
    if platform.system() != 'Linux' or os.geteuid() == 0:
        raise SystemExit('Run as the normal Ubuntu user')
    settings_file = Path.home() / '.config/tesla-moonlight-ubuntu/internet.json'
    settings = json.loads(settings_file.read_text())
    supplied = json.load(sys.stdin)
    keys = {'cloudflare_turn_token_id', 'cloudflare_turn_api_token'}
    if not isinstance(supplied, dict) or set(supplied) != keys:
        raise SystemExit('Supply a JSON object with the two cloudflare_turn credential fields')
    settings.update(supplied)
    validate(settings)
    key_id = urllib.parse.quote(settings['cloudflare_turn_token_id'], safe='')
    request = urllib.request.Request(
        f'https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers',
        data=json.dumps({'ttl': 300}).encode(),
        headers={'Authorization': 'Bearer ' + settings['cloudflare_turn_api_token'],
                 'Content-Type': 'application/json', 'User-Agent': 'tesla-moonlight-ubuntu/0.1.0'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            generated = json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read(8192).decode('utf-8', errors='replace')
        try:
            detail = json.dumps(json.loads(body), ensure_ascii=False)[:700]
        except json.JSONDecodeError:
            title = re.search(r'<title>(.*?)</title>', body, re.I | re.S)
            detail = title.group(1).strip() if title else (
                body[:500] if error.headers.get('Content-Type', '').startswith('text/plain')
                else error.headers.get('Content-Type', 'unknown response'))
        detail = detail.replace(settings['cloudflare_turn_api_token'], '[redacted]')
        raise SystemExit(f'Cloudflare TURN validation failed: HTTP {error.code}: {detail}; configuration unchanged') from None
    servers = generated.get('iceServers', [])
    if isinstance(servers, dict):
        servers = [servers]
    if not any(server.get('username') and server.get('credential') for server in servers):
        raise SystemExit('Cloudflare did not return TURN credentials; configuration unchanged')
    write_private(settings_file, json.dumps(settings, indent=2) + '\n')
    print('Cloudflare TURN API validated; credentials saved privately.', flush=True)
    subprocess.run(['python3', str(ROOT / 'scripts/install-wsl.py'), '--config', str(settings_file)], check=True)


if __name__ == '__main__':
    main()
