-- Per-word usage-frequency score on public.words, for the (not-yet-built) daily puzzle
-- generator's difficulty scoring and the "rarest word played" stat.
--
-- This is a SEPARATE signal from the existing word_rarity() (SQL + shared stats.ts), which
-- measures LETTER SCARCITY (sum of per-letter weights from the 144-tile distribution) and is
-- unchanged by this migration. Letter scarcity says "QUIXOTIC uses expensive tiles"; this column
-- says "nobody actually writes QUIXOTIC". Combining the two into one difficulty number is
-- generator logic and deliberately lives elsewhere.
--
-- Populated offline by scripts/score-word-frequency.mjs; nothing in the live request path reads
-- it. No index on purpose: it's read in batch by offline/generator jobs, never per keystroke like
-- find_invalid_words. Add one if and when a generator needs ORDER BY frequency_score at
-- generation time — not preemptively, since every index on this ~2M-row table is real money on a
-- 500 MB free tier (see 20260727000003 for the storage audit that dropped three of them).
alter table public.words add column if not exists frequency_score real;

comment on column public.words.frequency_score is
  'Corpus usage-frequency score, 0..1 where 0 = most common and 1 = rarest (same "higher = rarer" '
  'direction as word_rarity(), which is letter scarcity, not this). NULL means UNSCORED, not '
  'rare: user-owned custom sets are deliberately never scored (no corpus coverage by '
  'construction) and must be EXCLUDED from frequency-based difficulty scoring rather than treated '
  'as maximally rare. Written offline by scripts/score-word-frequency.mjs.';
