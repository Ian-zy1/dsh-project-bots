#!/usr/bin/env python3
"""Configured AW HTTP access and read-only Superagent access. No dispatch or retry."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from urllib.parse import unquote, urlsplit


def plan(config, args):
    path = args.path or ''
    parsed = urlsplit(path)
    if (not path.startswith('/') or path.startswith('//') or parsed.scheme or parsed.netloc
            or parsed.fragment or any(c in path for c in '\r\n')
            or '..' in unquote(parsed.path).split('/')):
        raise ValueError('Use an API-relative path, e.g. /state or /tasks/ID/context?revision=1')
    if args.target == 'sa':
        if not re.fullmatch(r'/(state|overview|sources|search|tickets(?:/[\w-]+)?)', parsed.path):
            raise ValueError('Unsupported Superagent read route; use state/search/tickets')
    elif not re.fullmatch(r'/(projects|requirements|tasks)(?:/[\w-]+)*', parsed.path):
        raise ValueError('Unsupported AW path')
    if args.target != 'aw' and args.method != 'GET':
        raise ValueError('Superagent and Worker-AW access is read-only')
    if args.method == 'GET' and args.body:
        raise ValueError('GET must not have a body')
    if args.method != 'GET' and not args.body:
        raise ValueError('AW writes require --body with a JSON object')
    body = json.loads(args.body.read_text()) if args.body else None
    if body is not None and not isinstance(body, dict):
        raise ValueError('Request body must be a JSON object')
    if args.key and not re.fullmatch(r'[A-Za-z0-9_.:-]{1,120}', args.key):
        raise ValueError('Invalid idempotency key')
    if (args.method == 'POST' and re.fullmatch(
            r'/(requirements/[\w-]+/tasks|tasks/[\w-]+/candidates(?:/[\w-]+/reports)?)', parsed.path)
            and not args.key):
        raise ValueError('This AW write requires a stable --key; no request was sent')
    access = config['awAccess' if args.target == 'aw' else 'superagentAccess']
    payload = {'path': path, 'method': args.method, 'body': body, 'key': args.key}
    if args.target == 'sa':
        payload['base'] = 'http://127.0.0.1:3081/orchestrator/api'
        payload['management'] = True
    else:
        payload['base'] = access['internalApiBase' if args.target == 'aw' else 'workerAwApiBase']
    js = 'const p=' + json.dumps(payload, ensure_ascii=False) + ';' + r"""
const safeDetail=value=>String(value)
  .replace(/https?:\/\/[^\s"<>]+/gi,'[url]')
  .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi,'$1 [redacted]')
  .replace(/((?:token|secret|password|authorization|api[_-]?key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"'<>]+)/gi,'$1[redacted]')
  .replace(/[\x00-\x1f\x7f]/g,' ').slice(0,400);
const fail=value=>{console.log('DSH_SA_ERROR='+JSON.stringify(value));process.exitCode=1};
let stage='configuration';
(async()=>{
  const base=p.base.replace(/\/$/,'');
  const u=new URL(base);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Invalid API base');
  const headers={'Accept':'application/json',...(p.management?{'X-Orchestrator-Request':'1'}:{})};
  if(p.body!==null)headers['Content-Type']='application/json';
  if(p.key)headers['Idempotency-Key']=p.key;
  stage='request';
  const response=await fetch(base+p.path,{method:p.method,headers,redirect:'error',signal:AbortSignal.timeout(15000),
    ...(p.body!==null?{body:JSON.stringify(p.body)}:{})});
  if(!response.ok){
    let detail='';
    try{const data=await response.json();if(!p.management&&typeof data.error==='string')detail=safeDetail(data.error)}catch{}
    fail({status:response.status,detail});return;
  }
  console.log('DSH_SA_RESULT='+JSON.stringify(await response.json()));
})().catch(()=>fail({detail:stage==='configuration'
  ?'Configured endpoint unavailable; no HTTP request sent'
  :'API request failed; outcome unconfirmed. Inspect original receipt before retry'}));
"""
    compose = config['compose']
    project = compose['project']
    compose_file = compose['file']
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project) or not Path(compose_file).is_absolute():
        raise ValueError('Use a valid Compose project and an absolute Compose file path')
    service = 'workboard' if args.target == 'aw' else 'dsh'
    command = ['docker', 'compose', '-p', project, '-f', compose_file]
    if compose.get('envFile'):
        env_file = compose['envFile']
        if not Path(env_file).is_absolute():
            raise ValueError('Use an absolute Compose env file path')
        command.extend(['--env-file', env_file])
    command.extend(['exec', '-T', service, 'node', '-e', js])
    if ssh_target := compose.get('sshTarget'):
        if not re.fullmatch(r'(?:[a-zA-Z0-9_][\w.-]*@)?[a-zA-Z0-9][\w.-]*', ssh_target):
            raise ValueError('Use an SSH host alias or a user@host')
        command = ['ssh', '-o', 'BatchMode=yes', '--', ssh_target, shlex.join(command)]
    return command, {
        'composeProject': project, 'service': service, 'target': args.target,
        'method': args.method, 'path': path}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('target', choices=['connection', 'sa', 'aw', 'worker-aw'])
    p.add_argument('path', nargs='?')
    p.add_argument('--config', type=Path, default=Path(os.environ.get('DSH_SA_CONNECTION',
                   str(Path.home() / 'Library/Application Support/dsh-sa/connection.json'))))
    p.add_argument('--method', choices=['GET', 'POST', 'PUT', 'PATCH'], default='GET')
    p.add_argument('--body', type=Path)
    p.add_argument('--key')
    p.add_argument('--output', type=Path)
    p.add_argument('--dry-run', action='store_true', help='Validate locally without sending a request')
    args = p.parse_args()
    config = json.loads(args.config.read_text())
    if args.target == 'connection':
        view = {k: config.get(k) for k in ['preferredChannel', 'backupChannel', 'awBaseUrl', 'awProjectId', 'compose', 'awAccess', 'superagentAccess', 'ownerRelay']}
        for channel in ['feishu', 'dingtalk']:
            view[channel] = {k: config.get(channel, {}).get(k) for k in
                             ['botName', 'sourceStatus', 'sourceVerification', 'connectionStatus']}
        print(json.dumps(view, ensure_ascii=False, indent=2))
        return
    argv, view = plan(config, args)
    if args.dry_run:
        print(json.dumps({'mode': 'dry-run', **view}, ensure_ascii=False, indent=2))
        return
    try:
        result = subprocess.run(argv, text=True, capture_output=True, timeout=40)
    except subprocess.TimeoutExpired:
        raise ValueError('API execution timed out; outcome unconfirmed. Inspect original receipt before retry') from None
    errors = [line[len('DSH_SA_ERROR='):] for line in result.stdout.splitlines()
              if line.startswith('DSH_SA_ERROR=')]
    if errors:
        if len(errors) != 1:
            raise ValueError('Ambiguous API error; inspect original receipt before retry')
        error = json.loads(errors[0])
        status = error.get('status')
        label = f'HTTP {status}' if isinstance(status, int) and 400 <= status <= 599 else 'API error'
        raise ValueError(f"{label}: {error.get('detail') or 'No structured error detail'}; no request was retried")
    if result.returncode:
        raise ValueError('Compose or SSH execution failed; outcome unconfirmed. Check the configured instance before retry')
    lines = [line[len('DSH_SA_RESULT='):] for line in result.stdout.splitlines()
             if line.startswith('DSH_SA_RESULT=')]
    if len(lines) != 1:
        raise ValueError('No unambiguous API receipt; inspect original request before retry')
    data = json.loads(lines[0])
    output = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.write_text(output)
        print(json.dumps({'saved': str(args.output), **view}, ensure_ascii=False))
    else:
        print(output, end='')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
