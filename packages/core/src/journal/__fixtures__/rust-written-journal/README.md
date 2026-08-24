# A journal written by the Rust implementation

`2026-08.jsonl` came out of `../roost-old` — the Rust and Tauri
implementation — driven entirely through its CLI: four imports (three managed,
one referenced), then tagging, folders, ratings, a note, a favourite, renames,
tag groups, smart folders, and removals.

**It carries all 22 operations this build understands**, which is what makes it
worth committing. `journal.test.ts` uses it twice:

- **Replay** must apply every line, with nothing malformed, nothing torn, and
  no unknown operation. An `op` this build does not recognise appearing here
  would mean the two implementations no longer agree on the vocabulary.
- **Round-trip** re-serialises every parsed record with `toLine` and compares it
  byte for byte against the original line. That is the strongest form of the
  format promise: it proves this implementation both *reads* what the other one
  writes and *writes* what the other one reads, field order and omitted
  optionals included.

The file keeps its `YYYY-MM.jsonl` name and sits in a directory of its own,
because that is the only shape `monthsIn` will look at — a journal file named
anything else is invisible to replay, which is itself the correct behaviour and
was how this fixture first failed.

Regenerate only if the operation set genuinely changes, and then by driving the
other implementation's CLI rather than by hand — a hand-authored fixture proves
nothing about compatibility, since it would be this implementation's opinion of
the format written down twice.
