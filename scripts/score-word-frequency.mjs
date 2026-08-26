#!/usr/bin/env node
// Populates public.words.frequency_score — a CORPUS USAGE-FREQUENCY signal — for the built-in
// language dictionaries, from Google Books Ngram 1-gram frequency lists.
//
// This is NOT word_rarity(): that one is letter scarcity (how expensive a word's tiles are) and
// is untouched here. This one is "how often do people actually write this word". Both will feed
// the daily puzzle generator's difficulty score eventually; combining them is generator logic and
// is deliberately not in this script.
//
// SCOPE — which rows get scored:
//   custom_set_id IS NULL (built-in English base)  -> yes
//   official es/fr/de sets (custom_word_sets.owner_id IS NULL, matched by slug) -> yes
//   user-owned custom sets -> NEVER. Left NULL. A user's word set has no corpus coverage by
//   construction, so NULL here means "excluded from frequency scoring", not "unmatched, so rare".
//   Downstream generator code must treat NULL as excluded.
//
// Idempotent: safe to re-run. Every write is an UPDATE keyed by (word, partition); re-running
// recomputes the same scores. --reset clears the built-in partitions' scores first.
//
// Usage:
//   npm run db:score-words                     # score against local Supabase (default)
//   npm run db:score-words -- --only=es,fr     # a subset (slugs, comma-separated)
//   npm run db:score-words -- --report-only    # join + print match rates, write nothing
//   npm run db:score-words -- --unmatched-rarest   # also default unmatched words to the rarest tier
//   npm run db:score-words -- --reset          # clear built-in scores first
//   $env:DATABASE_URL = '<prod pooler URL>'; npm run db:score-words   # PowerShell: no inline VAR=x
//
// --unmatched-rarest is OFF by default on purpose. Absence from the corpus is a real rarity
// signal, but only if it applies to a small slice of a partition — if most of a language's words
// are unmatched they all collapse onto one identical score and the column stops discriminating.
// So: run once without the flag, read the reported match rate, THEN decide.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';
import { normalizeWord } from '../packages/shared/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', '.ngram-cache');

/**
 * The built-in dictionaries, keyed the same way scripts/seed-dictionary.mjs keys them: `base`
 * marks the custom_set_id IS NULL partition, everything else is an official custom_word_sets row
 * looked up by its stable `slug`. `ngramLang` is the source list's language folder name.
 *
 * Source: orgtre/google-books-ngram-frequency (CC BY 3.0), cleaned 1-grams restricted to books
 * published 2010-2019 in Google Books Ngram Corpus v3 (20200217).
 */
const DICTIONARIES = [
  { slug: 'en', name: 'English', ngramLang: 'english', base: true },
  { slug: 'es', name: 'Español', ngramLang: 'spanish' },
  { slug: 'fr', name: 'Français', ngramLang: 'french' },
  { slug: 'de', name: 'Deutsch', ngramLang: 'german' },
];

const NGRAM_BASE_URL =
  'https://raw.githubusercontent.com/orgtre/google-books-ngram-frequency/main/ngrams';

const DEFAULT_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DB_URL;
// 2 bind params per statement (a text[] and a real[]), so the 65,535-parameter ceiling is not the
// constraint here — this is just about keeping any single UPDATE's plan and memory sane.
const BATCH_SIZE = 10000;

const RESET = process.argv.includes('--reset');
const REPORT_ONLY = process.argv.includes('--report-only');
const UNMATCHED_RAREST = process.argv.includes('--unmatched-rarest');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Score written to a built-in word the corpus has no entry for, when --unmatched-rarest is on.
 * 1.0 = the rarest end of the scale by definition. */
const UNMATCHED_SCORE = 1.0;

/**
 * Anchors for the log-share -> 0..1 rarity mapping below, as log10(share of corpus).
 * -1 is above the most frequent word in any of the four lists (English THE sits at -1.29), so
 * nothing clamps flat at the common end; -9 is roughly one occurrence per billion words.
 *
 * These are FIXED and shared by all four languages on purpose. The alternative — rescaling each
 * language onto its own observed min/max, or onto percentile rank — would make every language's
 * rarest matched word score exactly 1.0, colliding with UNMATCHED_SCORE and making "rare in the
 * corpus" indistinguishable from "absent from the corpus". Fixed anchors keep the number's
 * absolute meaning, so a score is comparable across languages AND leaves headroom above the
 * rarest word any given list happens to contain.
 */
const LOG_SHARE_COMMON = -1;
const LOG_SHARE_RARE = -9;

/**
 * Converts one language's raw ngram counts into 0..1 rarity scores (0 = most common, 1 = rarest),
 * matching the direction of the existing word_rarity() so a bigger number always means "harder".
 *
 * Raw counts are never stored: the distribution spans ~9 orders of magnitude, so on a linear
 * scale a handful of function words would own the entire top of the range and everything a player
 * might actually build would be squashed into a rounding error. Dividing by the list total first
 * removes the corpus-size difference between the four languages (German's corpus is far larger
 * than Spanish's), so the log-share is already comparable before the anchors are applied.
 *
 * @param {Map<string, number>} counts normalized word -> summed raw ngram count
 * @returns {Map<string, number>} word -> frequency_score in [0, 1]
 */
export function scoreFromCounts(counts) {
  let total = 0;
  for (const c of counts.values()) total += c;

  const span = LOG_SHARE_COMMON - LOG_SHARE_RARE;
  const scores = new Map();
  for (const [word, count] of counts) {
    if (count <= 0) continue;
    const logShare = Math.log10(count / total);
    const raw = (LOG_SHARE_COMMON - logShare) / span;
    scores.set(word, Math.min(1, Math.max(0, raw)));
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Fetch + normalize
// ---------------------------------------------------------------------------

/** Downloads a language's 1-gram list, caching it under .ngram-cache/ so re-runs and
 * --report-only iterations don't re-hit GitHub. */
async function fetchNgramList(ngramLang) {
  const file = `1grams_${ngramLang}.csv`;
  const cached = path.join(CACHE_DIR, file);
  try {
    return await readFile(cached, 'utf-8');
  } catch {
    /* not cached yet */
  }
  const url = `${NGRAM_BASE_URL}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const body = await res.text();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cached, body, 'utf-8');
  return body;
}

/**
 * Parses `ngram,freq,cumshare[,en]` rows into normalized word -> summed count.
 *
 * Normalization runs through the SAME shared normalizeWord() the seeder uses, so the two sides
 * can't drift: accents fold to their base letter (Ñ→N, ß→SS) and anything still outside
 * ^[A-Z]{2,20}$ is dropped. Counts are SUMMED across collisions rather than overwritten — folding
 * genuinely merges distinct words (German SCHON and SCHÖN both become SCHON), and their combined
 * usage is what the merged dictionary row represents.
 */
function parseNgramCsv(csv) {
  const counts = new Map();
  let rows = 0;
  let dropped = 0;
  for (const line of csv.split('\n').slice(1)) {
    if (line.trim() === '') continue;
    rows += 1;
    const firstComma = line.indexOf(',');
    const secondComma = line.indexOf(',', firstComma + 1);
    const ngram = line.slice(0, firstComma);
    const freq = Number(line.slice(firstComma + 1, secondComma === -1 ? undefined : secondComma));
    const word = normalizeWord(ngram);
    if (word === null || !Number.isFinite(freq)) {
      dropped += 1;
      continue;
    }
    counts.set(word, (counts.get(word) ?? 0) + freq);
  }
  return { counts, rows, dropped };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Resolves an official language set's id from its slug. Returns null for the base partition. */
async function resolveSetId(client, dict) {
  if (dict.base) return null;
  const { rows } = await client.query(
    'select id from public.custom_word_sets where slug = $1 and owner_id is null',
    [dict.slug],
  );
  if (rows.length === 0) {
    throw new Error(
      `No official word set with slug '${dict.slug}'. Run \`npm run db:seed\` against this ` +
        'database first — this script scores existing rows, it never inserts them.',
    );
  }
  return rows[0].id;
}

/** The partition predicate + its bind params, so every statement below targets exactly one
 * built-in partition and can never touch a user-owned set. `nextParam` is the placeholder number
 * the caller has free, since the two call sites bind a different number of arrays before this. */
function partition(setId, nextParam) {
  return setId === null
    ? { where: 'w.custom_set_id is null', params: [] }
    : { where: `w.custom_set_id = $${nextParam}`, params: [setId] };
}

async function partitionSize(client, setId) {
  const p = setId === null ? 'custom_set_id is null' : 'custom_set_id = $1';
  const { rows } = await client.query(
    `select count(*)::int as n from public.words where ${p}`,
    setId === null ? [] : [setId],
  );
  return rows[0].n;
}

/** Writes scores for the words this language's list actually covers, returning how many
 * dictionary rows were hit. Words in the list that aren't in the dictionary simply match nothing. */
async function applyScores(client, scores, setId) {
  const words = [...scores.keys()];
  const { where, params } = partition(setId, 3);
  let updated = 0;
  for (let i = 0; i < words.length; i += BATCH_SIZE) {
    const batch = words.slice(i, i + BATCH_SIZE);
    const res = await client.query(
      // unnest of two parallel arrays keeps this to 2 bind params regardless of batch size. The
      // ::citext cast matters: words.word is citext and the partial unique indexes are on that
      // type, so comparing against a plain text column would forfeit the index.
      `update public.words w
          set frequency_score = v.score
         from unnest($1::text[], $2::real[]) as v(word, score)
        where w.word = v.word::citext and ${where}`,
      [batch, batch.map((word) => scores.get(word)), ...params],
    );
    updated += res.rowCount ?? 0;
  }
  return updated;
}

/** Fills the rest of a built-in partition with the rarest-tier default. Gated behind
 * --unmatched-rarest; see the header for why it isn't the default. */
async function applyUnmatched(client, setId) {
  const p = setId === null ? 'custom_set_id is null' : 'custom_set_id = $2';
  const res = await client.query(
    `update public.words set frequency_score = $1
      where frequency_score is null and ${p}`,
    setId === null ? [UNMATCHED_SCORE] : [UNMATCHED_SCORE, setId],
  );
  return res.rowCount ?? 0;
}

async function main() {
  // Announce the target BEFORE anything else — same trap as the seeder: PowerShell has no inline
  // `VAR=value cmd` prefix, so the bash-style `DATABASE_URL=... npm run db:score-words` leaves the
  // variable unset and quietly writes to the LOCAL dev DB while looking like a successful prod run.
  const host = DATABASE_URL.replace(/^[^:]+:\/\/[^@]*@/, '').replace(/[/?].*$/, '');
  const usingDefault = process.env.DATABASE_URL === undefined;
  console.log(`Target: ${host}${usingDefault ? '   <-- DATABASE_URL not set, using LOCAL default' : ''}`);
  if (usingDefault) {
    console.log(
      'If you meant a remote database, stop now (Ctrl+C) and set it first:\n' +
        "  PowerShell:  $env:DATABASE_URL = '<connection string>'\n" +
        "  bash:        export DATABASE_URL='<connection string>'\n",
    );
  }
  if (REPORT_ONLY) console.log('--report-only: joining and reporting, writing nothing.\n');

  const targets = ONLY ? DICTIONARIES.filter((d) => ONLY.includes(d.slug)) : DICTIONARIES;
  if (targets.length === 0) {
    throw new Error(`--only matched no dictionaries. Known slugs: ${DICTIONARIES.map((d) => d.slug).join(', ')}`);
  }

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const report = [];
  try {
    for (const dict of targets) {
      const setId = await resolveSetId(client, dict);
      const total = await partitionSize(client, setId);
      const csv = await fetchNgramList(dict.ngramLang);
      const { counts, rows, dropped } = parseNgramCsv(csv);
      const scores = scoreFromCounts(counts);

      if (RESET && !REPORT_ONLY) {
        const p = setId === null ? 'custom_set_id is null' : 'custom_set_id = $1';
        await client.query(
          `update public.words set frequency_score = null where ${p} and frequency_score is not null`,
          setId === null ? [] : [setId],
        );
      }

      let matched;
      if (REPORT_ONLY) {
        // Same join, counted instead of written, so --report-only reports the exact number a real
        // run would update rather than an estimate.
        const { where, params } = partition(setId, 2);
        const { rows: r } = await client.query(
          `select count(*)::int as n
             from public.words w
             join unnest($1::text[]) as v(word) on w.word = v.word::citext
            where ${where}`,
          [[...scores.keys()], ...params],
        );
        matched = r[0].n;
      } else {
        matched = await applyScores(client, scores, setId);
      }

      let defaulted = 0;
      if (UNMATCHED_RAREST && !REPORT_ONLY) defaulted = await applyUnmatched(client, setId);

      report.push({ dict, total, rows, dropped, usable: scores.size, matched, defaulted });
    }

    console.log('\nlanguage    dict rows   ngram rows   usable   matched     match%      miss%');
    for (const r of report) {
      const pct = r.total === 0 ? 0 : (r.matched / r.total) * 100;
      console.log(
        `${r.dict.name.padEnd(10)} ${r.total.toLocaleString().padStart(10)} ` +
          `${r.rows.toLocaleString().padStart(12)} ${r.usable.toLocaleString().padStart(8)} ` +
          `${r.matched.toLocaleString().padStart(9)} ${pct.toFixed(2).padStart(9)}% ` +
          `${(100 - pct).toFixed(2).padStart(9)}%` +
          (r.defaulted ? `   ${r.defaulted.toLocaleString()} defaulted to rarest` : ''),
      );
    }

    const worst = Math.max(...report.map((r) => (r.total === 0 ? 0 : 100 - (r.matched / r.total) * 100)));
    if (!UNMATCHED_RAREST && worst > 10) {
      console.log(
        `\nMiss rate peaks at ${worst.toFixed(1)}% — above the ~5-10% guideline. Defaulting that ` +
          'many words to one identical rarest-tier score would make frequency_score\n' +
          'non-discriminating for most of the dictionary. Review before passing --unmatched-rarest.',
      );
    }
  } finally {
    await client.end();
  }
}

// Only run when executed directly — scoreFromCounts is exported so the scoring formula can be
// imported and eyeballed (or tested) without the import kicking off a whole database run.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Scoring failed:', err);
    process.exitCode = 1;
  });
}
