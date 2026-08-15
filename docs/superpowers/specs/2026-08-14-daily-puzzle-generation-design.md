# Daily Puzzle Generation & Difficulty Scoring — Design Spec

**Date:** 2026-08-14  
**Status:** Approved  
**Scope:** Offline batch pipeline only. No player-facing code. Produces `daily_puzzles` table rows.

---

## 1. What this builds

A standalone Python batch job that:

1. Loads the word list from Postgres into an in-memory bitset index.
2. Constructs candidate puzzle trays (21-letter multisets) by DFS over crossword placements,
   greedy on word difficulty.
3. Scores each tray's difficulty by replaying the solve under random anchor order many times,
   extracting the 10th-percentile bottleneck.
4. Emits a JSONL file. A separate loader script inserts rows into `daily_puzzles`.

Nothing here is on any live request path. No Worker changes. No client changes. No scheduling
logic (that comes after calibration). No band boundary values (deferred — needs calibration data).

---

## 2. Language and layout

**Python 3.11+.** Not TypeScript. Rationale: `multiprocessing` is simpler than `worker_threads`
for CPU-bound DFS fan-out; NumPy `uint32` arrays make bitset operations clean and fast;
calibration analysis (pandas + matplotlib) is a first-class requirement, not an afterthought.
The job is fully isolated from the web bundle — no npm workspace.

```
scripts/
  puzzlegen/
    __init__.py
    config.py        # all tunables — one file, named constants, nothing hardcoded elsewhere
    rng.py           # mulberry32 SeededRng
    difficulty.py    # two-term formula + LETTER_RARITY mirror
    word_index.py    # numpy bitset index (see §5)
    pool.py          # multiset ops + feasibility check
    board.py         # cell keys, anchors, pattern building, (anchor × dir × offset) enumeration
    solve.py         # shared DFS for construction and replay
    swap.py          # swapSample via fully-fixed pattern query
    canonical.py     # translation-normalized board string
    score.py         # 10th-percentile floor, spread, stopping rule
    validate.py      # Python re-implementation of validateStructure + validateWithDictionary
  generate_puzzles.py   # CLI: multiprocessing fan-out, writes JSONL + trace JSONL
  load_puzzles.py       # CLI: JSONL → pg (daily_puzzles table)
  calibrate.py          # CLI: reads JSONL, plots floor_score vs replay_run_count, band analysis
  pyproject.toml        # deps: psycopg[binary], numpy, pandas, matplotlib, pytest
```

**Shared constants bridge:** `packages/shared/export-constants.mjs` (one-time script, committed,
regenerated if LETTER_RARITY or TILE_DISTRIBUTION ever change) writes
`scripts/puzzlegen/shared_constants.json`. Python reads this file — zero divergence on the
numbers that drive difficulty scores.

**validateStructure:** Reimplemented in Python (`validate.py`). Cross-tested against the TS
version on a corpus of known-good and known-bad grids as part of the pytest suite. This is the
one piece of shared logic that cannot be serialized to JSON; the test corpus is the contract.

---

## 3. Difficulty formula

```
difficulty(word) = sum(LETTER_RARITY[ch] for ch in word) / len(word)
                   + C_LENGTH * len(word)
```

`C_LENGTH` is a named constant in `config.py`, initialized to `0.0`. At `C_LENGTH = 0` this
equals mean letter weight (length-neutral). The length dial is present and tunable from
calibration batch output without a code change.

**Rationale for two-term over plain mean-weight:** `C_LENGTH = 0` and mean-weight are
runtime-identical today, but naming the term makes the tuning intention explicit. The tie-break is
seeded-RNG-random (not a smuggled sign on length — see §4).

**Why not sum-rarity:** `wordRarity()` (existing stats.ts function) sums per-letter weights.
Greedy-min on a sum is greedy-shortest: any 2-letter word beats any 7-letter word made of the same
letters. Under sum-rarity, construction produces dense 2-letter lattices and `floor_score` measures
"the step where no short word existed," not word obscurity. Two-term with mean-weight base avoids
this bias while remaining trivially comparable across word lengths.

---

## 4. Construction (Stage B)

### Initialization

`remainingPool` starts as the full 144-tile Bananagrams distribution. This constrains letter
availability throughout construction so trays resemble real dealt hands.

### Candidate enumeration

For each active anchor: enumerate `(direction, offset)` pairs (H/V × all alignments covering
the anchor). Each `(anchor, dir, offset)` yields a fixed-position pattern. Query the bitset index
(see §5) to get all words matching that pattern. Filter: word's new-cells letter multiset ⊆
`remainingPool` AND `newCells.length ≤ budget`. Collect all feasible candidates across all anchors
before selecting.

This is the complete candidate space. `candidateCount` = popcount of the pattern-match bitset
(acknowledged slight overcount vs. feasible count; logged for study only, not part of the score).

### Greedy selection

Select the feasible candidate with the lowest `difficulty(word)`. Equal-difficulty ties broken by
seeded RNG. The RNG also drives `seedFirstWord`; this means the generation seed produces genuinely
diverse construction paths, not just diverse first words. Required for the deferred seed/first-word
effect study.

`minCandidateRarity` = `difficulty(word_chosen)`, which equals `difficulty` of the feasible
minimum. Logged per step.

### DFS with tabu

The loop is a DFS, not a greedy-restart loop. Per-depth tabu set of already-tried placements
prevents infinite re-selection after backtrack (greedy is deterministic given state, so without
tabu, `step()` re-picks the same word forever). Node budget (configured in `config.py`, default
200,000 nodes); a seed that exceeds budget is discarded, not banked.

### Trace

Each step writes a `LogEntry` **before** `apply()` mutates state:

```python
@dataclass
class LogEntry:
    step: int
    anchor_cell: str          # "r,c"
    fixed_pattern: str        # e.g. "__A__T_"
    candidate_count: int      # popcount, acknowledged overcount
    min_candidate_rarity: float   # feasible minimum (two-term)
    word_chosen: str
    direction: str            # "H" | "V"
```

No `word_chosen_rarity` field — it always equals `min_candidate_rarity` under greedy selection.

---

## 5. Word index

A **length-bucketed bitset index** over all words in the target language.

For each word length `L`:
- `words[L]` = list of words of length L, **sorted ascending by `difficulty()`** (so the first set
  bit of any AND result is the easiest match — no scan required).
- `bits[L][pos][ch]` = `uint32` NumPy array of length `ceil(|words[L]| / 32)`. Bit `i` is set if
  `words[L][i]` has character `ch` at position `pos`.

**Pattern query:** AND the bitsets for all fixed positions, iterate set bits for matches.

**Multi-bucket greedy selection:** Each `(anchor, dir, offset)` triple constrains a word length.
Candidates come from multiple length buckets simultaneously. Take the first feasible set bit per
bucket (= min difficulty for that length), then min across buckets for the global greedy pick.
O(k) where k = number of active `(anchor, dir, offset)` triples.

**swapSample** (§7): fully-fixed pattern (all positions constrained) — same query, zero special
cases.

Rebuild fresh per batch run. Never persisted. At ~650k words (German, largest), ~42 MB RAM.

---

## 6. Replay (Stage C)

### Replay vs. construction

Both use the **same `solve()` DFS** in `solve.py`. Parameters:

| Parameter | Construction | Replay |
|---|---|---|
| `initial_pool` | full 144-tile bag | tray's exact letters |
| `target_tiles` | `TARGET_TILES` (21) | total tiles in tray |
| `anchor_order` | deterministic | rng-shuffled per step |
| `node_budget` | config | config |

Same tabu, same greedy-min selection, same trace format. Construction and replay cannot silently
diverge — they share one implementation.

`remainingPool` for replay is initialized from the tray's exact letters, never the full bag. Replay
is solving a fixed hand.

### Bottleneck

`bottleneck(run) = max(step.min_candidate_rarity for step in run.trace)`

This is the difficulty of the hardest step on this particular path — the moment the solver had the
fewest/hardest options. "Hardest step on the easiest path" (across many replay runs) is the
puzzle's difficulty signal.

---

## 7. Swap sampling (Stage C.3)

`swap_sample(board, word_index)`:

For each word on the finished board, query all words fitting the exact cell pattern (fully fixed
positions = length + crossing letters). Validate any formed/extended perpendicular runs via the
word set. Collect distinct canonical boards found this way. Merge into the replay `seen` set so
`distinct_board_count` reflects both mechanisms.

Run against a sample of replay boards (not all of them — supplementary, not primary mechanism).

---

## 8. Scoring (Stage C.4)

### Adaptive stopping

```python
REPLAY_BATCH = 20
REPLAY_PLATEAU_THRESHOLD = 0.05   # distinct-board growth < 5%
REPLAY_PLATEAU_BATCHES = 2        # consecutive flat batches to stop
REPLAY_MAX_RUNS = 200
```

Stop when BOTH:
1. Distinct-board growth < `REPLAY_PLATEAU_THRESHOLD` for `REPLAY_PLATEAU_BATCHES` consecutive
   batches.
2. `floor_score` (10th percentile) changes < 0.01 for `REPLAY_PLATEAU_BATCHES` consecutive
   batches.

Rationale for requiring both: boards can plateau while `floor_score` still drifts (10th percentile
is more run-count-sensitive than median). Using only board plateau would produce systematically
lower `floor_score` for trays that happened to get more runs before plateau.

Trays where no replay succeeds within the node budget are **dropped, never banked**. `scoreTray`
must never receive an empty run list.

### floor_score

`floor_score = 10th percentile of bottlenecks across all runs`

10th percentile (not raw minimum) because:
- Raw min is maximally sensitive to run count: expected value drifts downward with every added run.
- 10th percentile is far more stable while preserving the "easy end of the path distribution"
  semantic — a real solver doesn't reliably find the global minimum path either.

`replay_run_count` is a first-class calibration output. The calibration script plots
`floor_score` vs `replay_run_count` as a primary panel — it's the confidence indicator for the
percentile estimate, not just a stored diagnostic.

### spread_score

`spread_score = mean(bottlenecks) - floor_score`

Quality-gate signal for the scheduler (fragility). Not part of difficulty; never blended into
`floor_score`.

---

## 9. Banking (Stage D)

### Output format

`generate_puzzles.py` writes two JSONL files:
- `puzzles.jsonl` — one JSON object per banked tray (all `PuzzleRow` fields minus `id`/`status`).
- `traces.jsonl` — full per-run trace for every tray; debug/study use only, not loaded to DB.

`load_puzzles.py` reads `puzzles.jsonl`, inserts rows, logs collisions. Handles partial runs
cleanly (idempotent on `letter_multiset` + `language`).

### Database table

```sql
create table public.daily_puzzles (
  id               uuid primary key default gen_random_uuid(),
  language         text not null,             -- 'en' | 'es' | 'fr' | 'de'
  letter_multiset  text not null,             -- sorted letters, e.g. "AABEILNRST..."
  grid_state       jsonb not null,            -- answer key — never sent to clients
  dictionary_config jsonb not null,           -- snapshot at generation time
  floor_score      numeric not null,
  spread_score     numeric not null,
  band             smallint,                  -- 1 (Mon) .. 7 (Sun); null until calibrated
  distinct_board_count integer not null,
  replay_run_count integer not null,
  status           text not null default 'available', -- available | scheduled | used | archived
  scheduled_date   date,
  generation_seed  bigint not null,
  first_word       text not null,
  created_at       timestamptz not null default now(),

  constraint daily_puzzles_status_check
    check (status in ('available', 'scheduled', 'used', 'archived'))
);

-- Uniqueness: same tray for same language is a collision, not a second slot.
-- Loader logs both seeds on collision rather than silently dropping.
create unique index daily_puzzles_lang_multiset_idx
  on public.daily_puzzles (language, letter_multiset);

-- Scheduling queries
create index daily_puzzles_status_band_idx
  on public.daily_puzzles (status, band, language)
  where status = 'available';
```

**Access:** `service_role` grants only. No `authenticated` or `anon` read — `grid_state` is the
answer key. The scheduler (future work) runs server-side via Worker + service role.

### Band assignment

Bands (1–7, Mon–Sun difficulty) are deferred. `band` column is nullable, populated after
calibration. Bands are calibrated **per language** — rarity distributions differ across the four
dictionaries; a single global band table is wrong.

`load_puzzles.py` accepts an optional `--band-config path/to/bands.json` argument so the loader
can assign bands once the calibration batch exists. Before calibration, rows land with `band = NULL`.

### Collision logging

When a `(language, letter_multiset)` collision occurs on load, log both seeds to stdout and skip
the insert. Do not error. Collision rate in the first calibration batch is a data point about how
much of the tray space the generator reaches.

---

## 10. Stage A — Word loading

```python
def load_indexes(conn, language: str) -> Indexes:
    # English: custom_set_id IS NULL (the base partition)
    # es/fr/de: custom_word_sets row with owner_id IS NULL, matched by slug
```

The handoff's `custom_set_id IS NULL` query is English-only. Spanish/French/German are
`custom_word_sets` rows with `owner_id IS NULL` and slugs `es`/`fr`/`de` (per
`20260727000003_official_dictionaries.sql`). Stage A must handle both partitions.

Precompute `difficulty(word)` for every word once, store in a dict. Do not call this per
candidate — it's O(|word|) and called millions of times otherwise.

Rebuild indexes fresh per batch run. Never persist. Rationale: an offline batch job, not
latency-sensitive; persisting risks silently drifting out of sync with live `words` table.

---

## 11. Configuration (`config.py`)

```python
# Construction
TARGET_TILES: int = 21
NODE_BUDGET: int = 200_000      # nodes before abandoning a seed

# Difficulty formula
C_LENGTH: float = 0.0           # length penalty term; 0.0 = pure mean-weight

# Replay
REPLAY_BATCH: int = 20
REPLAY_PLATEAU_THRESHOLD: float = 0.05
REPLAY_PLATEAU_BATCHES: int = 2
REPLAY_MAX_RUNS: int = 200
REPLAY_FLOOR_STABILITY: float = 0.01   # min change in floor_score to count as non-flat

# Score
FLOOR_PERCENTILE: float = 10.0  # percentile of bottlenecks used as floor_score

# Dictionary
MIN_WORD_LENGTH: int = 2        # set against actual generated boards before freezing
```

All tunables here. Nothing hardcoded elsewhere. These will be retuned after calibration — the
constant names (not values) are the stable contract.

---

## 12. Sequencing

1. **Step 0 — Revert frequency scoring.** Remove `scripts/score-word-frequency.mjs` and
   `supabase/migrations/20260809000001_word_frequency_score.sql` (local-only, never applied to
   prod). The `frequency_score` column that migration would have added is explicitly unused for
   difficulty scoring per the handoff.

2. **Step 1 — Migration + scaffold.** `daily_puzzles` table + grants + indexes.
   `pyproject.toml`. `config.py`, `rng.py`, `difficulty.py`. Export `shared_constants.json`.

3. **Step 2 — Index + pool + board.** `word_index.py`, `pool.py`, `board.py` with pytest coverage:
   pool-constraint invariant, pattern query correctness, enumeration completeness.

4. **Step 3 — Solve.** `solve.py` with tests: tabu terminates on forced dead end, pool-constraint
   holds on every constructed tray, node budget fires on a pathological seed.

5. **Step 4 — Replay + scoring.** `replay.py`, `swap.py`, `canonical.py`, `score.py`, `validate.py`.
   Cross-test `validate.py` against TS `validateStructure` on 20+ known-good and known-bad grids.

6. **Step 5 — CLIs.** `generate_puzzles.py` (multiprocessing fan-out, JSONL out).
   `load_puzzles.py`. `calibrate.py`.

7. **Step 6 — First calibration batch.** 500 English trays at `MIN_WORD_LENGTH = 2`. Output:
   `floor_score` distribution, `floor_score` vs `replay_run_count` plot, board shape analysis.
   Decide `C_LENGTH` and `MIN_WORD_LENGTH` from real boards, then run the 5,000-tray fill batch.

---

## 13. Explicitly deferred

- Band boundary values (need calibration data).
- Spread threshold for fragility gate (same).
- Stopping-rule constant tuning (calibration).
- Seed/first-word effect study.
- Spanish/French/German calibration batches (English first; band calibration is per-language,
  so nothing learned from English transfers anyway).
- `verify-puzzles.py` staleness check (re-validate `available` rows after a `db:seed --reset`).
  Logged as a note for whoever builds the scheduler, not in scope here.
- 28-tile fallback (only if calibration shows 21-tile trays cluster too easy at hardest band).

---

## 14. Out of scope

- Any player-facing / client code.
- The scheduler that pulls `available` rows into a 7-day live cycle.
- Live Worker-side puzzle serving / validation.
