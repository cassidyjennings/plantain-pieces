#!/usr/bin/env node
// Loads the built-in language dictionaries (vendored gzipped under supabase/seed/) into
// public.words.
//
// English is the "base" list: it lives in the custom_set_id IS NULL partition and is toggled by
// DictionaryConfig.baseEnabled. Every other language is an *official* word set — a
// custom_word_sets row with owner_id IS NULL — selected through customSetIds exactly like a
// user's own set. See supabase/migrations/20260727000003_official_dictionaries.sql.
//
// Idempotent: safe to re-run. Official sets are upserted by their stable `slug`, and word inserts
// use ON CONFLICT DO NOTHING.
//
// Usage:
//   npm run db:seed                    # seed against local Supabase (default)
//   DATABASE_URL=... npm run db:seed   # seed against a different Postgres (e.g. prod pooler)
//   npm run db:seed -- --reset         # wipe existing built-in words first
//   npm run db:seed -- --only=es,fr    # seed a subset (slugs, comma-separated)

import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';
import { normalizeWord } from '../packages/shared/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, '..', 'supabase', 'seed');

/**
 * The built-in dictionaries. `base: true` marks the one that occupies the custom_set_id IS NULL
 * partition — there can only be one, since that partition is what `baseEnabled` refers to.
 * `slug` is the stable key the upsert matches on, so re-running never duplicates a set.
 */
const DICTIONARIES = [
  { slug: 'en', name: 'English', file: 'en-sowpods.txt.gz', base: true },
  { slug: 'es', name: 'Español', file: 'es-file2017.txt.gz' },
  { slug: 'fr', name: 'Français', file: 'fr-ods8.txt.gz' },
  { slug: 'de', name: 'Deutsch', file: 'de-tanglet.txt.gz' },
];

const DEFAULT_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DB_URL;
// 5,000 rows x 3 bind params = 15k, well under Postgres' 65,535-parameter ceiling. At ~2M total
// rows this is ~400 round trips instead of the ~2,000 the old 1,000-row batches needed.
const BATCH_SIZE = 5000;
const RESET = process.argv.includes('--reset');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');

/** Reads a gzipped list and normalizes it through the SAME shared helper the app uses, so the
 * loader and runtime validation can't drift: accents fold to their base letter (Ñ→N, ß→SS) and
 * anything still outside ^[A-Z]{2,20}$ is dropped. Dedupes, since folding creates collisions
 * (German SCHON and SCHÖN both become SCHON). */
async function loadWords(file) {
  const gz = await readFile(path.join(SEED_DIR, file));
  const raw = gunzipSync(gz).toString('utf-8');
  const seen = new Set();
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const word = normalizeWord(line);
    if (word === null) {
      if (line.trim() !== '') skipped += 1;
      continue;
    }
    seen.add(word);
  }
  return { words: [...seen], skipped };
}

/** Creates or updates the official custom_word_sets row for a language, returning its id. */
async function upsertOfficialSet(client, { slug, name }) {
  const { rows } = await client.query(
    // The slug index is PARTIAL (where slug is not null, so user sets can all leave it NULL), and
    // Postgres only infers a partial index when the predicate is repeated here — without it this
    // fails with 42P10 "no unique or exclusion constraint matching the ON CONFLICT specification".
    `insert into public.custom_word_sets (owner_id, name, slug)
     values (null, $1, $2)
     on conflict (slug) where slug is not null do update set name = excluded.name
     returning id`,
    [name, slug],
  );
  return rows[0].id;
}

async function insertWords(client, words, setId, label) {
  let inserted = 0;
  for (let i = 0; i < words.length; i += BATCH_SIZE) {
    const batch = words.slice(i, i + BATCH_SIZE);
    const values = [];
    const tuples = batch.map((word, j) => {
      values.push(word, word.length, setId);
      const b = j * 3;
      return `($${b + 1}, $${b + 2}, $${b + 3})`;
    });
    // Two partial unique indexes cover this table (base vs custom), so the conflict target has
    // to be spelled out per partition rather than as a single ON CONFLICT (word, custom_set_id).
    const conflict =
      setId === null
        ? 'on conflict (word) where custom_set_id is null do nothing'
        : 'on conflict (word, custom_set_id) where custom_set_id is not null do nothing';
    const res = await client.query(
      `insert into public.words (word, length, custom_set_id) values ${tuples.join(', ')} ${conflict}`,
      values,
    );
    inserted += res.rowCount ?? 0;
    // Carriage-return progress only makes sense on a terminal; piped to a file or a log it turns
    // into one enormous unreadable line, so skip it entirely when stdout isn't a TTY.
    if (process.stdout.isTTY) {
      process.stdout.write(
        `\r  ${label}: ${Math.min(i + BATCH_SIZE, words.length).toLocaleString()}/${words.length.toLocaleString()}`,
      );
    }
  }
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  return inserted;
}

async function main() {
  // Announce the target BEFORE anything else, including argument validation. A silent localhost
  // fallback is the one way this script can appear to succeed while doing nothing useful:
  // PowerShell has no inline `VAR=value cmd` prefix, so the bash-style
  // `DATABASE_URL=... npm run db:seed` leaves the variable unset and we quietly seed the local dev
  // DB instead of the intended remote one — printing identical-looking success output.
  const host = DATABASE_URL.replace(/^[^:]+:\/\/[^@]*@/, '').replace(/[/?].*$/, '');
  const usingDefault = process.env.DATABASE_URL === undefined;
  console.log(`Target: ${host}${usingDefault ? '   <-- DATABASE_URL not set, using LOCAL default' : ''}`);
  if (usingDefault) {
    console.log(
      'If you meant to seed a remote database, stop now (Ctrl+C) and set it first:\n' +
        "  PowerShell:  $env:DATABASE_URL = '<connection string>'\n" +
        "  bash:        export DATABASE_URL='<connection string>'\n",
    );
  }

  const targets = ONLY ? DICTIONARIES.filter((d) => ONLY.includes(d.slug)) : DICTIONARIES;
  if (targets.length === 0) {
    throw new Error(`--only matched no dictionaries. Known slugs: ${DICTIONARIES.map((d) => d.slug).join(', ')}`);
  }

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    if (RESET) {
      console.log('Clearing existing built-in dictionary words...');
      // Covers both the base partition and every official set; user-owned sets are untouched.
      await client.query('delete from public.words where custom_set_id is null');
      await client.query(`delete from public.words where custom_set_id in
        (select id from public.custom_word_sets where owner_id is null)`);
    }

    for (const dict of targets) {
      const { words, skipped } = await loadWords(dict.file);
      const setId = dict.base ? null : await upsertOfficialSet(client, dict);
      const inserted = await insertWords(client, words, setId, dict.name);

      if (setId !== null) {
        // Stored rather than counted live: the picker reads this on every open, and a count(*)
        // over a ~2M-row table would seq-scan each time.
        await client.query('update public.custom_word_sets set word_count = $1 where id = $2', [
          words.length,
          setId,
        ]);
      }

      console.log(
        `${dict.name.padEnd(10)} ${dict.base ? '(base)' : `(${dict.slug})  `}  ` +
          `${words.length.toLocaleString().padStart(9)} words  ` +
          `${inserted.toLocaleString().padStart(9)} new  ` +
          `${skipped.toLocaleString().padStart(7)} skipped`,
      );
    }

    const { rows } = await client.query(`
      select coalesce(cws.slug, 'en (base)') as source, count(*)::int as total
      from public.words w
      left join public.custom_word_sets cws on cws.id = w.custom_set_id
      where w.custom_set_id is null or cws.owner_id is null
      group by 1 order by 1`);
    console.log('\nBuilt-in dictionary totals:');
    for (const r of rows) console.log(`  ${r.source.padEnd(12)} ${r.total.toLocaleString()}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
