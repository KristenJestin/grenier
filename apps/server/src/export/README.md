# The nightly Markdown export

Nothing depends on Grenier alone: every night, the server writes everything it holds as plain
Markdown into a git repository, commits what changed, and pushes it. A backup anyone can read
without the application, and a history of what changed day by day.

```
bun run grenier export:markdown <folder> [--include-sensitive] [--remote <url>] [--deploy-key <file>]
```

## When it runs

Inside the server, when `EXPORT_DIR` names the folder of the repository: on the cron expression of
`EXPORT_SCHEDULE` (every night at three by default, in the time zone of `TZ`), then pushed to
`EXPORT_REMOTE` with the private key of the file `EXPORT_DEPLOY_KEY_FILE`, when they are set. A
job inside the server rather than a timer on the host: the server runs in a container, where the
host has nothing to call but `docker compose exec`, and it is the server that writes the logs and
records findings. The image carries git and ssh for it; the folder is the `export` volume at
`/data/export`. The remote's host key is accepted the first time it is seen.

The command line does the same once, as the owner, for a try or a private copy.

## What it writes

```
_types/recipe.md                  each type: its definition in the front matter, its description
kitchen.md                        an entry at the root
kitchen/plum-tart.md              an entry filed under `kitchen`, beside its parent's file
kitchen/plum-tart/shortcrust.md   and one below it
```

- One file per entry, `<slug>.md`, in the folder of its parent: `<parent slug>/`, beside the
  parent's own `<parent slug>.md`. An entry's file never moves when it gets children; it moves
  only when the entry is filed elsewhere or its slug changes.
- The front matter holds the base fields (`id`, `type`, `title`, `slug`, `aliases`, `tags`,
  `summary`, `created`, `updated`, `valid_from`, `valid_until`, `superseded_by` as a slug,
  `verified`, `archived_at`, `sources`), the values of the type's `fields` and their
  `provenance` as they are stored, the outgoing `links` (relation and target slug, with the period
  and the field of a link `fulfills`), and the `media` (hash, file under the media folder, kind,
  type, size, description). Media files are not copied.
- Then the body, as it is stored, `[[slug]]` references left as they are.
- Archived entries are exported where they are filed, with their `archived_at`.
- The same content gives the same bytes: keys in a fixed order, fields and provenance by name,
  links by relation and target, media in their order.

## Sensitive data

Left out by default: a sensitive field is written `[hidden]`, an entry of a sensitive type is not
written, and an entry whose parent is left out stands at the root. `--include-sensitive` writes
everything, for an export the owner keeps private and encrypted. The repository of the nightly
export must be private all the same.

## The git side

The folder is the export's: a file it did not write is removed. A folder that holds files but is
not a git repository is refused. A commit is made only when something changed, by `Grenier
<grenier@localhost>`, with a summary: `Export of 2026-10-07: 3 created, 2 updated, 1 archived`
(then, when there are some, the entries no longer exported and the types changed). The push never
forces; when it fails, the commit stays and the next export pushes it with its own, and the
failure is written to the server's output and, when diagnostics are on, recorded as a finding.
