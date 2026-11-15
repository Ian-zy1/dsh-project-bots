import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from './app.mjs';
import { domain } from './domain.mjs';

const port = Number(process.env.PORT ?? 4322);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const file = resolve(process.env.DB_FILE ?? 'data/site-status-lab.sqlite');
mkdirSync(dirname(file), { recursive: true });
createServer(file, domain).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
