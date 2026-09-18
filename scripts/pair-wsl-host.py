#!/usr/bin/env python3
"""Pair the local WSL Sunshine with the local web bridge, keeping secrets private."""
import base64
import json
import os
from pathlib import Path
import ssl
import time
import urllib.request


def main():
    home = Path.home()
    private = home / '.config/tesla-moonlight-ubuntu'
    bridge = home / '.local/share/tesla-moonlight-ubuntu'
    web_password = json.loads((bridge / 'server/config.json').read_text())['credentials']
    sunshine = json.loads((private / 'sunshine-wsl.json').read_text())
    authorization = 'Basic ' + base64.b64encode((sunshine['username'] + ':' + sunshine['password']).encode()).decode()
    cert = bridge / 'wsl-desktop/config/sunshine/credentials/cacert.pem'
    tls = ssl.create_default_context(cafile=str(cert))
    tls.check_hostname = False  # Trust the exact local generated certificate.

    def web(path, body=None, method=None):
        req = urllib.request.Request('http://127.0.0.1:43780/api/' + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + web_password}, method=method)
        return urllib.request.urlopen(req, timeout=30)

    def host(path, body=None, csrf=None):
        req = urllib.request.Request('https://127.0.0.1:47990/api/' + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type': 'application/json', 'Authorization': authorization,
                     **({'X-CSRF-Token': csrf} if csrf else {})})
        with urllib.request.urlopen(req, context=tls, timeout=35) as response:
            return json.load(response)

    with web('hosts') as response:
        hosts = json.load(response)['hosts']
    matching = [item for item in hosts if item['name'] == os.environ.get('TESLA_HOST_NAME', 'Ubuntu 26.04 WSL Desktop')]
    if matching:
        host_id = matching[0]['host_id']
    else:
        with web('host', {'address': '127.0.0.1', 'http_port': 47989}, 'PUT') as response:
            host_id = json.load(response)['host']['host_id']
    with web(f'host?host_id={host_id}&force_refresh=true') as response:
        details = json.load(response)['host']
    if details.get('paired') == 'Paired':
        print(f'Already paired: host {host_id}')
    else:
        csrf = host('csrf-token')['csrf_token']
        with web('pair', {'host_id': host_id}) as response:
            prefix = b''
            while len(prefix) < 1024:
                value = response.read(1)
                if not value:
                    raise RuntimeError('Pairing ended before a PIN was returned')
                prefix += value
                try:
                    first = json.loads(prefix)
                    break
                except json.JSONDecodeError:
                    continue
            else:
                raise RuntimeError('Invalid pairing response')
            pin = first['Pin']
            for _ in range(30):
                pending = host('pin')['pairings']
                local = [p for p in pending if p['address'] in ('127.0.0.1', '::ffff:127.0.0.1', '::1')]
                if len(local) == 1:
                    break
                time.sleep(.2)
            else:
                raise RuntimeError('No unique local Sunshine pairing request')
            result = host('pin', {'pairing_id': local[0]['id'], 'pin': pin, 'name': 'Tesla Ubuntu Web'}, csrf)
            if not result.get('status'):
                raise RuntimeError('Sunshine rejected pairing')
            paired = response.read().decode().strip()
            if 'Paired' not in paired:
                raise RuntimeError('Bridge did not finish pairing')
            print(f'Paired local Sunshine host {host_id}')
    with web(f'apps?host_id={host_id}') as response:
        apps = json.load(response)
    print(json.dumps(apps, indent=2))


if __name__ == '__main__':
    main()
