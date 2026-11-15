import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, chmodSync } from 'node:fs';
const [source, destination] = process.argv.slice(2);
if (!source || !destination || existsSync(destination)) throw new Error('Provide source and a new backup path');
const db = new DatabaseSync(source, { readOnly: true });
try {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Source integrity check failed');
  await backup(db, destination);
  chmodSync(destination, 0o600);
} finally { db.close(); }
console.log('Consistent SQLite backup completed. Keep the source read-only until cutover or rollback.');
