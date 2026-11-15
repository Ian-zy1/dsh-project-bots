#!/usr/bin/env python3
"""Preview or dispatch an approved fixed AW snapshot and register its receipt."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def message_for(brief, context, config):
    snapshot, task, project = brief['snapshot'], context['task'], context['project']
    task_id, revision, sha = snapshot['taskId'], snapshot['revision'], snapshot['digest']
    if (not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', task_id)
            or type(revision) is not int or revision < 1 or not re.fullmatch(r'[a-f0-9]{64}', sha)
            or task_id != task['id'] or revision != task['revision']
            or task['projectId'] != project['id'] or project['id'] != config['awProjectId']
            or snapshot['projectRevision'] != project['revision']
            or snapshot['requirementRevision'] != context['requirement']['revision']):
        raise ValueError('AW snapshot, task version or configured project differs')
    paragraph = re.split(r'\n\s*\n', task['description'].strip(), maxsplit=1)[0]
    text = ' '.join(paragraph.split())
    scope = re.split(r'(?<=[。！？])|(?<=[.!?])\s+', text, maxsplit=1)[0]
    if not task['acceptance'].strip() or not 8 <= len(scope) <= 180 or re.search(r'[<>\x00-\x1f]', scope):
        raise ValueError('AW task needs a short, executable opening sentence and explicit acceptance conditions')
    intent = {'projectId': project['id'], 'taskId': task_id, 'revision': revision, 'snapshotDigest': sha,
              'phase': 'implement', 'chatId': config['ownerRelay']['chatId']}
    line = f'AW taskId={task_id} revision={revision} phase=implement scope={scope}'
    return intent, line


def write_private(path, doc):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, encoding='utf-8', delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(doc, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        # Refuse to overwrite a previous attempt's evidence.
        os.link(temporary, path)
    finally:
        temporary.unlink()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config', type=Path, required=True)
    p.add_argument('--brief', type=Path, required=True)
    p.add_argument('--snapshot', type=Path, required=True)
    p.add_argument('--key', required=True)
    p.add_argument('--receipt', type=Path, help='Private, stable path for the verified send receipt')
    p.add_argument('--send', action='store_true', help='Send once after the fixed scope has been explicitly approved')
    args = p.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,50}', args.key):
        raise ValueError('Invalid send idempotency key')
    config = read_json(args.config)
    intent, text = message_for(read_json(args.brief), read_json(args.snapshot), config)
    relay = config['ownerRelay']
    sender = [sys.executable, str(Path(__file__).with_name('feishu_dm.py')),
              '--config', str(args.config), '--group', '--key', args.key]
    with tempfile.TemporaryDirectory() as work:
        message = Path(work) / 'message.txt'
        message.write_text(text, encoding='utf-8')
        sender += ['--message', str(message)]
        preview = subprocess.run(sender, check=True, capture_output=True, text=True, timeout=5)
        if not args.send:
            print(preview.stdout, end='')
            return
        if relay.get('autoDispatchBinding') is not True or not args.receipt or not args.receipt.is_absolute():
            raise ValueError('Automatic binding must be enabled in the selected local Relay configuration and has a stable receipt path')
        if not args.receipt.parent.is_dir() or not os.environ.get('CODEX_THREAD_ID'):
            raise ValueError('Run approval and dispatch from the original Owner chat and existing receipt directory')
        cli = ['node', relay['entrypoint']]
        env = dict(os.environ, OWNER_RELAY_CONFIG=relay['configPath'])
        if args.receipt.exists():
            raise ValueError('Send receipt already exists. Reconcile it with record-dispatch-receipt; do not send again.')
        lark_env = dict(os.environ, LARKSUITE_CLI_CONFIG_DIR=config['larkConfigDir'],
                        LARKSUITE_CLI_NO_UPDATE_NOTIFIER='1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER='1')
        auth = subprocess.run([config['cli'], 'auth', 'status', '--json', '--verify'], check=True,
                              capture_output=True, text=True, timeout=15, env=lark_env)
        status = json.loads(auth.stdout)
        scopes = status.get('identities', {}).get('user', {}).get('scope', '').split()
        if (status.get('verified') is not True or status.get('identity') != 'user'
                or not {'im:message', 'im:message.send_as_user'}.issubset(scopes)):
            raise ValueError('Verify authorization for the experimental Feishu user before sending')
        request = Path(work) / 'intent.json'
        request.write_text(json.dumps({**intent, 'dispatchId': args.key, 'authorized': True,
                                       'contextRef': str(args.snapshot.resolve())}), encoding='utf-8')
        subprocess.run([*cli, 'prepare-dispatch', str(request)], check=True, timeout=10, env=env)
        try:
            sent = subprocess.run([*sender, '--send'], capture_output=True, text=True, check=True, timeout=50)
            receipt = json.loads(sent.stdout)
            write_private(args.receipt, receipt)
            subprocess.run([*cli, 'record-dispatch-receipt', args.key, str(args.receipt)], check=True, timeout=10, env=env)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise ValueError('Dispatch outcome needs reconciliation. Keep the original key and receipt, and check the original message before any retry.') from error
        print(json.dumps({'status': 'sent', 'originMessageId': receipt['data']['message_id'], 'dispatchId': args.key},
                         ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (OSError, KeyError, TypeError, ValueError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
