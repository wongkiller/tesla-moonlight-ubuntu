import base64
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


container = module('container_setup', 'container-setup.py')
route = module('container_route', 'configure-container-route.py')


class ContainerTests(unittest.TestCase):
    def settings(self):
        return dict(public_hostname='screen.example.com', web_password='example-test-password',
                    cloudflare_turn_token_id='turn-id', cloudflare_turn_api_token='turn-secret',
                    cloudflare_tunnel_token=base64.b64encode(json.dumps({'a': 'a' * 32, 't': 'b' * 32}).encode()).decode(),
                    cloudflare_api_token='management-secret', cloudflare_zone_id='c' * 32)

    def test_public_config_requires_connector(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'internet.json'
            settings = self.settings()
            settings['cloudflare_tunnel_token'] = ''
            path.write_text(json.dumps(settings))
            with self.assertRaisesRegex(ValueError, 'cloudflare_tunnel_token'):
                container.read_settings(path)

    def test_unknown_and_multiline_values_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'internet.json'
            for changes in ({'command': 'unsafe'}, {'cloudflare_api_token': 'bad\nvalue'}):
                path.write_text(json.dumps(self.settings() | changes))
                with self.assertRaises(ValueError):
                    container.read_settings(path)

    def test_route_preserves_other_hosts_and_origin_settings(self):
        requests = []
        old = {'ingress': [{'hostname': 'other.example.com', 'service': 'http://localhost:9000'},
                           {'service': 'http_status:404'}], 'originRequest': {'connectTimeout': 30}}

        def response(request, **kwargs):
            requests.append(request)
            result = [] if 'dns_records?' in request.full_url else {'config': old}
            return io.BytesIO(json.dumps({'success': True, 'result': result}).encode())

        with patch.object(route.urllib.request, 'urlopen', side_effect=response):
            route.configure(self.settings())
        update = next(r for r in requests if r.method == 'PUT')
        body = json.loads(update.data)['config']
        self.assertEqual(body['ingress'][1:], old['ingress'])
        self.assertEqual(body['originRequest'], old['originRequest'])
        self.assertEqual(body['ingress'][0]['service'], 'http://localhost:8080')
        dns = next(r for r in requests if r.method == 'POST')
        self.assertTrue(json.loads(dns.data)['proxied'])

    def test_conflicting_dns_is_never_overwritten(self):
        with patch.object(route.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps({
                'success': True, 'result': [{'type': 'A', 'content': '192.0.2.1'}]}).encode())) as request:
            with self.assertRaisesRegex(RuntimeError, 'different DNS'):
                route.configure(self.settings())
            self.assertEqual(request.call_count, 1)

    def test_existing_connector_only_never_calls_management_api(self):
        settings = self.settings() | {'cloudflare_api_token': ''}
        with patch.object(route.urllib.request, 'urlopen') as request:
            route.configure(settings)
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
