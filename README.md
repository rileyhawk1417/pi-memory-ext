# pi memory extension

Hierarchical markdown memory for [pi](https://github.com/earendil-works/pi). Instead of one giant
memory file, memories live as small focused markdown files in scoped folders with **generated**
indexes, so the model drills down: index → subfolder index → specific file.

## Roots and layout

| Scope | Location | Use for |
|---|---|---|
| `global` | `~/.pi/agent/memory/` (override with `PI_MEMORY_DIR`) | cross-project user preferences, shared knowledge |
| `project` | `<cwd>/.pi/memory/` | facts specific to this repository (travels with the repo) |

Layout (both roots):

```
memory/
  INDEX.md                        # generated — subfolders + counts + root files
  preferences/deployment.md       # frontmatter: title, tags, scope, created, updated
  domains/typescript/INDEX.md     # generated — lists files in this folder
  domains/typescript/tooling.md
  .trash/                         # forgotten memories (recoverable)
```

## Tool: `memory`

One tool with actions:

- `save` — title, content (markdown), optional tags/category. Scope defaults to `global`;
  use `project` for repo-specific facts. The affected index is regenerated in the same write.
- `read` — read `INDEX.md` or a specific file by path (paths come from an index, never guessed).
- `search` — keyword search over filenames, titles, tags, and content (both roots by default).
- `list` — show the root indexes; drill down with `read` on a subfolder's `INDEX.md`.
- `forget` — move a memory to `.trash/` and regenerate the index (INDEX.md files cannot be forgotten).

Taxonomy is soft-gated: categories are kebab-case, max 2 levels (`domains/typescript`,
`projects/basket`). Creating a new category that is close to an existing one returns a hint so the
model merges instead of fragmenting.

## Command: `/memory`

- `/memory` — status report (counts, duplicate titles, stale entries).
- `/memory rebuild` — regenerate every index from file frontmatter (fixes any drift, incl. external edits).
- `/memory review` — report of likely duplicates and stale memories; when findings exist, the agent
  is sent a resolution prompt immediately (queued as a follow-up if it is mid-run).

## Injection

On every run, two things reach the system prompt when memory is non-empty:

1. **Titles digest** — one line per memory: `path — title (tags) [scope]`. Bodies stay on disk; the
   model is instructed to `memory read <path>` any line that looks relevant to the current task, so
   recall is proactive ("a build is about to start → the gradle line is visible"), not limited to
   moments where the user explicitly says "check memory".
2. **Static guidance** — index-first discipline, scoped saving, imperative titles, and two laws:
   never repurpose `AGENTS.md` / `.pi/SYSTEM.md` as memory, never edit generated `INDEX.md` files.

The path leads each line so it can be copied verbatim into `memory read`; the scope tag trails it
because it is not part of the path (`read` also tolerates a `global/...` or `[global] ...` prefix).
Entries are **interleaved between roots** and ordered newest-first within each root, then capped at
40 lines. Interleaving matters: appending roots in order let a large project root crowd the global
root out of the digest entirely, and the global root is where cross-project preferences live.
Overflow is reported per root (`...and 9 more (project: 9)`), and titles/tags are flattened and
clipped so an unusually long title cannot bloat every prompt.

## Search and save hygiene

- Search is **softened + stemmed**: one matched token is enough to hit; results are ranked by
  coverage and title/path weight. `s` / `ies` / `sses` / `ing` / `ed` are folded, but only where the
  stem stays a substring of the original word — so `files` -> `file` and `notes` -> `note`, never the
  `files` -> `fil` that made "profile" match. A match must also start a word, so `file` does not hit
  "profile" and `note` does not hit "nothing".
- `save` reports **near-duplicate titles** (stemmed Jaccard >= 0.6 or substring containment) so the
  model consolidates instead of accumulating clones.
- Tool schema asks for **imperative titles** ("Kill Java processes after builds"), since titles are
  the retrieval surface for both the digest and search ranking.
- No embeddings: with the digest visible, search is the fallback, not the primary recall path.

## Installation

Registered as a user extension via `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/absolute/path/to/this/repo/memory-ext"] }
```

Alternatives: symlink `~/.pi/agent/extensions/memory-ext` → `memory-ext`, or copy `memory-ext/`
into `~/.pi/agent/extensions/`. No npm install needed — pi resolves `typebox`,
`@earendil-works/pi-*` imports as virtual modules at runtime.

## Tests

`pnpm test` (alias of `pnpm run smoke`) runs `smoke.ts` with no dependencies. It covers index
generation, save/update/forget, digest shape and caps, search ranking and stemming, and read-path
normalisation — including regression guards for digest root fairness and the `files`/`profile`
false positive. All temp roots live under `/tmp` and are removed when the run ends, pass or fail.

## Design notes

- **Indexes are generated, never hand-edited.** `save`/`forget` regenerate the affected root's
  indexes immediately; `/memory rebuild` regenerates all. Drift can only come from external edits.
- **Frontmatter is the source of truth** for titles, tags, and timestamps; indexes are views on it.
- **Writes are serialized** through `withFileMutationQueue` to avoid clobbering concurrent edits.
- **Standalone testability:** `store.ts` is pure Node (no pi imports). Run the smoke tests with
  `pnpm run smoke`.

## Future ideas (not implemented)

- AI-assisted review round that proposes merge/delete plans and applies them on confirm.
- Cross-project pointer memories (`projects/<name>/` in the global root).
