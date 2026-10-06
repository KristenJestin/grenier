# The importer of Markdown notes

Imports a folder of Markdown notes with YAML front matter into Grenier, as the actor
`importer`, and prints a Markdown report: every refused note with the core's sentences, every
skipped file, then the counts.

```
bun --env-file=.env apps/server/src/import/main.ts <notes-folder> --types <types.json> [--source <name>]
```

Paths are read from the folder the command is run in. `DATABASE_URL` comes from the
environment or `.env`; the database is brought to the latest version first.

- `types.json` is a list of type definitions (the format of `define_type`). Missing types are
  created and missing optional fields added, before any entry. A type `area` is created if the
  file does not define it.
- Each `.md` file is an entry: `type` from the front matter; the title from the first `# heading`,
  else the file name; the slug from the file name; `created`, `updated`, `tags`, `aliases`,
  `verified`, `summary`, `valid_from`, `valid_until` to the base fields (`created` and `updated`
  only when the entry is created); every other key to `fields`; the rest of the file is the body.
  Empty values are absent.
- Each folder is an `area` entry named after it, unless it holds a note with its name
  (`projects/atlas/atlas.md`): that note is the folder's entry and the parent of the others.
- A body with `[[slug]]` references is written once every entry exists, so the order of the files
  does not matter.
- Each file (and each folder, as `<path>/`) is recorded in the source registry under the source
  name (the folder's name by default) with a hash of its content: a second run skips what has not
  changed and updates what has, by the entry it gave the first time.
- Files that are not Markdown are listed as skipped; hidden files and folders (`.obsidian`,
  `.git`) are left out silently.
