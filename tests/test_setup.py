import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('setup', ROOT / 'scripts/setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def settings(self, **overrides):
        settings = json.loads((ROOT / 'config/install.example.json').read_text())
        settings.update(web_password='test-only-long-password')
        settings.update(overrides)
        return settings

    def test_local_mode_has_auth_but_no_turn(self):
        settings = setup.validate(self.settings())
        config = setup.render_config(settings, Path('/home/user/runtime'))
        self.assertIsNone(config['cloudflare_turn'])
        self.assertEqual(config['bind_address'], '127.0.0.1:43780')
        self.assertTrue(config['credentials'])

    def test_public_mode_requires_turn(self):
        with self.assertRaises(ValueError):
            setup.validate(self.settings(public_hostname='stream.example.com'))
        with self.assertRaises(ValueError):
            setup.validate(self.settings(cloudflare_turn_token_id='only-one'))

    def test_turn_secret_never_written_to_config(self):
        settings = setup.validate(self.settings(public_hostname='stream.example.com',
                                 cloudflare_turn_token_id='id', cloudflare_turn_api_token='private-secret'))
        config = setup.render_config(settings, Path('/runtime'))
        self.assertNotIn('private-secret', json.dumps(config))
        self.assertEqual(config['external_url'], 'https://stream.example.com')

    def test_reconfigure_preserves_totp(self):
        config = setup.render_config(self.settings(), Path('/runtime'), {'totp_secret': 'EXISTING', 'web_path_prefix': ''})
        self.assertEqual(config['totp_secret'], 'EXISTING')

    def test_invalid_input_rejected(self):
        for changes in ({'web_password': 'short'}, {'web_password': 'CHANGE_ME_USE_AT_LEAST_16_CHARACTERS'},
                        {'public_hostname': 'https://example.com'}, {'public_hostname': '-bad.example.com'},
                        {'cloudflare_turn_api_token': 'line\nbreak'}, {'unknown': 'key'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                setup.validate(self.settings(**changes))

    def test_service_paths_escaped_and_no_tokens(self):
        unit = setup.render_service(Path('/home/space name/100%/runtime'), True)
        self.assertIn('100%%', unit)
        self.assertNotIn('Wants=sunshine', unit)
        self.assertNotIn('private-secret', unit)
        self.assertIn('Wants=app-dev.lizardbyte.app.Sunshine.service', setup.render_service(Path('/runtime'), False))
        with self.assertRaises(ValueError):
            setup.render_service(Path('/home/$bad/runtime'), True)

    def test_private_file_atomic_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'secret'
            setup.write_private(path, 'first')
            setup.write_private(path, 'second')
            self.assertEqual(path.read_text(), 'second')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(list(path.parent.iterdir())), 1)


if __name__ == '__main__':
    unittest.main()
