import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createConnection, createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = '/state';
const privateConfig = '/config';
const plugin = '/opt/superagent';
for (const name of ['home', 'dsh', 'superagent', 'bin', 'lark']) {
  mkdirSync(root + '/' + name, { recursive: true, mode: 0o700 });
}
const file = name => privateConfig + '/' + name;
const instance = JSON.parse(readFileSync(file('instance.json'), 'utf8'));
const port = Number(process.env.DSH_WEB_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DSH web port');
const configured = instance.superagent ?? {};
const enabled = instance.enabledFeishu === true;
const larkDir = root + '/lark';
let botId;
if (enabled) {
  const account = JSON.parse(readFileSync(file('feishu.json'), 'utf8'));
  if (!/^cli_[A-Za-z0-9]+$/.test(account.appId) || typeof account.appSecret !== 'string' || !account.appSecret.trim()) {
    throw new Error('Invalid Feishu bot configuration');
  }
  botId = account.appId;
  const marker = larkDir + '/app-id';
  if (existsSync(marker) && readFileSync(marker, 'utf8') !== botId) throw new Error('Use a separate instance state volume for a different Bot');
  const env = { ...process.env, LARKSUITE_CLI_CONFIG_DIR: larkDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1' };
  execFileSync('lark-cli', ['config', 'init', '--app-id', botId, '--app-secret-stdin'], {
    input: account.appSecret + '\n', env, stdio: ['pipe', 'ignore', 'ignore'], timeout: 30_000
  });
  execFileSync('lark-cli', ['config', 'strict-mode', 'bot', '--global'], { env, stdio: 'ignore', timeout: 30_000 });
  writeFileSync(marker, botId, { mode: 0o600 });
  writeFileSync(root + '/bin/lark-bot', '#!/bin/sh\nexport LARKSUITE_CLI_CONFIG_DIR=/state/lark\nexec /opt/runtime/node_modules/.bin/lark-cli "$@"\n', { mode: 0o700 });
}
const database = root + '/superagent/orchestrator.sqlite';
const db = new DatabaseSync(database);
db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
const get = db.prepare('SELECT value FROM kv WHERE key = ?');
const previousRevision = Number(get.get('settings-revision')?.value ?? 0);
const previous = previousRevision ? JSON.parse(get.get('settings-version:' + previousRevision).value) : undefined;
const existingSource = previous?.settings.sources?.feishu;
if (!previous || (enabled && !existingSource?.config?.cli)) {
  const feishu = { enabled, config: enabled ? { ...instance.feishuSource, ...existingSource?.config, cli: root + '/bin/lark-bot' } : {} };
  const settings = previous ? {
    ...previous.settings, sources: { ...previous.settings.sources, feishu }
  } : {
    sources: {
    github: { enabled: instance.enabledGitHubEvents === true, config: instance.github ?? {} },
    feishu
    },
    ...(instance.policy ? { policy: instance.policy } : {})
  };
  const revision = previousRevision + 1;
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO kv VALUES (?,?)').run('settings-version:' + revision, JSON.stringify({
    revision, previousRevision: previousRevision || null, savedAt: new Date().toISOString(),
    source: 'internal', policyVersion: previous?.policyVersion ?? '', policyChanged: false, notified: [], settings
  }));
  db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run('settings-revision', String(revision));
  db.exec('COMMIT');
}
db.close();
let patch = readFileSync(plugin + '/cordis.patch.yml', 'utf8');
for (const [name, entry] of [['github-watch', 'github-watch'], ['feishu-watch', 'feishu-watch'], ['gitlab-watch', 'gitlab-watch'], ['dingtalk-watch', 'dingtalk-watch'], ['', 'index']]) {
  const key = name ? 'dsh-superagent/' + name : 'dsh-superagent';
  patch = patch.replace('name: ' + key + '\n', 'name: ' + pathToFileURL(plugin + '/lib/' + entry + '.js').href + '\n');
}
const publicURL = 'http://127.0.0.1:' + port + '/';
const overrides = [
  { id: 'dsh-superagent', config: { ...configured, stateDir: root + '/superagent', repositoryProvider: 'github', publicWebOrigin: publicURL.slice(0, -1), ...(botId ? { expectedFeishuAppId: botId } : {}) } },
  { id: 'dsh-superagent-feishu', disabled: !enabled }
];
writeFileSync(root + '/runtime.patch.yml', patch + '\n' + overrides.map(row => '- ' + JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
const address = Object.values(networkInterfaces()).flat().find(row => row.family === 'IPv4' && !row.internal)?.address;
if (!address) throw new Error('Expected a concrete Docker network address');
const args = ['web', '--patch', root + '/runtime.patch.yml', '--no-open', '--host', '127.0.0.1', '--port', '3081',
  '--public-url', publicURL, '--trusted-host', '127.0.0.1:' + port];
if (existsSync(file('model.patch.yml'))) args.push('--patch', file('model.patch.yml'));
// Compose exposes only the host's loopback. Keep the native DSH listener on
// its own loopback too, and forward WebSocket and HTTP bytes unchanged.
const proxy = createServer(socket => {
  const native = createConnection({ host: '127.0.0.1', port: 3081 });
  socket.on('error', () => native.destroy());
  native.on('error', () => socket.destroy());
  socket.pipe(native).pipe(socket);
});
const child = spawn('dsh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
for (const output of [child.stdout, child.stderr]) {
  createInterface({ input: output }).on('line', line => {
    const access = line.match(/dsh web:\s+(https?:\/\/\S+)/)?.[1];
    if (access) {
      const url = new URL(access);
      if (url.origin === new URL(publicURL).origin && url.searchParams.has('token')) {
        writeFileSync(root + '/web-url', url.href + '\n', { mode: 0o600 });
      }
    }
    console.log(line.replace(/([?&]token=)[^\s]+/g, '$1[redacted]'));
  });
}
proxy.once('error', () => child.kill());
proxy.listen(3080, address);
child.on('error', () => { console.error('Unable to start DSH'); process.exitCode = 1; proxy.close(); });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGTERM' ? 0 : 1); proxy.close(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
