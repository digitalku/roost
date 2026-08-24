# A fragment of a library written by the Rust implementation

The `originals/` tree here was produced by `../roost-old` — the Rust and Tauri
implementation — importing five files in **managed** mode:

| Source file | Contents | Became |
| --- | --- | --- |
| `a.JPG` | `one` | `d3/d33f….jpg` — extension lowercased |
| `b.tar.gz` | `two` | `dc/dc77….gz` — **last** component only, not `tar.gz` |
| `noext` | `three` | `db/dbec….` — bare hash, no trailing dot |
| `d.Jpeg` | `four` | `37/3739….jpeg` |
| `e.PNG` | `five` | `e2/e2e7….png` |

The files are real and tiny, so the hashes are genuinely the hashes of their
contents. It is only a fragment: there is no `index.db`, no `journal/`, and no
`library.json`, because what it exists to pin down is the **object store's
layout** — sharding, filename construction, and how an extension round-trips.

`storage.test.ts` walks it with `iterAll` and re-derives every path with
`locate`. If the two ever disagree, this implementation has stopped writing
files where the other one reads them, and `CONCEPT.md` §7's promise that a
library opens in either implementation is broken.

**Do not regenerate this casually.** If it must be rebuilt:

```bash
roost init /tmp/layoutlib
ROOST_LIBRARY=/tmp/layoutlib roost import --mode managed <the five files>
cp -r /tmp/layoutlib/originals .
```
