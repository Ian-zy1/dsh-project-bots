#!/usr/bin/env python3
"""Preview an authorized Feishu dispatch to the configured DM or Owner Relay group."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path(os.environ.get(
        'DSH_SA_CONNECTION', str(Path.home() / 'Library/Application Support/dsh-sa/connection.json'))))
    parser.add_argument('--message', type=Path, required=True)
    parser.add_argument('--key', required=True, help='Stable key for this send; do not change after an uncertain result')
    parser.add_argument('--group', action='store_true', help='Use the configured Owner Relay group and mention DSH')
    parser.add_argument('--send', action='store_true', help='Actually send; requires prior user authorization')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    chat = config.get('ownerRelay', {}).get('chatId') if args.group else config.get('chatId')
    if not isinstance(chat, str) or not re.fullmatch(r'oc_[A-Za-z0-9]+', chat):
        raise ValueError('No verified Feishu chatId for the selected route')
    bot_id = config.get('botOpenId')
    if not isinstance(bot_id, str) or not re.fullmatch(r'ou_[A-Za-z0-9]+', bot_id):
        raise ValueError('No verified bot identity configured')
    message = args.message.read_text(encoding='utf-8')
    if not message.strip():
        raise ValueError('Message must not be empty')
    if args.group:
        message = f'<at user_id="{bot_id}">Superagent</at> {message.strip()}'
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,50}', args.key):
        raise ValueError('Idempotency key must be 1-50 letters, digits, underscores or hyphens')
    if not args.send:
        print(json.dumps({'mode': 'preview', 'identity': 'user', 'chatId': chat,
                          'botName': config.get('botName'), 'key': args.key, 'text': message}, ensure_ascii=False))
        return
    cli = Path(config['cli'])
    if not cli.is_absolute() or not cli.is_file():
        raise ValueError('Configure an existing absolute CLI path')
    env = dict(os.environ, LARKSUITE_CLI_CONFIG_DIR=config['larkConfigDir'],
               LARKSUITE_CLI_NO_UPDATE_NOTIFIER='1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER='1')
    result = subprocess.run([str(cli), 'im', '+messages-send', '--as', 'user', '--chat-id', chat,
                             '--text', '-', '--idempotency-key', args.key, '--format', 'json'],
                            input=message, text=True, capture_output=True, env=env, timeout=45)
    if result.returncode:
        # Native errors contain permission/action guidance; never fall back to bot or silently retry.
        print(result.stderr or result.stdout, file=sys.stderr)
        sys.exit(result.returncode)
    data = json.loads(result.stdout)
    if data.get('ok') is not True or data.get('identity') != 'user':
        raise ValueError('No verified user-identity send receipt; inspect the original operation before retry')
    if args.group and (data.get('data', {}).get('chat_id') != chat or not data.get('data', {}).get('message_id')):
        raise ValueError('No verified group message receipt; inspect the original operation before retry')
    print(json.dumps(data, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
