import { isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';

export function publicUrl(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(url.pathname) || url.href !== value) {
    throw new Error('WORKBOARD_PUBLIC_URL must be an exact HTTP(S) URL ending in /, without credentials, query or fragment');
  }
  return url;
}

export function startupConfig(env = process.env) {
  const port = Number(env.WORKBOARD_PORT ?? 4180);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WORKBOARD_PORT must be a port number');
  const host = env.WORKBOARD_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '0.0.0.0', '::1', '::'].includes(host)) throw new Error('Unsupported WORKBOARD_HOST');
  const external = publicUrl(env.WORKBOARD_PUBLIC_URL);
  const agentHost = env.WORKBOARD_AGENT_HOST || undefined;
  if (agentHost && (!external || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?:[1-9][0-9]{0,4}$/.test(agentHost) || Number(agentHost.split(':')[1]) > 65535)) {
    throw new Error('WORKBOARD_AGENT_HOST requires a public URL and an exact private service host:port');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !external) throw new Error('Non-loopback binding requires WORKBOARD_PUBLIC_URL and an authenticated private proxy');
  if (env.WORKBOARD_READ_ONLY && !['0', '1'].includes(env.WORKBOARD_READ_ONLY)) throw new Error('WORKBOARD_READ_ONLY must be 0 or 1');
  const relayQueueFile = env.WORKBOARD_RELAY_QUEUE_FILE || undefined;
  if (relayQueueFile && !isAbsolute(relayQueueFile)) throw new Error('WORKBOARD_RELAY_QUEUE_FILE must be an absolute path');
  const dispatchFile = env.WORKBOARD_DISPATCH_AUTHORIZATION_FILE;
  const dispatchAuthorization = dispatchFile ? readFileSync(dispatchFile, 'utf8').trim() : undefined;
  if (dispatchFile && (!agentHost || !/^Bearer [0-9a-f]{64}$/.test(dispatchAuthorization))) {
    throw new Error('AW dispatch writeback requires an Agent host and a private Bearer token file');
  }
  return {
    port, host, publicUrl: external?.href, agentHost, dispatchAuthorization,
    ownerWriteLocalOnly: env.WORKBOARD_OWNER_WRITE_LOCAL_ONLY === '1',
    readOnly: env.WORKBOARD_READ_ONLY === '1', relayQueueFile,
  };
}
