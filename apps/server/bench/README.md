# The bench of Hippocampe's MCP tools

Measures what an agent does with Hippocampe's tools, on tasks it is asked in plain words, against a
Hippocampe of its own filled with invented data. It exists to answer one question with numbers: does a
change to the tools, their descriptions or the instructions make an agent succeed more often, with
fewer calls and fewer tokens? Issue #169 uses it before and after each part; #146 runs the same
tasks with small models.

It is not part of `bun run test`: it calls a model and costs money. Its code (the reading of a
transcript, the checks, the table) is tested by `tests/bench/`.

## Run it

You need the local PostgreSQL (`docker compose up -d postgres`, port 55432), Bun, and Claude Code
(`claude`) installed and signed in. From `apps/server`:

```
bun run bench                                   # all tasks, once, with the sonnet model
bun run bench --tasks recall-graphics-card      # some tasks (`--list` shows the ids)
bun run bench --model haiku --repeat 3          # another model, three runs per task
bun run bench --held-out exclude                # only the tasks that may be used to tune
nice -n 19 bun run bench --out /tmp/baseline.md # at low priority, table in a file of your choice
```

Options: `--tasks <ids>`, `--held-out include|exclude|only`, `--model <name>` (default `sonnet`),
`--repeat <n>`, `--out <file>` (default under `/tmp/hippocampe-bench/`), `--database-url <url>` (a
PostgreSQL server to create the bench databases on; default `DATABASE_URL`, else the local one of
`docker-compose.yml`), `--max-cost <usd>` (the most one run may cost, default 2) and
`--timeout <seconds>` (default 600).

The table is written after each run, so a run cut short keeps what it measured. Beside it:
`<name>.json`, every run with its calls (inputs, and answers cut at 2,000 characters), and
`<name>.transcripts/`, the raw stream of every session, to read what the agent really did.

## What it does

1. Creates a database of its own on the PostgreSQL server (`hippocampe_bench_template_…`), migrates
   it and fills it through the core, as the tools do: the types, about a hundred entries (a home
   server and its parts, the shops they came from, the projects they serve, people and
   organizations, recipes, contracts, bookmarks, notes), the links with their notes and dates, the
   rules of the instance, an owner and the key the agent uses (`bench-agent`, `read` and `write`).
   See `fixture.ts`. Every date a task cares about is relative to the day of the run.
2. For each task and each repeat: copies that database (`CREATE DATABASE … TEMPLATE`), runs the
   task's setup on the copy (some put items in the inbox), starts the real Hippocampe server on a free
   port against the copy (`HIPPOCAMPE_INSTANCE=local`, diagnostics off), and runs the agent.
3. The agent is Claude Code, headless (`claude -p --output-format stream-json --verbose`), with
   the bench's Hippocampe as its only source of tools: `--strict-mcp-config` with a generated
   configuration, no built-in tool (`--tools ""`), no settings file (`--setting-sources ""`), no
   skill, and an empty folder as its working directory, so no CLAUDE.md, project setting or MCP
   server of the machine reaches it. The `init` event of the session is read back: a run whose
   session had a tool beyond Hippocampe's, or did not connect to it, is marked invalid and counts as
   failed. The prompts never name a tool.
4. After the run, the task's check reads the database through the core (never what the agent said
   it did) and the final answer, and gives the reasons it fails, or none.
5. Drops the copy, then, at the end, the template. An interruption cleans up too.

Only `runner.ts` knows Claude Code: an `AgentRunner` takes a request (prompt, MCP address, key,
model) and returns a transcript. Another client is another implementation of it.

## Reading the table

One row per task, then totals for all tasks, for the tuning tasks and for the held-out ones.

| Column | Meaning |
|---|---|
| Passed | Runs whose check found nothing wrong, over runs made |
| Calls | Calls of Hippocampe tools (a mean per run when repeated) |
| Wrong tool | Calls to a tool of a role the task does not need (below) |
| Refused | Calls the server answered with an error |
| Recovered | Refused calls followed later by a successful call of the same tool |
| Input tokens | Everything the model read, cached tokens included, over the whole session |
| Output tokens | Everything it wrote |
| Seconds | Wall time of the run, agent only |
| Cost (USD) | The cost Claude Code reports for the session |

Below the tables: the reason of every failed run, and every wrong tool.

- **Wrong tool.** A task says which *roles* it needs (`write`, `link`, `agenda`…), never a tool.
  `roles.ts` is the one table that maps a role to the tools that do it today; a tool may serve
  several roles (`write` writes and archives), and is wrong only when none of its roles is needed.
  Looking before acting (`search`, `read`, the types, the rules) is never wrong. Any other tool is,
  and so is a tool the table does not know. When the tools are merged or renamed, change that table
  and the same tasks measure the new surface; a test fails while the table and the server disagree.
  Tables measured before and after a merge are not strictly comparable on this column.
- **Costs vary** with the state of the prompt cache: the first session of a series pays to write
  it, the next ones read it. Compare runs made the same way, and use `--repeat` to see the spread.
  A model's answers vary too: one run of a task is an observation, not a result.
- **Held-out tasks** (marked in the table) are not used to tune descriptions or instructions. They
  tell whether a gain on the others holds. Run with `--held-out exclude` while tuning, and
  include them to report.

## The tasks

`tasks.ts`, about thirty-five, from the examples of the issue: recall (the graphics card, its server,
its shop and the projects the server serves), what is due this week, the overdue, filing three inbox
items one of which updates an entry, linking a person to an organization with a role and dates,
adding a field to a type, a type made from scratch, making a field required, archiving, replacing a
decision, a question whose answer is not in Hippocampe. Each has a deterministic check, and a
reference solution in `tests/bench/solutions.ts`: a test proves that every check fails on the
instance as it starts and passes once the solution is applied, so none asks for nothing or for
the impossible.

Three tasks measure memory (#171). None of their rules or prompts carries a hand-over convention:
`resume-discussion` ("Resume where we were."), `vague-music-thing` (a vague reference with three
subjects that fit, last changed 2 days, 3 weeks and 5 months ago: the right answer names them and
asks, and writes nothing) and `link-two-by-title` (a note that mentions two existing entries by
their title, in passing, must end up linked to both, and filed under neither). The first needs an earlier
session: rather than running a first agent (slow, costly, and varying), the setup writes what that
session would have written, through the core, as the same key (`bench-agent`), a few minutes before
the run; the second session then starts with nothing but the instance.

A check asks for the facts an answer must give, and for an order when one is asked. It forbids
a name only where the answer is a plain list (the recipes with lemon, the entries that are only supposed): a
good answer to "what is due this week" may well say what comes just after.

To add a task: a `Task` in `tasks.ts` (in the owner's words, with its roles and its check), its
reference solution in `tests/bench/solutions.ts`, and `bun run test`.
