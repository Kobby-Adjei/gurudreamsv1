/** Apply migrations/*.sql in order against DATABASE_URL (all statements are idempotent). */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(readFileSync(join(dir, f), 'utf8'));
    console.log(`applied ${f}`);
  }
} finally {
  await client.end();
}
