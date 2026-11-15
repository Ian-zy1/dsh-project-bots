#!/usr/bin/env python3
"""Prepare a private shared Compose file from the running DSH definition; never restart DSH."""
import argparse
import json
from pathlib import Path
import subprocess


def compose(inspect, root, release, public_url, image, node_image, offline_base=None):
    networks = inspect['NetworkSettings']['Networks']
    if len(networks) != 1 or inspect['HostConfig'].get('PortBindings'):
        raise ValueError('Expected one private DSH network and no published DSH ports')
    if any(m['Type'] != 'bind' for m in inspect['Mounts']):
        raise ValueError('Review non-bind DSH mounts before preparing Compose')
    config = inspect['Config']
    # Compose interpolates dollar signs even in JSON/YAML strings. Escape existing environment values.
    env = {k: v.replace('$', '$$') for k, v in (item.split('=', 1) for item in config['Env'])}
    dsh = {'image': config['Image'], 'container_name': inspect['Name'].lstrip('/'),
           'profiles': ['dsh-maintenance'], 'restart': inspect['HostConfig']['RestartPolicy']['Name'],
           'user': config['User'], 'working_dir': config['WorkingDir'], 'environment': env,
           'entrypoint': config['Entrypoint'], 'command': config['Cmd'], 'networks': ['existing'],
           'volumes': [{'type': 'bind', 'source': m['Source'], 'target': m['Destination'], 'read_only': not m['RW']} for m in inspect['Mounts']]}
    aw = {'image': image, 'container_name': 'agent-workboard', 'restart': 'unless-stopped',
          'build': {'context': str(release), 'dockerfile': 'deployment/Dockerfile', 'args': {'NODE_IMAGE': node_image}},
          'environment': {'WORKBOARD_HOST': '0.0.0.0', 'WORKBOARD_PORT': '4180', 'WORKBOARD_DB': '/data/workboard.sqlite',
                          'WORKBOARD_PUBLIC_URL': public_url},
          'volumes': [{'type': 'bind', 'source': str(root / 'aw-data'), 'target': '/data'}],
          'networks': ['existing'], 'security_opt': ['no-new-privileges:true'], 'cap_drop': ['ALL']}
    if offline_base:
        aw['build'].update({'dockerfile': 'deployment/Dockerfile.offline', 'args': {'BASE_IMAGE': offline_base}})
    return {'x-agent-workboard-managed': True, 'services': {'superagent': dsh, 'agent-workboard': aw},
            'networks': {'existing': {'external': True, 'name': next(iter(networks))}}}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--release', type=Path, required=True)
    p.add_argument('--public-url', required=True)
    p.add_argument('--image', required=True)
    p.add_argument('--node-image', default='node:24.18.0-bookworm-slim')
    p.add_argument('--offline-base-image', help='Use bundled Node 24 with an already available Debian base image')
    p.add_argument('--dsh-container', default='dsh-superagent-extensions')
    a = p.parse_args()
    root, release = a.root.resolve(), a.release.resolve()
    value = json.loads(subprocess.check_output(['docker', 'inspect', a.dsh_container]))[0]
    if a.offline_base_image and not (release / 'runtime/node').is_file():
        raise ValueError('Offline deployment requires the verified runtime/node in the release bundle')
    result = compose(value, root, release, a.public_url, a.image, a.node_image, a.offline_base_image)
    target = root / 'docker-compose.yml'
    if target.exists() and not json.loads(target.read_text()).get('x-agent-workboard-managed'):
        raise ValueError('Existing Compose is not owned by this deployment; preserve it')
    if target.exists():
        backup = root / 'private' / 'docker-compose.before-aw.yml'
        backup.parent.mkdir(mode=0o700, exist_ok=True)
        if not backup.exists():
            backup.write_bytes(target.read_bytes()); backup.chmod(0o600)
    target.write_text(json.dumps(result, indent=2) + '\n'); target.chmod(0o600)
    data = root / 'aw-data'; data.mkdir(mode=0o700, exist_ok=True)
    print('Prepared shared Compose; existing DSH is maintenance-only. Start only agent-workboard.')


if __name__ == '__main__':
    main()
