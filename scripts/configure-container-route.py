#!/usr/bin/env python3
"""Optionally configure the requested hostname using explicitly supplied API rights."""
import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def configure(settings):
    hostname = settings.get('public_hostname')
    api_token = settings.get('cloudflare_api_token')
    if not hostname:
        return
    if not api_token:
        print('Using an existing Cloudflare route: ' + hostname + ' -> http://localhost:8080')
        print('Automatic DNS/route changes require cloudflare_api_token and cloudflare_zone_id.')
        return
    try:
        token = settings['cloudflare_tunnel_token']
        connector = json.loads(base64.b64decode(token + '=' * (-len(token) % 4)))
        account, tunnel = connector['a'], connector['t']
        if not all(isinstance(v, str) and all(c in '0123456789abcdefABCDEF-' for c in v) for v in (account, tunnel)):
            raise ValueError()
    except (ValueError, KeyError):
        raise ValueError('Cannot obtain account/tunnel IDs from the supplied connector token') from None
    zone = settings['cloudflare_zone_id']
    if not zone or any(c not in '0123456789abcdefABCDEF' for c in zone):
        raise ValueError('cloudflare_zone_id must be a hexadecimal zone ID')

    def api(path, method='GET', body=None):
        request = urllib.request.Request('https://api.cloudflare.com/client/v4/' + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + api_token, 'Content-Type': 'application/json',
                     'User-Agent': 'tesla-moonlight-ubuntu'}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'Cloudflare API HTTP {error.code}; check Zone DNS Edit and Account Cloudflare Tunnel Edit permissions') from None
        if not result.get('success'):
            raise RuntimeError('Cloudflare API rejected the configuration; check token scope and IDs')
        return result['result']

    dns_path = f'zones/{zone}/dns_records'
    existing = api(dns_path + '?' + urllib.parse.urlencode({'name': hostname}))
    destination = tunnel + '.cfargotunnel.com'
    if len(existing) > 1 or any(r.get('type') != 'CNAME' or r.get('content', '').rstrip('.') != destination for r in existing):
        raise RuntimeError('Hostname already has a different DNS record. Refusing to replace unrelated DNS; use a new hostname or the matching tunnel.')
    tunnel_path = f'accounts/{account}/cfd_tunnel/{tunnel}/configurations'
    current = api(tunnel_path).get('config') or {}
    ingress = current.get('ingress') or [{'service': 'http_status:404'}]
    route = {'hostname': hostname, 'service': 'http://localhost:8080'}
    found = False
    updated = []
    for item in ingress:
        if item.get('hostname') == hostname:
            updated.append({**item, 'service': route['service']})
            found = True
        else:
            updated.append(item)
    if not found:
        updated.insert(0, route)
    if updated != ingress:
        api(tunnel_path, 'PUT', {'config': {**current, 'ingress': updated}})
    if not existing:
        api(dns_path, 'POST', {'type': 'CNAME', 'name': hostname, 'content': destination, 'proxied': True, 'ttl': 1})
    elif not existing[0].get('proxied'):
        api(dns_path + '/' + existing[0]['id'], 'PATCH', {'proxied': True})
    print('Cloudflare hostname route ready: https://' + hostname)


if __name__ == '__main__':
    try:
        configure(json.loads(Path(sys.argv[1]).read_text()))
    except (ValueError, KeyError, OSError, RuntimeError) as error:
        message = 'Invalid private JSON' if isinstance(error, json.JSONDecodeError) else str(error)
        raise SystemExit(message) from None
