#!/usr/bin/env node
// Loads the ENABLE1 word list (vendored at supabase/seed/enable1.txt) into
// public.words as the base dictionary (custom_set_id = NULL). Idempotent:
// safe to re-run, existing rows are left untouched via ON CONFLICT DO NOTHING.
//
// Usage:
//   npm run db:seed                # seed against local Supabase (default)
//   DATABASE_URL=... npm run db:seed   # seed against a different Postgres
//   npm run db:seed -- --reset     # wipe existing base words first

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORDLIST_PATH = path.join(__dirname, '..', 'supabase', 'seed', 'enable1.txt');

const DEFAULT_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DB_URL;
const BATCH_SIZE = 1000;
const RESET = process.argv.includes('--reset');

async function loadWords() {
  const raw = await readFile(WORDLIST_PATH, 'utf-8');
  return raw
    .split('\n')
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .map((w) => w.toUpperCase());
}

function buildInsert(batch) {
  const values = [];
  const rows = batch.map((word, i) => {
    values.push(word, word.length);
    const base = i * 2;
    return `($${base + 1}, $${base + 2})`;
  });
  const sql = `insert into public.words (word, length) values ${rows.join(', ')}
               on conflict (word) where custom_set_id is null do nothing`;
  return { sql, values };
}

async function main() {
  console.log(`Reading word list from ${WORDLIST_PATH}...`);
  const words = await loadWords();
  console.log(`Loaded ${words.length} words.`);

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    if (RESET) {
      console.log('Clearing existing base dictionary words...');
      await client.query('delete from public.words where custom_set_id is null');
    }

    let inserted = 0;
    for (let i = 0; i < words.length; i += BATCH_SIZE) {
      const batch = words.slice(i, i + BATCH_SIZE);
      const { sql, values } = buildInsert(batch);
      const res = await client.query(sql, values);
      inserted += res.rowCount ?? 0;
      process.stdout.write(`\rInserted ${Math.min(i + BATCH_SIZE, words.length)}/${words.length} words...`);
    }
    console.log(`\nDone. ${inserted} new rows inserted (existing/duplicate words skipped).`);

    const { rows } = await client.query(
      'select count(*)::int as total from public.words where custom_set_id is null',
    );
    console.log(`Base dictionary now has ${rows[0].total} words.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
