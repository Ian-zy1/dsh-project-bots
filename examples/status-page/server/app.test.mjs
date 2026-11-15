import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from './app.mjs';
import { domain } from './domain.mjs';

async function open(file) {
  const server = createServer(file, domain).listen(0,'127.0.0.1');
  await once(server,'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  return {
    read: path => fetch(url + path),
    post: (path, value) => fetch(url + path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value) }),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('serves the page and retains incidents and history through resolution and restart', async () => {
  const folder = await mkdtemp(join(tmpdir(),'status-test-'));
  const file = join(folder,'db');
  let app = await open(file);
  try {
    assert.match(await (await app.read('/')).text(), /发布事件/);
    assert.equal((await app.post('/api/incidents',{service:1,impact:'invalid',title:'样例'})).status,400);
    const response = await app.post('/api/incidents',{service:1,impact:'outage',title:'访问中断'});
    assert.equal(response.status,201);
    const {id} = await response.json();
    const state = async () => (await (await app.read('/api/overview')).json()).services[0];
    assert.equal((await state()).status,'outage');
    assert.equal((await app.post('/api/incidents/' + id + '/resolve', {})).status,200);
    await app.close();
    app = await open(file);
    assert.equal((await state()).status,'operational');
    assert.equal((await state()).history.at(-1).status,'outage');
  } finally { await app.close(); await rm(folder,{recursive:true,force:true}); }
});
