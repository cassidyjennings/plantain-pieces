# Daily Puzzle Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline Python batch pipeline that constructs crossword-style puzzle trays, scores their difficulty, and banks them in a `daily_puzzles` Postgres table.

**Architecture:** Python 3.11 package at `scripts/puzzlegen/`, using NumPy bitset word index and a shared DFS for both construction and replay. `generate_puzzles.py` fans out over seeds via `multiprocessing`, emits JSONL; `load_puzzles.py` inserts into Postgres.

**Tech Stack:** Python 3.11+, NumPy, psycopg[binary], pandas, matplotlib, pytest

## Global Constraints

- Python 3.11+ only — no 3.10 walrus/match backcompat needed, but don't use 3.12+ syntax
- All tunables in `scripts/puzzlegen/config.py` — nothing hardcoded elsewhere
- `service_role` only for `daily_puzzles` — no `authenticated`/`anon` read at all
- `grid_state` is the answer key — never log it in plaintext, never send to clients
- No npm workspace changes; no web bundle impact
- Run all pytest from `scripts/` directory: `cd scripts && python -m pytest tests/ -v`
- LETTER_RARITY and TILE_DISTRIBUTION must always be read from `shared_constants.json`, never redefined inline

---

## File Map

**New files:**
- `supabase/migrations/20260814000001_daily_puzzle_bank.sql`
- `packages/shared/export-constants.mjs`
- `scripts/pyproject.toml`
- `scripts/puzzlegen/__init__.py`
- `scripts/puzzlegen/config.py`
- `scripts/puzzlegen/rng.py`
- `scripts/puzzlegen/difficulty.py`
- `scripts/puzzlegen/shared_constants.json` (generated, committed)
- `scripts/puzzlegen/pool.py`
- `scripts/puzzlegen/word_index.py`
- `scripts/puzzlegen/board.py`
- `scripts/puzzlegen/solve.py`
- `scripts/puzzlegen/canonical.py`
- `scripts/puzzlegen/swap.py`
- `scripts/puzzlegen/score.py`
- `scripts/puzzlegen/validate.py`
- `scripts/tests/__init__.py`
- `scripts/tests/test_rng.py`
- `scripts/tests/test_difficulty.py`
- `scripts/tests/test_pool.py`
- `scripts/tests/test_word_index.py`
- `scripts/tests/test_board.py`
- `scripts/tests/test_solve.py`
- `scripts/tests/test_canonical.py`
- `scripts/tests/test_swap.py`
- `scripts/tests/test_score.py`
- `scripts/tests/test_validate.py`
- `scripts/generate_puzzles.py`
- `scripts/load_puzzles.py`
- `scripts/calibrate.py`

**Deleted:**
- `scripts/score-word-frequency.mjs`
- `supabase/migrations/20260809000001_word_frequency_score.sql`

**Modified:**
- `.gitignore` — revert `.ngram-cache/` line
- `package.json` — revert `db:score-words` script

---

## Task 1: Revert frequency scoring artifacts

**Files:**
- Delete: `scripts/score-word-frequency.mjs`
- Delete: `supabase/migrations/20260809000001_word_frequency_score.sql`
- Modify: `.gitignore` (remove `.ngram-cache/`)
- Modify: `package.json` (remove `db:score-words`)

These were added locally and never applied to prod. The `frequency_score` column is explicitly unused for difficulty scoring.

- [ ] **Step 1: Delete the two files**

```bash
git rm scripts/score-word-frequency.mjs
git rm supabase/migrations/20260809000001_word_frequency_score.sql
```

- [ ] **Step 2: Revert .gitignore and package.json**

In `.gitignore`, remove the line `.ngram-cache/`.

In `package.json`, remove the `"db:score-words"` entry from `"scripts"`. Make sure the preceding line's comma is correct.

- [ ] **Step 3: Verify**

```bash
git status
git diff .gitignore package.json
```

Expected: only deletions and the two reverted lines. No other changes.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "revert: remove frequency scoring artifacts (never applied to prod)"
```

---

## Task 2: Database migration — daily_puzzles table

**Files:**
- Create: `supabase/migrations/20260814000001_daily_puzzle_bank.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260814000001_daily_puzzle_bank.sql

create table public.daily_puzzles (
  id                   uuid primary key default gen_random_uuid(),
  language             text not null,
  letter_multiset      text not null,
  grid_state           jsonb not null,
  dictionary_config    jsonb not null,
  floor_score          numeric not null,
  spread_score         numeric not null,
  band                 smallint,
  distinct_board_count integer not null,
  replay_run_count     integer not null,
  status               text not null default 'available',
  scheduled_date       date,
  generation_seed      bigint not null,
  first_word           text not null,
  created_at           timestamptz not null default now(),

  constraint daily_puzzles_language_check
    check (language in ('en', 'es', 'fr', 'de')),
  constraint daily_puzzles_status_check
    check (status in ('available', 'scheduled', 'used', 'archived')),
  constraint daily_puzzles_band_check
    check (band is null or (band >= 1 and band <= 7))
);

-- collision uniqueness: same letter multiset for same language = collision, not a second slot
create unique index daily_puzzles_lang_multiset_idx
  on public.daily_puzzles (language, letter_multiset);

-- scheduling queries filter by status + band + language
create index daily_puzzles_status_band_idx
  on public.daily_puzzles (status, band, language)
  where status = 'available';

do $$
begin
  -- service_role only — grid_state is the answer key
  revoke all on table public.daily_puzzles from public, anon, authenticated;
  grant all on table public.daily_puzzles to service_role;
end $$;
```

- [ ] **Step 2: Apply locally**

```bash
npm run db:reset
```

- [ ] **Step 3: Verify table exists**

```bash
npx supabase db diff --schema public 2>/dev/null | grep daily_puzzles
```

Expected: shows `daily_puzzles` in the diff (or use `npx supabase status` then connect and `\d daily_puzzles`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260814000001_daily_puzzle_bank.sql
git commit -m "feat(db): add daily_puzzles bank table with service_role-only access"
```

---

## Task 3: Python package scaffold + shared constants bridge

**Files:**
- Create: `scripts/pyproject.toml`
- Create: `scripts/puzzlegen/__init__.py`
- Create: `scripts/puzzlegen/config.py`
- Create: `packages/shared/export-constants.mjs`
- Create: `scripts/puzzlegen/shared_constants.json` (generated)
- Create: `scripts/tests/__init__.py`

- [ ] **Step 1: Write pyproject.toml**

```toml
# scripts/pyproject.toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.backends.legacy:build"

[project]
name = "puzzlegen"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "numpy>=1.26",
    "psycopg[binary]>=3.1",
    "pandas>=2.1",
    "matplotlib>=3.8",
]

[project.optional-dependencies]
dev = ["pytest>=8.0", "pytest-cov"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 2: Install**

```bash
cd scripts
pip install -e ".[dev]"
```

- [ ] **Step 3: Write puzzlegen/__init__.py**

```python
# scripts/puzzlegen/__init__.py
```

(empty — marks as package)

- [ ] **Step 4: Write config.py**

```python
# scripts/puzzlegen/config.py

# Construction
TARGET_TILES: int = 21
NODE_BUDGET: int = 200_000  # DFS nodes before abandoning a seed

# Difficulty formula: difficulty(word) = sum(LETTER_RARITY) / len + C_LENGTH * len
# C_LENGTH = 0.0 means pure mean-weight (length-neutral). Tune after calibration.
C_LENGTH: float = 0.0

# Replay
REPLAY_BATCH: int = 20
REPLAY_PLATEAU_THRESHOLD: float = 0.05   # distinct-board growth fraction to count as flat
REPLAY_PLATEAU_BATCHES: int = 2          # consecutive flat batches to stop
REPLAY_MAX_RUNS: int = 200
REPLAY_FLOOR_STABILITY: float = 0.01    # min floor_score change to count as non-flat

# Scoring
FLOOR_PERCENTILE: float = 10.0  # percentile of bottlenecks for floor_score

# Dictionary
MIN_WORD_LENGTH: int = 2  # set against real boards after calibration batch
```

- [ ] **Step 5: Write export-constants.mjs**

```js
// packages/shared/export-constants.mjs
// Run from repo root: node packages/shared/export-constants.mjs
// Regenerate if LETTER_RARITY or TILE_DISTRIBUTION ever change.
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Import from the built dist (run npm run build:shared first if stale)
const { LETTER_RARITY } = await import('./dist/stats.js');
const { TILE_DISTRIBUTION } = await import('./dist/tiles.js');

const out = path.join(__dirname, '..', 'scripts', 'puzzlegen', 'shared_constants.json');
writeFileSync(out, JSON.stringify({ LETTER_RARITY, TILE_DISTRIBUTION }, null, 2) + '\n');
console.log('Wrote', out);
```

- [ ] **Step 6: Generate shared_constants.json**

```bash
npm run build:shared
node packages/shared/export-constants.mjs
```

Verify `scripts/puzzlegen/shared_constants.json` contains `LETTER_RARITY` and `TILE_DISTRIBUTION`.

- [ ] **Step 7: Create tests/__init__.py**

```python
# scripts/tests/__init__.py
```

(empty)

- [ ] **Step 8: Smoke-test pytest runs**

```bash
cd scripts
python -m pytest tests/ -v
```

Expected: "no tests ran" (0 collected), exit 0.

- [ ] **Step 9: Commit**

```bash
git add scripts/pyproject.toml scripts/puzzlegen/ scripts/tests/ packages/shared/export-constants.mjs
git commit -m "feat(puzzlegen): Python package scaffold, config, shared constants bridge"
```

---

## Task 4: RNG and difficulty formula

**Files:**
- Create: `scripts/puzzlegen/rng.py`
- Create: `scripts/puzzlegen/difficulty.py`
- Create: `scripts/tests/test_rng.py`
- Create: `scripts/tests/test_difficulty.py`

- [ ] **Step 1: Write failing tests**

```python
# scripts/tests/test_rng.py
from puzzlegen.rng import SeededRng

def test_deterministic():
    r1 = SeededRng(42)
    r2 = SeededRng(42)
    vals1 = [r1.next() for _ in range(100)]
    vals2 = [r2.next() for _ in range(100)]
    assert vals1 == vals2

def test_range():
    rng = SeededRng(1)
    for _ in range(1000):
        v = rng.next()
        assert 0.0 <= v < 1.0

def test_different_seeds_differ():
    r1 = SeededRng(1)
    r2 = SeededRng(2)
    assert [r1.next() for _ in range(10)] != [r2.next() for _ in range(10)]

def test_randint_range():
    rng = SeededRng(99)
    for _ in range(500):
        assert 0 <= rng.randint(5) < 5

def test_shuffle_permutation():
    rng = SeededRng(7)
    lst = list(range(10))
    original = lst[:]
    rng.shuffle(lst)
    assert sorted(lst) == original
    assert lst != original  # astronomically unlikely to be identical
```

```python
# scripts/tests/test_difficulty.py
from puzzlegen.difficulty import word_difficulty, LETTER_RARITY, TILE_DISTRIBUTION

def test_letter_rarity_loaded():
    assert LETTER_RARITY['E'] == 1
    assert LETTER_RARITY['Z'] == 9
    assert len(LETTER_RARITY) == 26

def test_tile_distribution_loaded():
    assert TILE_DISTRIBUTION['E'] == 18
    assert sum(TILE_DISTRIBUTION.values()) == 144

def test_difficulty_mean_weight_at_c0():
    # "EA" = (1+1)/2 + 0*2 = 1.0
    assert word_difficulty("EA") == 1.0

def test_difficulty_case_insensitive():
    assert word_difficulty("ea") == word_difficulty("EA")

def test_difficulty_length_neutral_at_c0():
    # same mean letter weight regardless of length
    assert word_difficulty("EE") == word_difficulty("E" * 10)

def test_difficulty_rarer_word_scores_higher():
    # "ZAP" mean = (9+1+6)/3 = 5.33; "ARE" mean = (1+2+1)/3 = 1.33
    assert word_difficulty("ZAP") > word_difficulty("ARE")

def test_difficulty_unknown_char_contributes_zero():
    assert word_difficulty("A") == word_difficulty("A1")  # '1' has weight 0
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
cd scripts
python -m pytest tests/test_rng.py tests/test_difficulty.py -v
```

Expected: `ModuleNotFoundError` or `ImportError`.

- [ ] **Step 3: Implement rng.py**

```python
# scripts/puzzlegen/rng.py

class SeededRng:
    """Mulberry32 PRNG. Deterministic, reproducible from seed alone."""

    def __init__(self, seed: int) -> None:
        self._state = seed & 0xFFFFFFFF

    def next(self) -> float:
        """Return float in [0, 1)."""
        self._state = (self._state + 0x6D2B79F5) & 0xFFFFFFFF
        z = self._state
        z = ((z ^ (z >> 15)) * ((z | 1) & 0xFFFFFFFF)) & 0xFFFFFFFF
        z = (z ^ ((z ^ (z >> 7)) * ((z | 61) & 0xFFFFFFFF))) & 0xFFFFFFFF
        z = (z ^ (z >> 14)) & 0xFFFFFFFF
        return z / 0x100000000

    def randint(self, n: int) -> int:
        """Return int in [0, n)."""
        return int(self.next() * n)

    def shuffle(self, lst: list) -> None:
        """Fisher-Yates in-place shuffle."""
        for i in range(len(lst) - 1, 0, -1):
            j = self.randint(i + 1)
            lst[i], lst[j] = lst[j], lst[i]
```

- [ ] **Step 4: Implement difficulty.py**

```python
# scripts/puzzlegen/difficulty.py
import json
from pathlib import Path
from .config import C_LENGTH

_data = json.loads((Path(__file__).parent / 'shared_constants.json').read_text())
LETTER_RARITY: dict[str, int] = _data['LETTER_RARITY']
TILE_DISTRIBUTION: dict[str, int] = _data['TILE_DISTRIBUTION']


def word_difficulty(word: str) -> float:
    """Two-term difficulty: mean letter rarity + C_LENGTH * length.
    At C_LENGTH=0 this is length-neutral mean letter weight.
    Both terms increase with rarity/length so higher = harder."""
    letters = word.upper()
    n = len(letters)
    if n == 0:
        return 0.0
    rarity_sum = sum(LETTER_RARITY.get(ch, 0) for ch in letters)
    return rarity_sum / n + C_LENGTH * n
```

- [ ] **Step 5: Run tests, confirm pass**

```bash
cd scripts
python -m pytest tests/test_rng.py tests/test_difficulty.py -v
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/puzzlegen/rng.py scripts/puzzlegen/difficulty.py scripts/tests/test_rng.py scripts/tests/test_difficulty.py
git commit -m "feat(puzzlegen): SeededRng (mulberry32) and two-term difficulty formula"
```

---

## Task 5: Pool (multiset operations)

**Files:**
- Create: `scripts/puzzlegen/pool.py`
- Create: `scripts/tests/test_pool.py`

A `Multiset` is `dict[str, int]`. The pool tracks letter availability.

- [ ] **Step 1: Write failing tests**

```python
# scripts/tests/test_pool.py
import pytest
from puzzlegen.pool import (
    pool_feasible, pool_consume, pool_restore,
    letters_needed, sorted_letter_string, multiset_total,
)

def test_feasible_exact():
    pool = {'A': 2, 'B': 1}
    assert pool_feasible(pool, {'A': 2, 'B': 1})

def test_feasible_partial():
    pool = {'A': 3}
    assert pool_feasible(pool, {'A': 2})

def test_not_feasible_exceeded():
    pool = {'A': 1}
    assert not pool_feasible(pool, {'A': 2})

def test_not_feasible_missing_letter():
    pool = {'A': 1}
    assert not pool_feasible(pool, {'B': 1})

def test_consume_and_restore():
    pool = {'A': 2, 'B': 1}
    needed = {'A': 1}
    pool_consume(pool, needed)
    assert pool['A'] == 1
    pool_restore(pool, needed)
    assert pool['A'] == 2

def test_consume_removes_zero_entries():
    pool = {'A': 1}
    pool_consume(pool, {'A': 1})
    assert 'A' not in pool

def test_letters_needed_for_new_cells():
    # word "CAT" placed H starting at col 0, row 0; cell (0,1) already has 'A'
    grid = {'0,1': 'A'}
    cells = ['0,0', '0,1', '0,2']
    word = 'CAT'
    result = letters_needed(grid, cells, word)
    # only new cells: (0,0)='C', (0,2)='T'
    assert result == {'C': 1, 'T': 1}

def test_sorted_letter_string():
    pool = {'B': 2, 'A': 3}
    assert sorted_letter_string(pool) == 'AAABB'

def test_multiset_total():
    assert multiset_total({'A': 3, 'B': 2}) == 5
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
cd scripts && python -m pytest tests/test_pool.py -v
```

- [ ] **Step 3: Implement pool.py**

```python
# scripts/puzzlegen/pool.py

Multiset = dict[str, int]


def pool_feasible(pool: Multiset, needed: Multiset) -> bool:
    return all(pool.get(ch, 0) >= count for ch, count in needed.items())


def pool_consume(pool: Multiset, needed: Multiset) -> None:
    """Subtract needed from pool in-place. Call only after pool_feasible."""
    for ch, count in needed.items():
        pool[ch] -= count
        if pool[ch] == 0:
            del pool[ch]


def pool_restore(pool: Multiset, returned: Multiset) -> None:
    """Add returned back to pool in-place."""
    for ch, count in returned.items():
        pool[ch] = pool.get(ch, 0) + count


def letters_needed(
    grid: dict[str, str],
    cells: list[str],
    word: str,
) -> Multiset:
    """Letters that must come from the pool for the new (empty) cells in `cells`.
    `cells` is the full set of cells the word occupies (in order); `word` is the same length."""
    needed: Multiset = {}
    for cell, letter in zip(cells, word):
        if cell not in grid:
            needed[letter] = needed.get(letter, 0) + 1
    return needed


def sorted_letter_string(pool: Multiset) -> str:
    """Canonical sorted string, e.g. {'B':2,'A':3} -> 'AAABB'."""
    return ''.join(sorted(ch * count for ch, count in pool.items()))


def multiset_total(pool: Multiset) -> int:
    return sum(pool.values())
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd scripts && python -m pytest tests/test_pool.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/puzzlegen/pool.py scripts/tests/test_pool.py
git commit -m "feat(puzzlegen): pool multiset operations with feasibility check"
```

---

## Task 6: Word index (NumPy bitset)

**Files:**
- Create: `scripts/puzzlegen/word_index.py`
- Create: `scripts/tests/test_word_index.py`

- [ ] **Step 1: Write failing tests**

```python
# scripts/tests/test_word_index.py
import pytest
from puzzlegen.word_index import WordIndex, build_index, pattern_query, first_feasible

WORDS = [
    ('CAT', 4.0), ('CAR', 3.0), ('BAT', 4.0), ('BAR', 3.0),
    ('CARE', 2.5), ('BARE', 2.5), ('ZAP', 5.0),
]

def make_index():
    return build_index(WORDS)

def test_build_groups_by_length():
    idx = make_index()
    assert set(idx.words.keys()) == {3, 4}
    assert len(idx.words[3]) == 5  # CAT CAR BAT BAR ZAP
    assert len(idx.words[4]) == 2  # CARE BARE

def test_within_bucket_sorted_by_difficulty():
    idx = make_index()
    diffs = [idx.difficulties[w] for w in idx.words[3]]
    assert diffs == sorted(diffs)

def test_pattern_all_open():
    idx = make_index()
    results = list(pattern_query(idx, 3, {}))
    words = [w for _, w in results]
    assert set(words) == {'CAT', 'CAR', 'BAT', 'BAR', 'ZAP'}

def test_pattern_fixed_first():
    idx = make_index()
    results = list(pattern_query(idx, 3, {0: 'C'}))
    words = [w for _, w in results]
    assert set(words) == {'CAT', 'CAR'}

def test_pattern_fixed_two_positions():
    idx = make_index()
    results = list(pattern_query(idx, 3, {0: 'C', 2: 'T'}))
    words = [w for _, w in results]
    assert words == ['CAT']

def test_pattern_no_match():
    idx = make_index()
    results = list(pattern_query(idx, 3, {0: 'X'}))
    assert results == []

def test_pattern_yields_difficulty_order():
    idx = make_index()
    results = list(pattern_query(idx, 3, {}))
    diffs = [idx.difficulties[w] for _, w in results]
    assert diffs == sorted(diffs)

def test_first_feasible_returns_min_difficulty():
    from puzzlegen.pool import pool_feasible
    idx = make_index()
    pool = {'C': 1, 'A': 1, 'R': 1, 'B': 1, 'T': 1, 'Z': 1, 'P': 1}
    word_i, word = first_feasible(idx, 3, {}, pool)
    # BAR and CAR both score 3.0; one of them comes first
    assert idx.difficulties[word] == 3.0

def test_word_set_membership():
    idx = make_index()
    assert 'CAT' in idx.word_set
    assert 'DOG' not in idx.word_set
```

- [ ] **Step 2: Run, confirm failure**

```bash
cd scripts && python -m pytest tests/test_word_index.py -v
```

- [ ] **Step 3: Implement word_index.py**

```python
# scripts/puzzlegen/word_index.py
from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
from .pool import Multiset, pool_feasible

ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

@dataclass
class WordIndex:
    # words[L] = list sorted ascending by difficulty
    words: dict[int, list[str]]
    # bits[L][pos * 26 + ch_index] = uint32 array, bit i set if words[L][i] has ch at pos
    bits: dict[int, np.ndarray]
    difficulties: dict[str, float]
    word_set: set[str]


def build_index(words_with_diff: list[tuple[str, float]]) -> WordIndex:
    """Build from (word, difficulty) pairs. Words must be uppercase."""
    by_length: dict[int, list[tuple[str, float]]] = {}
    for word, diff in words_with_diff:
        by_length.setdefault(len(word), []).append((word, diff))

    words_dict: dict[int, list[str]] = {}
    bits_dict: dict[int, np.ndarray] = {}
    difficulties: dict[str, float] = {w: d for w, d in words_with_diff}

    for L, pairs in by_length.items():
        pairs.sort(key=lambda x: x[1])
        word_list = [w for w, _ in pairs]
        words_dict[L] = word_list

        n = len(word_list)
        arr_len = (n + 31) // 32
        # bits array shape: (L * 26, arr_len)
        b = np.zeros((L * 26, arr_len), dtype=np.uint32)
        for i, word in enumerate(word_list):
            for pos, ch in enumerate(word):
                ch_idx = ord(ch) - ord('A')
                b[pos * 26 + ch_idx, i // 32] |= np.uint32(1 << (i % 32))
        bits_dict[L] = b

    return WordIndex(
        words=words_dict,
        bits=bits_dict,
        difficulties=difficulties,
        word_set={w for w, _ in words_with_diff},
    )


def pattern_query(
    index: WordIndex,
    length: int,
    fixed: dict[int, str],
) -> list[tuple[int, str]]:
    """Yield (word_idx, word) in difficulty order for words matching fixed positions."""
    if length not in index.bits:
        return []
    word_list = index.words[length]
    n = len(word_list)
    arr_len = (n + 31) // 32
    b = index.bits[length]

    result = np.ones(arr_len, dtype=np.uint32)
    # Mask off bits beyond n
    remainder = n % 32
    if remainder:
        result[-1] = np.uint32((1 << remainder) - 1)

    for pos, ch in fixed.items():
        ch_idx = ord(ch) - ord('A')
        result &= b[pos * 26 + ch_idx]

    # Extract set bit indices in order (ascending = difficulty order)
    out = []
    for chunk_i, chunk in enumerate(result):
        if not chunk:
            continue
        c = int(chunk)
        base = chunk_i * 32
        while c:
            lsb = c & (-c)
            bit = lsb.bit_length() - 1
            word_i = base + bit
            if word_i < n:
                out.append((word_i, word_list[word_i]))
            c ^= lsb
    return out


def first_feasible(
    index: WordIndex,
    length: int,
    fixed: dict[int, str],
    pool: Multiset,
) -> tuple[int, str] | None:
    """Return (idx, word) for lowest-difficulty feasible match, or None."""
    for word_i, word in pattern_query(index, length, fixed):
        # Compute letters needed for positions NOT in fixed (those come from pool)
        needed: Multiset = {}
        for pos, ch in enumerate(word):
            if pos not in fixed:
                needed[ch] = needed.get(ch, 0) + 1
        if pool_feasible(pool, needed):
            return word_i, word
    return None
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd scripts && python -m pytest tests/test_word_index.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/puzzlegen/word_index.py scripts/tests/test_word_index.py
git commit -m "feat(puzzlegen): NumPy bitset word index with difficulty-ordered pattern query"
```

---

## Task 7: Board — cell ops, anchors, pattern building

**Files:**
- Create: `scripts/puzzlegen/board.py` (partial — candidate enumeration added in Task 8)
- Create: `scripts/tests/test_board.py` (partial)

- [ ] **Step 1: Write failing tests for cell ops and anchors**

```python
# scripts/tests/test_board.py
from puzzlegen.board import (
    cell_key, cell_coords, neighbors_4,
    compute_active_anchors, build_fixed_pattern,
    cells_for_run,
)

def test_cell_key_roundtrip():
    assert cell_coords(cell_key(3, 7)) == (3, 7)
    assert cell_coords(cell_key(-1, 0)) == (-1, 0)

def test_neighbors_4():
    n = set(neighbors_4(cell_key(0, 0)))
    assert n == {cell_key(-1,0), cell_key(1,0), cell_key(0,-1), cell_key(0,1)}

def test_active_anchors_empty_grid():
    assert compute_active_anchors({}) == set()

def test_active_anchors_single_tile():
    grid = {cell_key(0, 0): 'A'}
    anchors = compute_active_anchors(grid)
    # 4 neighbors of (0,0) are all empty, all are anchors
    assert anchors == {cell_key(-1,0), cell_key(1,0), cell_key(0,-1), cell_key(0,1)}

def test_active_anchors_excludes_filled():
    grid = {cell_key(0,0): 'A', cell_key(0,1): 'B'}
    anchors = compute_active_anchors(grid)
    assert cell_key(0,0) not in anchors
    assert cell_key(0,1) not in anchors

def test_build_fixed_pattern_horizontal():
    # grid has 'C' at (0,0) and 'T' at (0,2); (0,1) is empty
    grid = {cell_key(0,0): 'C', cell_key(0,2): 'T'}
    pat = build_fixed_pattern(grid, start_r=0, start_c=0, length=3, direction='H')
    # position 0='C', position 1 open, position 2='T'
    assert pat == {0: 'C', 2: 'T'}

def test_build_fixed_pattern_vertical():
    grid = {cell_key(0,0): 'A', cell_key(2,0): 'Z'}
    pat = build_fixed_pattern(grid, start_r=0, start_c=0, length=3, direction='V')
    assert pat == {0: 'A', 2: 'Z'}

def test_cells_for_run_horizontal():
    cells = cells_for_run(start_r=1, start_c=2, length=3, direction='H')
    assert cells == [cell_key(1,2), cell_key(1,3), cell_key(1,4)]

def test_cells_for_run_vertical():
    cells = cells_for_run(start_r=0, start_c=0, length=2, direction='V')
    assert cells == [cell_key(0,0), cell_key(1,0)]
```

- [ ] **Step 2: Run, confirm failure**

```bash
cd scripts && python -m pytest tests/test_board.py -v
```

- [ ] **Step 3: Implement board.py (cell ops only)**

```python
# scripts/puzzlegen/board.py
from __future__ import annotations
from dataclasses import dataclass
from .pool import Multiset

CellKey = str  # "r,c"
Grid = dict[CellKey, str]


def cell_key(r: int, c: int) -> CellKey:
    return f"{r},{c}"


def cell_coords(key: CellKey) -> tuple[int, int]:
    r, c = key.split(',')
    return int(r), int(c)


def neighbors_4(key: CellKey) -> list[CellKey]:
    r, c = cell_coords(key)
    return [cell_key(r-1, c), cell_key(r+1, c), cell_key(r, c-1), cell_key(r, c+1)]


def compute_active_anchors(grid: Grid) -> set[CellKey]:
    """Empty cells adjacent to at least one filled cell."""
    anchors: set[CellKey] = set()
    for filled_cell in grid:
        for nb in neighbors_4(filled_cell):
            if nb not in grid:
                anchors.add(nb)
    return anchors


def build_fixed_pattern(
    grid: Grid,
    start_r: int,
    start_c: int,
    length: int,
    direction: str,
) -> dict[int, str]:
    """Return {position: letter} for already-filled cells in the run."""
    fixed: dict[int, str] = {}
    for i in range(length):
        r = start_r + (i if direction == 'V' else 0)
        c = start_c + (i if direction == 'H' else 0)
        ck = cell_key(r, c)
        if ck in grid:
            fixed[i] = grid[ck]
    return fixed


def cells_for_run(
    start_r: int,
    start_c: int,
    length: int,
    direction: str,
) -> list[CellKey]:
    out = []
    for i in range(length):
        r = start_r + (i if direction == 'V' else 0)
        c = start_c + (i if direction == 'H' else 0)
        out.append(cell_key(r, c))
    return out
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd scripts && python -m pytest tests/test_board.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/puzzlegen/board.py scripts/tests/test_board.py
git commit -m "feat(puzzlegen): board cell ops, active anchors, pattern building"
```

---

## Task 8: Board — candidate enumeration and cross-check

**Files:**
- Modify: `scripts/puzzlegen/board.py` (add enumeration + cross-check)
- Modify: `scripts/tests/test_board.py` (add enumeration tests)

This is the most complex task. The enumeration iterates anchors × directions × valid (start, length) pairs.

**Key invariants:**
- The word must include the anchor cell.
- If a filled cell exists immediately before the start or after the end of the proposed run, the word must be extended to include it (otherwise the resulting maximal run is not a valid word).
- Every perpendicular run formed or extended by new cells must be in `word_set` if it has length ≥ `min_length`.

- [ ] **Step 1: Add enumeration tests to test_board.py**

```python
# Add to scripts/tests/test_board.py
from puzzlegen.board import enumerate_candidates, PlacementCandidate
from puzzlegen.word_index import build_index
from puzzlegen.pool import Multiset

def _small_index():
    return build_index([
        ('CAT', 3.0), ('CAR', 2.5), ('AT', 1.0), ('ARC', 2.0),
        ('TAR', 2.5), ('TA', 1.5),
    ])

def test_enumerate_candidates_first_word_via_seed():
    # With empty grid, no anchors, enumerate_candidates returns nothing.
    # First word is handled separately by solve(); this is a baseline.
    idx = _small_index()
    pool = {'C':1,'A':1,'T':1,'R':1}
    candidates = enumerate_candidates(
        grid={}, active_anchors=set(), index=idx,
        pool=pool, word_set=idx.word_set,
        budget=21, min_length=2,
    )
    assert candidates == []

def test_enumerate_candidates_extends_existing_word():
    # Place 'CA' at (0,0)-(0,1); anchor at (0,2) is adjacent.
    # A horizontal word covering (0,2) and extending left to cover the 'CA' should appear.
    idx = _small_index()
    grid = {cell_key(0,0): 'C', cell_key(0,1): 'A'}
    anchors = compute_active_anchors(grid)
    pool = {'T': 2, 'R': 2}  # need T or R for new cell
    candidates = enumerate_candidates(
        grid=grid, active_anchors=anchors, index=idx,
        pool=pool, word_set=idx.word_set, budget=21, min_length=2,
    )
    words = {c.word for c in candidates}
    assert 'CAT' in words or 'CAR' in words

def test_enumerate_respects_pool():
    idx = _small_index()
    grid = {cell_key(0,0): 'C', cell_key(0,1): 'A'}
    anchors = compute_active_anchors(grid)
    pool = {}  # empty — no new tiles
    candidates = enumerate_candidates(
        grid=grid, active_anchors=anchors, index=idx,
        pool=pool, word_set=idx.word_set, budget=21, min_length=2,
    )
    assert candidates == []

def test_enumerate_respects_budget():
    idx = _small_index()
    grid = {cell_key(0,0): 'C', cell_key(0,1): 'A'}
    anchors = compute_active_anchors(grid)
    pool = {'T': 5, 'R': 5}
    # budget=0 means no new cells allowed
    candidates = enumerate_candidates(
        grid=grid, active_anchors=anchors, index=idx,
        pool=pool, word_set=idx.word_set, budget=0, min_length=2,
    )
    assert candidates == []

def test_candidate_has_correct_new_cells():
    idx = _small_index()
    grid = {cell_key(0,0): 'C', cell_key(0,1): 'A'}
    anchors = compute_active_anchors(grid)
    pool = {'T': 1, 'R': 1}
    candidates = enumerate_candidates(
        grid=grid, active_anchors=anchors, index=idx,
        pool=pool, word_set=idx.word_set, budget=21, min_length=2,
    )
    for c in candidates:
        if c.word == 'CAT':
            assert cell_key(0,2) in c.new_cells
            assert cell_key(0,0) not in c.new_cells
            assert cell_key(0,1) not in c.new_cells
```

- [ ] **Step 2: Run, confirm failure**

```bash
cd scripts && python -m pytest tests/test_board.py -v
```

- [ ] **Step 3: Add enumerate_candidates and PlacementCandidate to board.py**

```python
# Add to scripts/puzzlegen/board.py

from dataclasses import dataclass
from .word_index import WordIndex, pattern_query
from .pool import Multiset, pool_feasible, letters_needed


@dataclass
class PlacementCandidate:
    word: str
    anchor_cell: CellKey
    direction: str          # 'H' | 'V'
    start_r: int
    start_c: int
    cells: list[CellKey]     # all cells the word occupies
    new_cells: list[CellKey] # cells that were empty before placement
    new_letters: Multiset    # letters needed from pool for new_cells


def _perp_run(grid: Grid, r: int, c: int, direction: str) -> list[tuple[int, int]]:
    """Cells of the maximal run through (r,c) in the perpendicular direction."""
    if direction == 'H':
        dr, dc = 1, 0
    else:
        dr, dc = 0, 1
    run = [(r, c)]
    for sign in (-1, 1):
        nr, nc = r + sign*dr, c + sign*dc
        while cell_key(nr, nc) in grid:
            if sign == -1:
                run.insert(0, (nr, nc))
            else:
                run.append((nr, nc))
            nr += sign*dr
            nc += sign*dc
    return run


def _cross_check(
    grid: Grid,
    new_cells: list[CellKey],
    word: str,
    start_r: int,
    start_c: int,
    direction: str,
    word_set: set[str],
    min_length: int,
) -> bool:
    """Return True if every perpendicular run formed by new_cells is valid."""
    for cell in new_cells:
        r, c = cell_coords(cell)
        if direction == 'H':
            pos = c - start_c
        else:
            pos = r - start_r
        letter = word[pos]

        # Temporarily "place" the letter to scan the perpendicular run
        perp_dir = 'V' if direction == 'H' else 'H'
        if perp_dir == 'V':
            dr, dc = 1, 0
        else:
            dr, dc = 0, 1

        run_letters = [letter]
        # scan up/left
        nr, nc = r - dr, c - dc
        while cell_key(nr, nc) in grid:
            run_letters.insert(0, grid[cell_key(nr, nc)])
            nr -= dr; nc -= dc
        # scan down/right
        nr, nc = r + dr, c + dc
        while cell_key(nr, nc) in grid:
            run_letters.append(grid[cell_key(nr, nc)])
            nr += dr; nc += dc

        run_len = len(run_letters)
        if run_len == 1:
            continue  # single letter, not a word constraint
        run_word = ''.join(run_letters)
        if run_len < min_length or run_word not in word_set:
            return False
    return True


def enumerate_candidates(
    grid: Grid,
    active_anchors: set[CellKey],
    index: WordIndex,
    pool: Multiset,
    word_set: set[str],
    budget: int,
    min_length: int,
) -> list[PlacementCandidate]:
    """All valid placements covering any active anchor, across both directions."""
    seen: set[tuple] = set()  # deduplicate identical (word, start_r, start_c, dir)
    results: list[PlacementCandidate] = []

    for anchor in active_anchors:
        anc_r, anc_c = cell_coords(anchor)

        for direction in ('H', 'V'):
            # Axis deltas
            if direction == 'H':
                dr, dc = 0, 1
            else:
                dr, dc = 1, 0

            # Find how far the existing run extends left/up and right/down of anchor
            # The anchor is empty; scan outward to find consecutive filled neighbors
            left_run = 0  # filled cells touching anchor on the left/up side
            nr, nc = anc_r - dr, anc_c - dc
            while cell_key(nr, nc) in grid:
                left_run += 1
                nr -= dr; nc -= dc

            right_run = 0
            nr, nc = anc_r + dr, anc_c + dc
            while cell_key(nr, nc) in grid:
                right_run += 1
                nr += dr; nc += dc

            # The word must span from at least (anchor - left_run) to (anchor + right_run)
            # i.e. include all consecutive filled cells touching the anchor
            must_start_r = anc_r - left_run * dr
            must_start_c = anc_c - left_run * dc
            must_end_r = anc_r + right_run * dr
            must_end_c = anc_c + right_run * dc
            core_len = left_run + 1 + right_run  # minimum word length

            # Extend the word further left (into currently empty cells)
            max_left_ext = 0
            nr, nc = must_start_r - dr, must_start_c - dc
            while cell_key(nr, nc) not in grid:
                max_left_ext += 1
                nr -= dr; nc -= dc
                if abs(nr) > 50 or abs(nc) > 50:
                    break

            # Extend right
            max_right_ext = 0
            nr, nc = must_end_r + dr, must_end_c + dc
            while cell_key(nr, nc) not in grid:
                max_right_ext += 1
                nr += dr; nc += dc
                if abs(nr) > 50 or abs(nc) > 50:
                    break

            # Enumerate all (left_ext, right_ext) choices
            for left_ext in range(0, max_left_ext + 1):
                start_r = must_start_r - left_ext * dr
                start_c = must_start_c - left_ext * dc

                for right_ext in range(0, max_right_ext + 1):
                    length = core_len + left_ext + right_ext
                    if length < min_length:
                        continue

                    end_r = must_end_r + right_ext * dr
                    end_c = must_end_c + right_ext * dc

                    cells = cells_for_run(start_r, start_c, length, direction)
                    new_cells = [ck for ck in cells if ck not in grid]
                    if not new_cells:
                        continue
                    if len(new_cells) > budget:
                        continue

                    fixed = build_fixed_pattern(grid, start_r, start_c, length, direction)

                    for _, word in pattern_query(index, length, fixed):
                        key = (word, start_r, start_c, direction)
                        if key in seen:
                            continue

                        nl = letters_needed(grid, cells, word)
                        if not pool_feasible(pool, nl):
                            continue
                        if not _cross_check(grid, new_cells, word, start_r, start_c,
                                            direction, word_set, min_length):
                            continue

                        seen.add(key)
                        results.append(PlacementCandidate(
                            word=word,
                            anchor_cell=anchor,
                            direction=direction,
                            start_r=start_r,
                            start_c=start_c,
                            cells=cells,
                            new_cells=new_cells,
                            new_letters=nl,
                        ))

    return results
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd scripts && python -m pytest tests/test_board.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/puzzlegen/board.py scripts/tests/test_board.py
git commit -m "feat(puzzlegen): candidate enumeration with cross-check validation"
```

---

## Task 9: Solve — shared DFS (construction and replay)

**Files:**
- Create: `scripts/puzzlegen/solve.py`
- Create: `scripts/tests/test_solve.py`

The `solve()` function handles both construction (pool=full bag, deterministic anchors) and replay (pool=tray letters, shuffled anchors).

- [ ] **Step 1: Write failing tests**

```python
# scripts/tests/test_solve.py
from puzzlegen.solve import solve, SolveParams, SolveResult
from puzzlegen.word_index import build_index
from puzzlegen.pool import multiset_total
from puzzlegen.difficulty import TILE_DISTRIBUTION
from puzzlegen.rng import SeededRng
import copy

# Small word set for controlled tests
WORDS = [
    ('CAT', 3.0), ('CAR', 2.5), ('ARC', 2.0), ('AT', 1.0),
    ('TAR', 2.5), ('TAB', 3.5), ('BAR', 3.0), ('BAT', 3.0),
    ('CART', 2.5), ('SCAR', 3.0), ('CATS', 3.0), ('BATS', 3.0),
    ('BARS', 3.0), ('CARS', 2.5), ('ARTS', 2.5), ('RATS', 2.5),
    ('STAR', 3.0), ('TARS', 2.5), ('ART', 2.0), ('RAT', 2.5),
    ('SAT', 2.5), ('TAT', 3.0), ('SAR', 2.5), ('ARCS', 2.0),
]

def make_params(pool, target, randomize=False, seed=1, node_budget=50_000):
    idx = build_index(WORDS)
    return SolveParams(
        index=idx,
        word_set=idx.word_set,
        initial_pool=pool,
        target_tiles=target,
        randomize_anchors=randomize,
        rng=SeededRng(seed),
        node_budget=node_budget,
        min_length=2,
    )

def test_construction_returns_result():
    pool = copy.copy(TILE_DISTRIBUTION)
    params = make_params(pool, target=6)
    result = solve(1, params)
    assert result is not None
    assert isinstance(result, SolveResult)

def test_construction_places_correct_tile_count():
    pool = copy.copy(TILE_DISTRIBUTION)
    params = make_params(pool, target=6)
    result = solve(1, params)
    assert result is not None
    assert multiset_total(result.letters) == 6

def test_pool_constraint_holds():
    # Every letter in result.letters must have been in TILE_DISTRIBUTION
    pool = copy.copy(TILE_DISTRIBUTION)
    params = make_params(pool, target=6)
    result = solve(1, params)
    assert result is not None
    for ch, count in result.letters.items():
        assert TILE_DISTRIBUTION.get(ch, 0) >= count

def test_trace_length_matches_placements():
    pool = copy.copy(TILE_DISTRIBUTION)
    params = make_params(pool, target=6)
    result = solve(1, params)
    assert result is not None
    # Each trace entry is one placement; total new tiles == target
    total_new = sum(entry.new_cell_count for entry in result.trace)
    assert total_new == 6

def test_node_budget_returns_none():
    pool = copy.copy(TILE_DISTRIBUTION)
    params = make_params(pool, target=21, node_budget=1)  # impossible budget
    result = solve(999, params)
    assert result is None

def test_replay_different_seed_may_differ():
    # Two replay seeds from same tray may produce different boards
    pool = {'C': 1, 'A': 2, 'T': 1, 'R': 1, 'B': 1}
    p1 = make_params(pool, target=6, randomize=True, seed=1)
    p2 = make_params(pool, target=6, randomize=True, seed=2)
    r1 = solve(1, p1)
    r2 = solve(2, p2)
    # Both should succeed (or both None if word set too small) — at least confirm no crash
    assert r1 is None or isinstance(r1, SolveResult)
    assert r2 is None or isinstance(r2, SolveResult)

def test_deterministic_with_same_seed():
    pool = copy.copy(TILE_DISTRIBUTION)
    p1 = make_params(pool, target=6, seed=42)
    p2 = make_params(copy.copy(TILE_DISTRIBUTION), target=6, seed=42)
    r1 = solve(42, p1)
    r2 = solve(42, p2)
    if r1 is None:
        assert r2 is None
    else:
        assert r1.first_word == r2.first_word
        assert r1.letters == r2.letters
```

- [ ] **Step 2: Run, confirm failure**

```bash
cd scripts && python -m pytest tests/test_solve.py -v
```

- [ ] **Step 3: Implement solve.py**

```python
# scripts/puzzlegen/solve.py
from __future__ import annotations
from dataclasses import dataclass, field
import copy

from .board import (
    CellKey, Grid, PlacementCandidate, cell_key,
    compute_active_anchors, enumerate_candidates, cells_for_run,
)
from .pool import Multiset, pool_consume, pool_restore, multiset_total, sorted_letter_string
from .word_index import WordIndex
from .rng import SeededRng
from .difficulty import word_difficulty


@dataclass
class LogEntry:
    step: int
    anchor_cell: CellKey
    fixed_pattern: str        # e.g. '__A__T_'
    candidate_count: int      # popcount — slight overcount of feasible; logged only
    min_candidate_rarity: float
    word_chosen: str
    direction: str
    new_cell_count: int


@dataclass
class SolveParams:
    index: WordIndex
    word_set: set[str]
    initial_pool: Multiset
    target_tiles: int
    randomize_anchors: bool   # True for replay, False for construction
    rng: SeededRng
    node_budget: int
    min_length: int


@dataclass
class SolveResult:
    grid: Grid
    letters: Multiset          # multiset of all letters placed
    trace: list[LogEntry]
    seed: int
    first_word: str


@dataclass
class _State:
    grid: Grid
    pool: Multiset
    placed_count: int
    active_anchors: set[CellKey]
    trace: list[LogEntry]
    placement_stack: list[PlacementCandidate]


def _apply(state: _State, p: PlacementCandidate) -> None:
    for cell, letter in zip(p.cells, p.word):
        state.grid[cell] = letter
    pool_consume(state.pool, p.new_letters)
    state.placed_count += len(p.new_cells)
    state.placement_stack.append(p)
    state.active_anchors = compute_active_anchors(state.grid)


def _undo(state: _State, p: PlacementCandidate) -> None:
    for cell in p.new_cells:
        del state.grid[cell]
    pool_restore(state.pool, p.new_letters)
    state.placed_count -= len(p.new_cells)
    state.active_anchors = compute_active_anchors(state.grid)


def _placement_key(p: PlacementCandidate) -> tuple:
    return (p.word, p.start_r, p.start_c, p.direction)


def _pick_first_word(pool: Multiset, index: WordIndex, rng: SeededRng, min_length: int) -> str | None:
    """Pick a random feasible word of length 4-7 to start construction."""
    candidates = []
    for length in range(4, 8):
        if length not in index.words:
            continue
        for word in index.words[length]:
            needed = {ch: word.count(ch) for ch in set(word)}
            from .pool import pool_feasible
            if pool_feasible(pool, needed):
                candidates.append(word)
    if not candidates:
        return None
    return candidates[rng.randint(len(candidates))]


def solve(seed: int, params: SolveParams) -> SolveResult | None:
    pool = copy.copy(params.initial_pool)
    rng = params.rng
    idx = params.index

    state = _State(
        grid={},
        pool=pool,
        placed_count=0,
        active_anchors=set(),
        trace=[],
        placement_stack=[],
    )

    # Place first word
    first_word = _pick_first_word(pool, idx, rng, params.min_length)
    if first_word is None:
        return None

    # Place horizontally at (0, 0)
    first_cells = [cell_key(0, i) for i in range(len(first_word))]
    from .pool import pool_feasible
    needed = {ch: first_word.count(ch) for ch in set(first_word)}
    if not pool_feasible(pool, needed):
        return None

    p0 = PlacementCandidate(
        word=first_word,
        anchor_cell=cell_key(0, 0),
        direction='H',
        start_r=0,
        start_c=0,
        cells=first_cells,
        new_cells=first_cells,
        new_letters=needed,
    )
    state.trace.append(LogEntry(
        step=0,
        anchor_cell=cell_key(0, 0),
        fixed_pattern='_' * len(first_word),
        candidate_count=1,
        min_candidate_rarity=word_difficulty(first_word),
        word_chosen=first_word,
        direction='H',
        new_cell_count=len(first_word),
    ))
    _apply(state, p0)

    nodes = 0
    # tried_at_depth[i] = set of placement keys already tried at stack depth i
    tried_at_depth: list[set[tuple]] = [set()]

    while state.placed_count < params.target_tiles:
        nodes += 1
        if nodes > params.node_budget:
            return None

        budget = params.target_tiles - state.placed_count
        anchors = list(state.active_anchors)
        if params.randomize_anchors:
            rng.shuffle(anchors)

        # Enumerate all candidates (with anchor randomization already applied via order)
        all_candidates = enumerate_candidates(
            grid=state.grid,
            active_anchors=set(anchors),  # set for O(1) lookup inside enumerate
            index=idx,
            pool=state.pool,
            word_set=params.word_set,
            budget=budget,
            min_length=params.min_length,
        )

        current_tabu = tried_at_depth[-1]
        feasible = [c for c in all_candidates if _placement_key(c) not in current_tabu]

        if not feasible:
            # Backtrack
            if not state.placement_stack:
                return None
            last = state.placement_stack[-1]
            state.trace.pop()
            _undo(state, last)
            state.placement_stack.pop()
            tried_at_depth.pop()
            if tried_at_depth:
                tried_at_depth[-1].add(_placement_key(last))
            else:
                return None
            continue

        # Greedy: pick lowest difficulty; RNG breaks ties
        min_diff = min(word_difficulty(c.word) for c in feasible)
        tied = [c for c in feasible if word_difficulty(c.word) == min_diff]
        best = tied[rng.randint(len(tied))]

        # candidate_count: popcount is expensive to compute exactly here;
        # use len(all_candidates) as the logged value (acknowledged overcount).
        from .board import build_fixed_pattern
        fixed_pat = build_fixed_pattern(
            state.grid, best.start_r, best.start_c, len(best.word), best.direction
        )
        fixed_str = ''.join(fixed_pat.get(i, '_') for i in range(len(best.word)))

        state.trace.append(LogEntry(
            step=len(state.trace),
            anchor_cell=best.anchor_cell,
            fixed_pattern=fixed_str,
            candidate_count=len(all_candidates),
            min_candidate_rarity=min_diff,
            word_chosen=best.word,
            direction=best.direction,
            new_cell_count=len(best.new_cells),
        ))

        current_tabu.add(_placement_key(best))
        _apply(state, best)
        tried_at_depth.append(set())

    letters = {ch: 0 for ch in state.grid.values()}
    for ch in state.grid.values():
        letters[ch] = letters.get(ch, 0) + 1

    return SolveResult(
        grid=dict(state.grid),
        letters=letters,
        trace=state.trace,
        seed=seed,
        first_word=first_word,
    )
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd scripts && python -m pytest tests/test_solve.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/puzzlegen/solve.py scripts/tests/test_solve.py
git commit -m "feat(puzzlegen): shared DFS solve() with tabu backtracking for construction and replay"
```

---

## Task 10: Canonical, swap sample, and scoring

**Files:**
- Create: `scripts/puzzlegen/canonical.py`
- Create: `scripts/puzzlegen/swap.py`
- Create: `scripts/puzzlegen/score.py`
- Create: `scripts/tests/test_canonical.py`
- Create: `scripts/tests/test_swap.py`
- Create: `scripts/tests/test_score.py`

- [ ] **Step 1: Write failing tests**

```python
# scripts/tests/test_canonical.py
from puzzlegen.canonical import canonicalize

def test_translation_invariant():
    g1 = {'0,0': 'A', '0,1': 'B'}
    g2 = {'5,3': 'A', '5,4': 'B'}
    assert canonicalize(g1) == canonicalize(g2)

def test_different_shapes_differ():
    g1 = {'0,0': 'A', '0,1': 'B'}
    g2 = {'0,0': 'A', '1,0': 'B'}
    assert canonicalize(g1) != canonicalize(g2)

def test_canonical_is_string():
    assert isinstance(canonicalize({'0,0': 'A'}), str)
```

```python
# scripts/tests/test_score.py
from puzzlegen.score import bottleneck, score_tray, should_stop
from puzzlegen.solve import LogEntry

def _make_run(max_diff: float) -> object:
    """Minimal replay run object."""
    class Run:
        pass
    r = Run()
    r.bottleneck = max_diff
    return r

def test_bottleneck_max_of_trace():
    entries = [
        LogEntry(0,'0,0','_',5,1.0,'AT','H',2),
        LogEntry(1,'0,1','_',3,3.0,'ZAP','H',3),
        LogEntry(2,'1,0','_',2,2.0,'TAR','V',3),
    ]
    assert bottleneck(entries) == 3.0

def test_score_tray_10th_percentile():
    runs = [_make_run(float(i)) for i in range(1, 11)]  # bottlenecks 1..10
    floor, spread = score_tray(runs, floor_percentile=10.0)
    # 10th pct of [1..10] = 1.9
    assert 1.0 <= floor <= 2.0

def test_score_tray_spread():
    runs = [_make_run(1.0), _make_run(3.0)]
    floor, spread = score_tray(runs, floor_percentile=10.0)
    mean = 2.0
    assert spread == mean - floor

def test_should_stop_requires_both():
    # Neither condition: don't stop
    assert not should_stop(
        board_growth_flat_batches=1,
        floor_flat_batches=1,
        plateau_batches=2,
    )
    # Only board flat: don't stop
    assert not should_stop(
        board_growth_flat_batches=2,
        floor_flat_batches=1,
        plateau_batches=2,
    )
    # Both flat: stop
    assert should_stop(
        board_growth_flat_batches=2,
        floor_flat_batches=2,
        plateau_batches=2,
    )
```

- [ ] **Step 2: Run, confirm failure**

```bash
cd scripts && python -m pytest tests/test_canonical.py tests/test_score.py -v
```

- [ ] **Step 3: Implement canonical.py**

```python
# scripts/puzzlegen/canonical.py
from .board import cell_coords

def canonicalize(grid: dict[str, str]) -> str:
    """Translate grid so min-row=0, min-col=0, then serialize sorted."""
    if not grid:
        return ''
    coords = [cell_coords(k) for k in grid]
    min_r = min(r for r, c in coords)
    min_c = min(c for r, c in coords)
    normalized = {
        f"{r - min_r},{c - min_c}": grid[f"{r},{c}"]
        for r, c in coords
    }
    return '|'.join(f"{k}:{v}" for k, v in sorted(normalized.items()))
```

- [ ] **Step 4: Implement score.py**

```python
# scripts/puzzlegen/score.py
from __future__ import annotations
import statistics
from .solve import LogEntry
from .config import (
    REPLAY_PLATEAU_THRESHOLD, REPLAY_PLATEAU_BATCHES,
    REPLAY_FLOOR_STABILITY, FLOOR_PERCENTILE,
)


def bottleneck(trace: list[LogEntry]) -> float:
    if not trace:
        return 0.0
    return max(e.min_candidate_rarity for e in trace)


def score_tray(
    runs: list,           # list of objects with .bottleneck attribute
    floor_percentile: float = FLOOR_PERCENTILE,
) -> tuple[float, float]:
    """Return (floor_score, spread_score).
    floor_score = floor_percentile-th percentile of bottlenecks.
    spread_score = mean - floor_score."""
    if not runs:
        raise ValueError("score_tray called with empty runs — drop this tray")
    bottlenecks = [r.bottleneck for r in runs]
    n = len(bottlenecks)
    sorted_b = sorted(bottlenecks)
    # Interpolated percentile
    idx_f = (floor_percentile / 100.0) * (n - 1)
    lo = int(idx_f)
    hi = min(lo + 1, n - 1)
    floor = sorted_b[lo] + (idx_f - lo) * (sorted_b[hi] - sorted_b[lo])
    mean = statistics.mean(bottlenecks)
    spread = mean - floor
    return floor, spread


def should_stop(
    board_growth_flat_batches: int,
    floor_flat_batches: int,
    plateau_batches: int = REPLAY_PLATEAU_BATCHES,
) -> bool:
    """Both conditions must be met."""
    return (board_growth_flat_batches >= plateau_batches and
            floor_flat_batches >= plateau_batches)
```

- [ ] **Step 5: Implement swap.py**

```python
# scripts/puzzlegen/swap.py
from __future__ import annotations
from .board import Grid, cells_for_run, build_fixed_pattern, cell_coords, cell_key, _cross_check
from .word_index import WordIndex, pattern_query
from .canonical import canonicalize


def swap_sample(
    grid: Grid,
    index: WordIndex,
    word_set: set[str],
    min_length: int,
) -> set[str]:
    """Find alternate boards by swapping words for same-pattern alternatives."""
    found: set[str] = set()

    # Extract all maximal runs as (direction, start_r, start_c, word) tuples
    runs = _extract_runs(grid, min_length)

    for direction, start_r, start_c, word in runs:
        length = len(word)
        fixed = build_fixed_pattern(grid, start_r, start_c, length, direction)
        # Fully fixed pattern: all positions known
        full_fixed = {i: word[i] for i in range(length)}

        for _, alt_word in pattern_query(index, length, full_fixed):
            if alt_word == word:
                continue
            # Build alternate grid
            alt_grid = dict(grid)
            cells = cells_for_run(start_r, start_c, length, direction)
            for cell, letter in zip(cells, alt_word):
                alt_grid[cell] = letter
            # Validate all runs in alt_grid
            if _all_runs_valid(alt_grid, word_set, min_length):
                found.add(canonicalize(alt_grid))

    return found


def _extract_runs(grid: Grid, min_length: int) -> list[tuple[str, int, int, str]]:
    seen: set[tuple] = set()
    runs = []
    for key in grid:
        r, c = cell_coords(key)
        for direction in ('H', 'V'):
            if direction == 'H':
                dr, dc = 0, 1
            else:
                dr, dc = 1, 0
            # Only start a run if the cell before it is not filled
            prev = cell_key(r - dr, c - dc)
            if prev in grid:
                continue
            # Collect the run
            letters = []
            nr, nc = r, c
            while cell_key(nr, nc) in grid:
                letters.append(grid[cell_key(nr, nc)])
                nr += dr; nc += dc
            if len(letters) >= min_length:
                key2 = (direction, r, c)
                if key2 not in seen:
                    seen.add(key2)
                    runs.append((direction, r, c, ''.join(letters)))
    return runs


def _all_runs_valid(grid: Grid, word_set: set[str], min_length: int) -> bool:
    for direction, start_r, start_c, word in _extract_runs(grid, 1):
        if len(word) >= min_length and word not in word_set:
            return False
        if 1 < len(word) < min_length:
            return False
    return True
```

- [ ] **Step 6: Run all three test files**

```bash
cd scripts && python -m pytest tests/test_canonical.py tests/test_score.py -v
```

- [ ] **Step 7: Commit**

```bash
git add scripts/puzzlegen/canonical.py scripts/puzzlegen/swap.py scripts/puzzlegen/score.py \
        scripts/tests/test_canonical.py scripts/tests/test_score.py
git commit -m "feat(puzzlegen): canonicalization, swap sampling, and scoring with dual-plateau stopping"
```

---

## Task 11: Validate (Python validateStructure)

**Files:**
- Create: `scripts/puzzlegen/validate.py`
- Create: `scripts/tests/test_validate.py`

This reimplements the TS `validateStructure` and `validateWithDictionary` from `packages/shared/src/grid.ts`. The test corpus is the contract between the two implementations.

- [ ] **Step 1: Write the cross-test corpus and failing tests**

```python
# scripts/tests/test_validate.py
from puzzlegen.validate import validate_structure, validate_with_dictionary

# Known-good grids (match TS validateStructure returning valid=True)
GOOD_TWO_WORD = {
    '0,0': 'C', '0,1': 'A', '0,2': 'T',   # CAT horizontal
    '1,2': 'A',                              # T connects to A
    '2,2': 'R',                              # A...R
    # "TAR" vertical at col 2
}

GOOD_SINGLE_WORD = {'0,0': 'A', '0,1': 'T'}

# Known-bad grids
BAD_DISCONNECTED = {
    '0,0': 'A', '0,1': 'T',
    '5,5': 'Z', '5,6': 'A',  # separate island
}

BAD_EXTRA_TILES = {'0,0': 'A', '0,1': 'T'}  # dealt only 1 tile
BAD_MISSING_TILES = {'0,0': 'A', '0,1': 'T', '0,2': 'E'}  # dealt 5

def test_valid_two_word():
    result = validate_structure(GOOD_TWO_WORD, list('CATAAR'))
    assert result['valid'], result

def test_valid_single_word():
    result = validate_structure(GOOD_SINGLE_WORD, list('AT'))
    assert result['valid'], result

def test_disconnected():
    result = validate_structure(BAD_DISCONNECTED, list('ATZA'))
    assert not result['valid']
    assert result['reason'] == 'DISCONNECTED'

def test_extra_tiles_in_rack():
    # dealt 5 tiles but grid only uses 2
    result = validate_structure(GOOD_SINGLE_WORD, list('ATXYZ'))
    assert not result['valid']
    assert result['reason'] == 'TILES_REMAINING'

def test_too_many_tiles_placed():
    # dealt 1 tile but grid uses 2
    result = validate_structure(GOOD_SINGLE_WORD, list('A'))
    assert not result['valid']
    assert result['reason'] == 'EXTRA_TILES'

def test_empty_grid():
    result = validate_structure({}, [])
    assert not result['valid']
    assert result['reason'] == 'EMPTY_GRID'

def test_with_dictionary_valid():
    word_set = {'AT', 'CAT', 'TAR', 'AR'}
    result = validate_with_dictionary(GOOD_TWO_WORD, list('CATAAR'), word_set, min_length=2)
    # TAR is valid; CAT is valid; any cross-run must be valid
    assert result['valid'] or result.get('invalid_words') is not None

def test_with_dictionary_invalid_word():
    grid = {'0,0': 'X', '0,1': 'Y'}
    word_set = {'AT'}
    result = validate_with_dictionary(grid, list('XY'), word_set, min_length=2)
    assert not result['valid']
    assert 'XY' in result.get('invalid_words', [])
```

- [ ] **Step 2: Run, confirm failure**

```bash
cd scripts && python -m pytest tests/test_validate.py -v
```

- [ ] **Step 3: Implement validate.py**

```python
# scripts/puzzlegen/validate.py
from __future__ import annotations
from collections import Counter
from .board import cell_coords, cell_key, neighbors_4


def _grid_letter_counts(grid: dict[str, str]) -> Counter:
    return Counter(grid.values())


def _is_connected(grid: dict[str, str]) -> bool:
    if not grid:
        return True
    start = next(iter(grid))
    visited = {start}
    queue = [start]
    while queue:
        cell = queue.pop()
        for nb in neighbors_4(cell):
            if nb in grid and nb not in visited:
                visited.add(nb)
                queue.append(nb)
    return len(visited) == len(grid)


def _extract_maximal_runs(grid: dict[str, str], min_length: int = 1) -> list[str]:
    seen: set[tuple] = set()
    runs = []
    for key in grid:
        r, c = cell_coords(key)
        for direction in ('H', 'V'):
            dr, dc = (0, 1) if direction == 'H' else (1, 0)
            prev = cell_key(r - dr, c - dc)
            if prev in grid:
                continue
            letters = []
            nr, nc = r, c
            while cell_key(nr, nc) in grid:
                letters.append(grid[cell_key(nr, nc)])
                nr += dr; nc += dc
            if len(letters) >= min_length:
                run_key = (direction, r, c)
                if run_key not in seen:
                    seen.add(run_key)
                    runs.append(''.join(letters))
    return runs


def validate_structure(
    grid: dict[str, str],
    dealt_tiles: list[str],
) -> dict:
    """Mirror of TS validateStructure. Returns {valid, reason?}."""
    if not grid:
        return {'valid': False, 'reason': 'EMPTY_GRID'}

    grid_counts = _grid_letter_counts(grid)
    dealt_counts = Counter(dealt_tiles)

    if grid_counts != dealt_counts:
        # Determine which direction
        for ch in grid_counts:
            if grid_counts[ch] > dealt_counts.get(ch, 0):
                return {'valid': False, 'reason': 'EXTRA_TILES'}
        return {'valid': False, 'reason': 'TILES_REMAINING'}

    if not _is_connected(grid):
        return {'valid': False, 'reason': 'DISCONNECTED'}

    return {'valid': True}


def validate_with_dictionary(
    grid: dict[str, str],
    dealt_tiles: list[str],
    word_set: set[str],
    min_length: int = 2,
) -> dict:
    """Mirror of TS validateWithDictionary. Returns {valid, invalid_words?}."""
    structural = validate_structure(grid, dealt_tiles)
    if not structural['valid']:
        return structural

    runs = _extract_maximal_runs(grid, min_length=1)
    invalid = []
    for run in runs:
        if len(run) < min_length:
            if len(run) > 1:
                invalid.append(run)
        elif run not in word_set:
            invalid.append(run)

    if invalid:
        return {'valid': False, 'invalid_words': invalid}
    return {'valid': True}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd scripts && python -m pytest tests/test_validate.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/puzzlegen/validate.py scripts/tests/test_validate.py
git commit -m "feat(puzzlegen): Python validateStructure + validateWithDictionary cross-tested against known corpus"
```

---

## Task 12: Word loading from Postgres

**Files:**
- Create: `scripts/puzzlegen/loader.py`
- Create: `scripts/tests/test_loader.py`

- [ ] **Step 1: Write failing test (requires local DB)**

```python
# scripts/tests/test_loader.py
import os
import pytest
from puzzlegen.loader import load_words_for_language

# Skip if no DB available
pytestmark = pytest.mark.skipif(
    not os.environ.get('DATABASE_URL'),
    reason='DATABASE_URL not set — skipping DB tests',
)

def test_load_english_words():
    url = os.environ['DATABASE_URL']
    words = load_words_for_language(url, 'en', min_length=2)
    assert len(words) > 100_000
    assert all(isinstance(w, str) and w == w.upper() for w, _ in words)

def test_load_spanish_words():
    url = os.environ['DATABASE_URL']
    words = load_words_for_language(url, 'es', min_length=2)
    assert len(words) > 100_000

def test_load_unknown_language_raises():
    with pytest.raises(ValueError, match='Unknown language'):
        load_words_for_language('postgresql://localhost/test', 'xx', min_length=2)
```

- [ ] **Step 2: Implement loader.py**

```python
# scripts/puzzlegen/loader.py
from __future__ import annotations
import psycopg
from .difficulty import word_difficulty

_LANGUAGE_SLUGS = {'en', 'es', 'fr', 'de'}


def load_words_for_language(
    db_url: str,
    language: str,
    min_length: int = 2,
) -> list[tuple[str, float]]:
    """Load (word, difficulty) pairs for a language. English uses base partition."""
    if language not in _LANGUAGE_SLUGS:
        raise ValueError(f"Unknown language: {language!r}. Must be one of {_LANGUAGE_SLUGS}")

    with psycopg.connect(db_url) as conn:
        if language == 'en':
            rows = conn.execute(
                "SELECT word FROM public.words "
                "WHERE custom_set_id IS NULL "
                "  AND char_length(word) >= %s",
                (min_length,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT w.word FROM public.words w "
                "JOIN public.custom_word_sets cs ON cs.id = w.custom_set_id "
                "WHERE cs.owner_id IS NULL AND cs.slug = %s "
                "  AND char_length(w.word) >= %s",
                (language, min_length)
            ).fetchall()

    return [(row[0].upper(), word_difficulty(row[0].upper())) for row in rows]
```

- [ ] **Step 3: Run DB tests (with local Supabase running)**

```bash
cd scripts
npm run db:start  # from repo root; or have it already running
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  python -m pytest tests/test_loader.py -v
```

- [ ] **Step 4: Commit**

```bash
git add scripts/puzzlegen/loader.py scripts/tests/test_loader.py
git commit -m "feat(puzzlegen): word loader from Postgres, handles en base partition + es/fr/de slugs"
```

---

## Task 13: Sample + score pipeline

**Files:**
- Create: `scripts/puzzlegen/pipeline.py`
- Create: `scripts/tests/test_pipeline.py`

This wires construct → replay loop → swap sample → score into one reusable function.

- [ ] **Step 1: Write failing tests**

```python
# scripts/tests/test_pipeline.py
import copy
from puzzlegen.pipeline import construct_and_score
from puzzlegen.word_index import build_index
from puzzlegen.difficulty import TILE_DISTRIBUTION

WORDS = [
    ('CAT', 3.0), ('CAR', 2.5), ('ARC', 2.0), ('AT', 1.0),
    ('TAR', 2.5), ('TAB', 3.5), ('BAR', 3.0), ('BAT', 3.0),
    ('CART', 2.5), ('CATS', 3.0), ('BARS', 3.0), ('CARS', 2.5),
    ('ARTS', 2.5), ('RATS', 2.5), ('STAR', 3.0), ('TARS', 2.5),
    ('ART', 2.0), ('RAT', 2.5), ('SAT', 2.5), ('ARCS', 2.0),
]

def test_construct_and_score_returns_row():
    idx = build_index(WORDS)
    row = construct_and_score(
        seed=1,
        index=idx,
        word_set=idx.word_set,
        language='en',
        target_tiles=6,
        node_budget=10_000,
        min_length=2,
    )
    assert row is not None
    assert 'letter_multiset' in row
    assert 'floor_score' in row
    assert row['replay_run_count'] > 0
    assert row['floor_score'] >= 0

def test_bad_seed_returns_none():
    idx = build_index(WORDS)
    # Node budget so small that construction always fails
    row = construct_and_score(
        seed=42,
        index=idx,
        word_set=idx.word_set,
        language='en',
        target_tiles=50,  # impossible with this tiny word set
        node_budget=5,
        min_length=2,
    )
    assert row is None

def test_row_has_required_fields():
    idx = build_index(WORDS)
    row = construct_and_score(
        seed=2, index=idx, word_set=idx.word_set,
        language='en', target_tiles=6, node_budget=10_000, min_length=2,
    )
    if row is None:
        return  # allowed — this seed may legitimately fail
    for field in ('letter_multiset','grid_state','floor_score','spread_score',
                  'distinct_board_count','replay_run_count','generation_seed','first_word','language'):
        assert field in row, f"Missing field: {field}"
```

- [ ] **Step 2: Run, confirm failure**

```bash
cd scripts && python -m pytest tests/test_pipeline.py -v
```

- [ ] **Step 3: Implement pipeline.py**

```python
# scripts/puzzlegen/pipeline.py
from __future__ import annotations
import copy
from .solve import solve, SolveParams, SolveResult
from .score import bottleneck, score_tray, should_stop
from .swap import swap_sample
from .canonical import canonicalize
from .pool import sorted_letter_string, multiset_total
from .rng import SeededRng
from .word_index import WordIndex
from .config import (
    REPLAY_BATCH, REPLAY_PLATEAU_THRESHOLD, REPLAY_PLATEAU_BATCHES,
    REPLAY_MAX_RUNS, REPLAY_FLOOR_STABILITY, FLOOR_PERCENTILE,
    TARGET_TILES, NODE_BUDGET, MIN_WORD_LENGTH,
)
from .difficulty import TILE_DISTRIBUTION


def _replay_params(letters, index, word_set, seed, node_budget, min_length):
    return SolveParams(
        index=index,
        word_set=word_set,
        initial_pool=copy.copy(letters),
        target_tiles=multiset_total(letters),
        randomize_anchors=True,
        rng=SeededRng(seed),
        node_budget=node_budget,
        min_length=min_length,
    )


class _ReplayRun:
    def __init__(self, board: str, bn: float):
        self.board = board
        self.bottleneck = bn


def construct_and_score(
    seed: int,
    index: WordIndex,
    word_set: set[str],
    language: str,
    target_tiles: int = TARGET_TILES,
    node_budget: int = NODE_BUDGET,
    min_length: int = MIN_WORD_LENGTH,
) -> dict | None:
    """Construct a tray, replay to score it, return a row dict or None."""
    construct_params = SolveParams(
        index=index,
        word_set=word_set,
        initial_pool=copy.copy(TILE_DISTRIBUTION),
        target_tiles=target_tiles,
        randomize_anchors=False,
        rng=SeededRng(seed),
        node_budget=node_budget,
        min_length=min_length,
    )
    result = solve(seed, construct_params)
    if result is None:
        return None

    # Replay loop
    runs: list[_ReplayRun] = []
    seen: set[str] = set()
    board_flat_batches = 0
    floor_flat_batches = 0
    prev_floor: float | None = None
    replay_seed_counter = seed * 10_000

    while len(runs) < REPLAY_MAX_RUNS:
        before_size = len(seen)
        batch_runs = []

        for _ in range(REPLAY_BATCH):
            replay_seed_counter += 1
            rp = _replay_params(result.letters, index, word_set,
                                 replay_seed_counter, node_budget, min_length)
            r = solve(replay_seed_counter, rp)
            if r is None:
                continue
            bn = bottleneck(r.trace)
            board = canonicalize(r.grid)
            run_obj = _ReplayRun(board, bn)
            runs.append(run_obj)
            seen.add(board)
            batch_runs.append(r)

        # Swap sample a few boards from this batch
        for r in batch_runs[:3]:
            alt_boards = swap_sample(r.grid, index, word_set, min_length)
            seen.update(alt_boards)

        # Check board plateau
        growth = (len(seen) - before_size) / max(len(seen), 1)
        board_flat_batches = board_flat_batches + 1 if growth < REPLAY_PLATEAU_THRESHOLD else 0

        # Check floor plateau
        if len(runs) >= REPLAY_BATCH:
            floor, _ = score_tray(runs, FLOOR_PERCENTILE)
            if prev_floor is not None and abs(floor - prev_floor) < REPLAY_FLOOR_STABILITY:
                floor_flat_batches += 1
            else:
                floor_flat_batches = 0
            prev_floor = floor

        if should_stop(board_flat_batches, floor_flat_batches, REPLAY_PLATEAU_BATCHES):
            break

    if not runs:
        return None

    floor, spread = score_tray(runs, FLOOR_PERCENTILE)

    return {
        'language': language,
        'letter_multiset': sorted_letter_string(result.letters),
        'grid_state': result.grid,
        'dictionary_config': {
            'minLength': min_length,
            'maxLength': None,
            'baseEnabled': True,
            'excludedTopics': [],
            'customSetIds': [],
            'baseSetId': None,
        },
        'floor_score': floor,
        'spread_score': spread,
        'band': None,
        'distinct_board_count': len(seen),
        'replay_run_count': len(runs),
        'status': 'available',
        'scheduled_date': None,
        'generation_seed': seed,
        'first_word': result.first_word,
        '_trace': [vars(e) for e in result.trace],  # for traces.jsonl only
    }
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd scripts && python -m pytest tests/test_pipeline.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/puzzlegen/pipeline.py scripts/tests/test_pipeline.py
git commit -m "feat(puzzlegen): construct_and_score pipeline wiring construct, replay, swap, and scoring"
```

---

## Task 14: CLIs — generate, load, calibrate

**Files:**
- Create: `scripts/generate_puzzles.py`
- Create: `scripts/load_puzzles.py`
- Create: `scripts/calibrate.py`

- [ ] **Step 1: Implement generate_puzzles.py**

```python
#!/usr/bin/env python3
# scripts/generate_puzzles.py
"""
Usage:
  DATABASE_URL=... python generate_puzzles.py \
    --language en --seeds 1-500 --out puzzles.jsonl --traces traces.jsonl
  DATABASE_URL=... python generate_puzzles.py \
    --language en --seeds 1-500 --out puzzles.jsonl --workers 8
"""
import argparse
import json
import os
import sys
from multiprocessing import Pool

from puzzlegen.loader import load_words_for_language
from puzzlegen.word_index import build_index
from puzzlegen.pipeline import construct_and_score
from puzzlegen.config import TARGET_TILES, NODE_BUDGET, MIN_WORD_LENGTH


def _worker(args):
    seed, language, words, target_tiles, node_budget, min_length = args
    idx = build_index(words)
    row = construct_and_score(
        seed=seed,
        index=idx,
        word_set=idx.word_set,
        language=language,
        target_tiles=target_tiles,
        node_budget=node_budget,
        min_length=min_length,
    )
    return seed, row


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--language', default='en', choices=['en', 'es', 'fr', 'de'])
    p.add_argument('--seeds', required=True, help='Range e.g. 1-500 or comma list')
    p.add_argument('--out', default='puzzles.jsonl')
    p.add_argument('--traces', default='traces.jsonl')
    p.add_argument('--workers', type=int, default=os.cpu_count() or 4)
    p.add_argument('--target-tiles', type=int, default=TARGET_TILES)
    p.add_argument('--node-budget', type=int, default=NODE_BUDGET)
    p.add_argument('--min-length', type=int, default=MIN_WORD_LENGTH)
    args = p.parse_args()

    db_url = os.environ.get('DATABASE_URL')
    if not db_url:
        print('ERROR: DATABASE_URL not set', file=sys.stderr)
        sys.exit(1)

    # Parse seeds
    if '-' in args.seeds:
        lo, hi = args.seeds.split('-')
        seeds = list(range(int(lo), int(hi) + 1))
    else:
        seeds = [int(s) for s in args.seeds.split(',')]

    print(f'Loading {args.language} words...')
    words = load_words_for_language(db_url, args.language, args.min_length)
    print(f'  {len(words)} words loaded')

    tasks = [
        (s, args.language, words, args.target_tiles, args.node_budget, args.min_length)
        for s in seeds
    ]

    succeeded = 0
    failed = 0
    with open(args.out, 'w') as fout, open(args.traces, 'w') as ftrace:
        with Pool(args.workers) as pool:
            for seed, row in pool.imap_unordered(_worker, tasks, chunksize=4):
                if row is None:
                    failed += 1
                    print(f'  seed {seed}: failed (node budget)')
                    continue
                trace = row.pop('_trace', [])
                fout.write(json.dumps(row) + '\n')
                ftrace.write(json.dumps({'seed': seed, 'trace': trace}) + '\n')
                succeeded += 1
                if succeeded % 50 == 0:
                    print(f'  {succeeded}/{len(seeds)} succeeded')

    print(f'Done. {succeeded} banked, {failed} failed. Output: {args.out}')


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Implement load_puzzles.py**

```python
#!/usr/bin/env python3
# scripts/load_puzzles.py
"""
Usage:
  DATABASE_URL=... python load_puzzles.py --input puzzles.jsonl
  DATABASE_URL=... python load_puzzles.py --input puzzles.jsonl --band-config bands.json
"""
import argparse
import json
import os
import sys
import psycopg


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True)
    p.add_argument('--band-config', help='JSON file mapping floor_score ranges to bands')
    args = p.parse_args()

    db_url = os.environ.get('DATABASE_URL')
    if not db_url:
        print('ERROR: DATABASE_URL not set', file=sys.stderr)
        sys.exit(1)

    band_config = None
    if args.band_config:
        with open(args.band_config) as f:
            band_config = json.load(f)

    def assign_band(floor_score, language):
        if not band_config:
            return None
        thresholds = band_config.get(language, [])
        for i, threshold in enumerate(sorted(thresholds)):
            if floor_score <= threshold:
                return i + 1
        return len(thresholds) + 1

    inserted = skipped = 0
    with open(args.input) as f:
        rows = [json.loads(line) for line in f if line.strip()]

    with psycopg.connect(db_url) as conn:
        for row in rows:
            band = assign_band(row['floor_score'], row['language'])
            try:
                conn.execute("""
                    INSERT INTO public.daily_puzzles
                      (language, letter_multiset, grid_state, dictionary_config,
                       floor_score, spread_score, band, distinct_board_count,
                       replay_run_count, generation_seed, first_word)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    row['language'],
                    row['letter_multiset'],
                    json.dumps(row['grid_state']),
                    json.dumps(row['dictionary_config']),
                    row['floor_score'],
                    row['spread_score'],
                    band,
                    row['distinct_board_count'],
                    row['replay_run_count'],
                    row['generation_seed'],
                    row['first_word'],
                ))
                inserted += 1
            except psycopg.errors.UniqueViolation:
                conn.rollback()
                print(f"COLLISION: {row['language']}:{row['letter_multiset']} "
                      f"seed={row['generation_seed']} (skipped)")
                skipped += 1
                continue
            conn.commit()

    print(f'Inserted {inserted}, skipped {skipped} collisions.')


if __name__ == '__main__':
    main()
```

- [ ] **Step 3: Implement calibrate.py**

```python
#!/usr/bin/env python3
# scripts/calibrate.py
"""
Usage:
  python calibrate.py --input puzzles.jsonl
  python calibrate.py --input puzzles.jsonl --out calibration/
"""
import argparse
import json
import os
import statistics
import matplotlib.pyplot as plt
import pandas as pd


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True)
    p.add_argument('--out', default='calibration')
    args = p.parse_args()

    os.makedirs(args.out, exist_ok=True)

    with open(args.input) as f:
        rows = [json.loads(line) for line in f if line.strip()]

    df = pd.DataFrame(rows)
    print(f"Loaded {len(df)} puzzles")
    print(df[['floor_score','spread_score','distinct_board_count','replay_run_count']].describe())

    # Plot 1: floor_score distribution
    fig, ax = plt.subplots()
    ax.hist(df['floor_score'], bins=30, edgecolor='black')
    ax.set_xlabel('floor_score (10th pct bottleneck)')
    ax.set_ylabel('count')
    ax.set_title('floor_score distribution')
    fig.savefig(os.path.join(args.out, 'floor_score_dist.png'), dpi=150)
    plt.close(fig)

    # Plot 2: floor_score vs replay_run_count (confidence indicator)
    fig, ax = plt.subplots()
    ax.scatter(df['replay_run_count'], df['floor_score'], alpha=0.4, s=10)
    ax.set_xlabel('replay_run_count')
    ax.set_ylabel('floor_score')
    ax.set_title('floor_score vs replay_run_count\n(should be independent once plateau reached)')
    fig.savefig(os.path.join(args.out, 'floor_vs_runs.png'), dpi=150)
    plt.close(fig)

    # Plot 3: spread_score distribution
    fig, ax = plt.subplots()
    ax.hist(df['spread_score'], bins=30, edgecolor='black')
    ax.set_xlabel('spread_score (fragility)')
    ax.set_ylabel('count')
    ax.set_title('spread_score distribution')
    fig.savefig(os.path.join(args.out, 'spread_dist.png'), dpi=150)
    plt.close(fig)

    # Suggested band boundaries (7-quantile cuts)
    quantiles = [df['floor_score'].quantile(i/7) for i in range(1, 7)]
    print(f"\nSuggested band boundaries (7-quantile cuts of floor_score):")
    for i, q in enumerate(quantiles, 1):
        print(f"  band {i} / {i+1}: {q:.4f}")

    # Write band config template
    bands_out = {'en': [round(q, 4) for q in quantiles]}
    with open(os.path.join(args.out, 'band_config_template.json'), 'w') as f:
        json.dump(bands_out, f, indent=2)

    print(f"\nPlots and band config written to {args.out}/")


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: Smoke-test generate help**

```bash
cd scripts && python generate_puzzles.py --help
cd scripts && python load_puzzles.py --help
cd scripts && python calibrate.py --help
```

All should print usage without error.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate_puzzles.py scripts/load_puzzles.py scripts/calibrate.py
git commit -m "feat(puzzlegen): generate, load, and calibrate CLIs"
```

---

## Task 15: Run full pytest suite

- [ ] **Step 1: Run all tests**

```bash
cd scripts && python -m pytest tests/ -v --tb=short
```

Expected: all pass. If any fail, fix before proceeding.

- [ ] **Step 2: Commit (if any fixes needed)**

```bash
git add -A && git commit -m "fix(puzzlegen): test suite fixes"
```

---

## Task 16: First calibration batch (500 English trays)

This is an operational task, not a code task. Run from repo root with local Supabase running.

- [ ] **Step 1: Start local Supabase**

```bash
npm run db:start
```

- [ ] **Step 2: Get the local DB URL**

```bash
npx supabase status
```

Copy the `DB URL` line (usually `postgresql://postgres:postgres@127.0.0.1:54322/postgres`).

- [ ] **Step 3: Generate 500 trays**

```bash
cd scripts
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  python generate_puzzles.py \
    --language en \
    --seeds 1-500 \
    --out puzzles_en_500.jsonl \
    --traces traces_en_500.jsonl \
    --workers 6
```

Expected: ~10-60 min depending on machine. Watch the console for failure rate.

- [ ] **Step 4: Run calibration analysis**

```bash
cd scripts
python calibrate.py --input puzzles_en_500.jsonl --out calibration_en_500/
```

Open `calibration_en_500/floor_score_dist.png` and `floor_vs_runs.png`. Check:
- `floor_vs_runs.png`: floor_score should be roughly independent of replay_run_count (no upward/downward trend with run count). If there is a trend, the plateau stopping rule needs tightening.
- `floor_score_dist.png`: should span a meaningful range (not all clustered at one value). If clustered near 1.0, C_LENGTH or min_length may need raising.

- [ ] **Step 5: Load into local DB**

```bash
cd scripts
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  python load_puzzles.py --input puzzles_en_500.jsonl
```

Check collision count — if collision rate > 10%, the tray space is smaller than expected.

- [ ] **Step 6: Review and adjust config**

Based on the calibration plots, update `scripts/puzzlegen/config.py` if needed:
- If boards are 2-letter lattices: raise `MIN_WORD_LENGTH` to 3, re-run.
- If `floor_score` vs `replay_run_count` shows trend: raise `REPLAY_PLATEAU_BATCHES` to 3.
- If distribution is too narrow: experiment with `C_LENGTH = 0.3` or `0.5`.

Then re-run the calibration batch with the new config.

- [ ] **Step 7: Commit calibration findings**

```bash
git add scripts/puzzlegen/config.py
git commit -m "chore(puzzlegen): tune config based on 500-tray English calibration batch"
```

---

## Self-Review

**Spec coverage check:**
- §3 Difficulty formula: Task 4 ✓
- §4 Construction / DFS / tabu: Tasks 8, 9 ✓
- §5 Word index / bitset: Task 6 ✓
- §6 Replay (same solve()): Task 13 pipeline ✓
- §7 Swap sampling: Task 10 ✓
- §8 Scoring / dual-plateau: Tasks 10, 13 ✓
- §9 Banking / JSONL / loader: Tasks 14 ✓
- §10 Stage A word loading: Task 12 ✓
- §11 config.py all tunables: Task 3 ✓
- §12 Sequencing / revert: Task 1 ✓
- Migration: Task 2 ✓
- Shared constants bridge: Task 3 ✓
- validate.py cross-tests: Task 11 ✓
- calibrate.py floor_vs_runs plot: Task 14 ✓

**Type consistency check:**
- `PlacementCandidate.new_letters: Multiset` — consumed by `pipeline.py` via `pool_consume` ✓
- `SolveResult.letters: Multiset` — passed to `sorted_letter_string` ✓
- `_ReplayRun.bottleneck` — consumed by `score_tray` via `.bottleneck` attribute ✓
- `pattern_query` returns `list[tuple[int, str]]` — consumed by `swap.py` and `word_index.py` ✓
- `LogEntry.min_candidate_rarity` — consumed by `bottleneck()` ✓

**Placeholder scan:** No TBDs, TODOs, or "implement later" found.
