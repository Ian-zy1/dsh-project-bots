#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { State, Relay, digest, validateProjectPublishers } from './relay.mjs';
import { NativeQueue } from './native-queue.mjs';
import { catchup as readHistory } from './history.mjs';
import { writeQueueSnapshot } from './queue-projection.mjs';
import { attachDispatchReceipt, reserveDispatch } from './dispatch.mjs';

const file = process.env.OWNER_RELAY_CONFIG ?? join(homedir(), 'Library/Application Support/owner-relay/connection.json');
const command = process.argv[2];
const c = JSON.parse(readFileSync(file, 'utf8'));
const projectionFile = command === 'queue-export' ? process.argv[3] : c.queueProjectionFile;
if ((projectionFile !== undefined || command === 'queue-export')
    && (!projectionFile || !isAbsolute(projectionFile) || [file, c.stateFile].map(value => resolve(value)).includes(resolve(projectionFile))))
  throw Error('Queue projection requires a separate absolute file path');
validateProjectPublishers(c.projectPublishers);
if (c.dispatchWaitMs !== undefined && (!Number.isSafeInteger(c.dispatchWaitMs) || c.dispatchWaitMs < 1))
  throw Error('dispatchWaitMs must be a positive integer');
c.cliPath = fileURLToPath(import.meta.url);
c.configPath = process.env.OWNER_RELAY_CONFIG ? resolve(file) : undefined;
const state = new State(c.stateFile, { readOnly: command === 'queue-export' });
const env = { ...process.env, LARKSUITE_CLI_CONFIG_DIR: c.larkConfigDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
const execute = promisify(execFile);
const abort = new AbortController();
async function lark(args) {
  const { stdout } = await execute(c.larkCli, [...args, '--as', 'bot', '--format', 'json'], { env, signal: abort.signal, timeout: 25000, maxBuffer: 2_000_000 });
  const r = JSON.parse(stdout);
  if (!r.ok || r.identity !== 'bot') throw Error('Unverified bot API result');
  return r;
}
const notify = async (item, text, stage) => {
  const r = await lark(['im', '+messages-reply', '--message-id', item.event.messageId, '--reply-in-thread', '--text', text,
    '--idempotency-key', digest(`${item.event.eventId}:${stage}`).slice(0, 40)]);
  if (!r.data?.message_id) throw Error('No IM delivery receipt');
  return { messageId: r.data.message_id, chatId: r.data.chat_id, ...(r.data.thread_id ? { threadId: r.data.thread_id } : {}) };
};
async function run() {
  const lock = join(dirname(c.stateFile), 'runner.lock');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw Error('Receiver lock exists; inspect the recorded PID before starting another receiver'); }
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  const owner = new NativeQueue(c.owner);
  const relay = new Relay(state, owner, notify, c);
  let stopping = false, ticking = false, catchingUp = false;
  let tickWork = Promise.resolve(), historyWork = Promise.resolve();
  const log = (stage, extra = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), stage, ...extra }));
  function publishQueue(live) {
    if (!projectionFile) return;
    try { writeQueueSnapshot(projectionFile, state.data.inbox, live); }
    catch { log('queue_projection_unavailable'); }
  }
  async function tick() {
    if (ticking || stopping) return;
    ticking = true;
    tickWork = relay.tick();
    try { await tickWork; } catch { log('processing_failed'); } finally { ticking = false; }
  }
  async function catchup() {
    if (catchingUp || stopping) return;
    catchingUp = true;
    try {
      historyWork = readHistory(lark, state, relay, c);
      await historyWork; log('history_caught_up');
    } catch { log('history_unavailable', { action: 'Offline recovery not verified; cursor retained' }); }
    finally { catchingUp = false; }
  }
  const child = spawn(c.larkCli, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const childExited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  // Keep stdin open: unbounded lark event consumers stop on EOF.
  child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', line => {
    if (stopping) return;
    try {
      const m = JSON.parse(line);
      relay.receive(m).then(accepted => { if (accepted) log('received', { messageId: m.message_id }); }).catch(() => log('receive_rejected'));
    } catch { log('event_parse_rejected'); }
  });
  createInterface({ input: child.stderr }).on('line', line => {
    if (line.includes('[event] ready')) { log('listening'); void catchup(); }
    if (line.includes('feishu-websocket: connected')) { log('feishu_connected'); void catchup(); }
  });
  const interval = setInterval(() => void tick(), 3000);
  const projectionInterval = projectionFile ? setInterval(() => publishQueue(true), 10000) : undefined;
  publishQueue(true);
  async function stop() {
    if (stopping) return;
    stopping = true; clearInterval(interval); clearInterval(projectionInterval); relay.stop(); abort.abort(); child.kill('SIGTERM'); owner.close();
    await Promise.allSettled([tickWork, historyWork, childExited]);
    publishQueue(false);
    state.close(); rmSync(lock, { recursive: true }); log('stopped');
  }
  child.on('error', () => { log('event_consumer_failed'); void stop(); });
  child.on('exit', () => { if (!stopping) { log('event_consumer_exited'); void stop(); } });
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
  if (c.testDurationMs) setTimeout(() => void stop(), c.testDurationMs).unref();
  log('started', { dispatch: 'Native Codex queue; explicit original Owner binding; no automatic resume' });
}

try {
  if (command === 'bind') {
    const b = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    if (b.threadId !== process.env.CODEX_THREAD_ID || b.cwd !== process.cwd()) throw Error('Bind from the original Owner session and workspace');
    state.bind(b); console.log('Owner binding saved'); state.close();
  }
  else if (command === 'prepare-dispatch') {
    const info = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    reserveDispatch(state, { ...info, threadId: process.env.CODEX_THREAD_ID, cwd: process.cwd() }, c);
    console.log('Owner dispatch registered'); state.close();
  }
  else if (command === 'record-dispatch-receipt') {
    const receipt = JSON.parse(readFileSync(process.argv[4], 'utf8'));
    if (receipt.ok !== true || receipt.identity !== 'user') throw Error('Expected the verified user send receipt');
    attachDispatchReceipt(state, process.argv[3], { chatId: receipt.data?.chat_id, originMessageId: receipt.data?.message_id },
      { threadId: process.env.CODEX_THREAD_ID, cwd: process.cwd() });
    console.log('Dispatch receipt registered'); state.close();
  }
  else if (command === 'started') { state.started(process.argv[3], process.env.CODEX_THREAD_ID, process.cwd()); console.log('Original Owner execution acknowledged'); state.close(); }
  else if (command === 'complete') {
    state.started(process.argv[3], process.env.CODEX_THREAD_ID, process.cwd());
    state.complete(process.argv[3], JSON.parse(readFileSync(process.argv[4], 'utf8'))); console.log('Review receipt saved'); state.close();
  }
  else if (command === 'status') { console.log(JSON.stringify(state.data, null, 2)); state.close(); }
  else if (command === 'queue-export') { writeQueueSnapshot(projectionFile, state.data.inbox, false); state.close(); console.log('Owner queue snapshot exported'); }
  else if (command === 'run') await run();
  else throw Error('Use run | status | queue-export | bind | prepare-dispatch | record-dispatch-receipt | started | complete');
} catch { console.error('Owner Relay operation failed; inspect local configuration and pending receipts. No automatic redispatch.'); process.exitCode = 1; }
