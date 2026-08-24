# A library the Rust implementation wrote

`index.db` and `library.json` were produced by `../roost-old` — `roost init`,
then `roost rebuild` over the journal committed at
`../../journal/__fixtures__/rust-written-journal/2026-08.jsonl`, whose 27 lines
cover all 22 operations.

It is here so that "a library written by `roost-old` opens in this build" is a
test rather than a claim (`CONCEPT.md` §7). What it pins is narrower and harder
to keep by accident than the journal fixture next door:

- `meta.schema_version` reads **5**, so opening it must run **no migration**. A
  consolidated baseline in this repository would either re-run against it or
  disagree with it about what version it is, which is why `DATA_MODEL.md`'s port
  note forbids one.
- Every table, column, and index this build's SQL names exists in a file it did
  not create. A renamed column here fails at the first query rather than in a
  user's library.

There is no `originals/` and no `journal/`: this fixture is the index, and the
bytes and the journal are pinned by their own fixtures.

The Rust build's own reading of this same state, for comparison — captured from
`roost stats` and `roost show` on 2026-08-24:

```
assets      3        rated       0
  managed     2      favourites  1
  referenced  1      notes       1
total size  28 B     thumbnails  0
tags        2
folders     1

alpha at dusk.png    rating —, favourite yes, note "client approved", tags timber
```

**Do not open this file in place from a test.** Copy it to a temporary
directory first: opening sets `journal_mode = WAL`, which writes to it.
