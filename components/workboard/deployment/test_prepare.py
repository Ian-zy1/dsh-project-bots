import importlib.util
import pathlib
import unittest

root = pathlib.Path(__file__).parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, root / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class PrepareTests(unittest.TestCase):
    def test_preserves_dsh_and_only_aw_has_default_startup(self):
        m = load('compose', 'prepare-compose.py')
        before = {'Name': '/dsh-existing', 'NetworkSettings': {'Networks': {'private': {}}},
                  'HostConfig': {'PortBindings': {}, 'RestartPolicy': {'Name': 'unless-stopped'}},
                  'Config': {'Image': 'dsh:existing', 'User': '1000:1000', 'WorkingDir': '/srv',
                             'Env': ['KEY=synthetic$literal'], 'Entrypoint': ['node'], 'Cmd': ['start.mjs']},
                  'Mounts': [{'Type': 'bind', 'Source': '/private/state', 'Destination': '/srv', 'RW': True}]}
        result = m.compose(before, pathlib.Path('/srv/shared'), pathlib.Path('/srv/release'), 'http://proxy.test/aw/', 'aw:candidate', 'node:24')
        dsh, aw = result['services']['superagent'], result['services']['agent-workboard']
        self.assertEqual(dsh['environment']['KEY'], 'synthetic$$literal')
        self.assertEqual(dsh['profiles'], ['dsh-maintenance'])
        self.assertEqual(dsh['image'], before['Config']['Image'])
        self.assertEqual(dsh['volumes'][0]['source'], '/private/state')
        self.assertNotIn('ports', aw)
        self.assertNotIn('KEY', aw['environment'])
        self.assertEqual(result['networks']['existing']['name'], 'private')

    def test_nginx_reuses_account_file_and_preserves_other_routes(self):
        m = load('nginx', 'prepare-nginx.py')
        source = 'server {\nlisten 19080;\nlocation /api/ { proxy_pass http://business; }\nlocation = /dsh { rewrite ^ /dsh/ last; }\nlocation ^~ /dsh/ {\nauth_basic "Existing";\nauth_basic_user_file /private/existing.htpasswd;\nproxy_pass http://existing;\n}\n}\n'
        result = m.render(source, (root / 'nginx.conf.example').read_text())
        self.assertIn('location /api/ { proxy_pass http://business; }', result)
        self.assertEqual(result.count('auth_basic_user_file /private/existing.htpasswd;'), 3)
        self.assertNotIn('dsh.htpasswd;', result)
        self.assertEqual(m.render(result, (root / 'nginx.conf.example').read_text()).count(m.START), 1)
        with self.assertRaises(ValueError):
            m.render(source.replace('location /api/', 'location /aw/'), (root / 'nginx.conf.example').read_text())


if __name__ == '__main__':
    unittest.main()
