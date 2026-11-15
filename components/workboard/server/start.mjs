import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';
import { createApp } from './app.mjs';
import { startupConfig } from './config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = startupConfig();
const databasePath = resolve(process.env.WORKBOARD_DB ?? resolve(root, '.local/workboard.sqlite'));
const store = createStore(databasePath);
const server = createApp(store, { dist: resolve(root, 'dist'), ...config });
server.on('error', error => { store.close(); console.error(`Workboard could not listen: ${error.message}`); process.exitCode = 1; });
server.listen(config.port, config.host, () => {
  console.log(`Agent Workboard: ${config.publicUrl ?? `http://127.0.0.1:${config.port}/`}`);
  if (config.readOnly) console.log('Read-only migration view: writes are disabled');
  console.log(`Local database: ${databasePath}`);
});
function stop() { server.close(() => { store.close(); process.exit(0); }); }
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
