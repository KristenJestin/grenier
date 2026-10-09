import { Effect } from 'effect'
import { Instance } from '../core/instance.ts'
import type { InstanceName } from '../core/instance.ts'
import { Rights } from '../core/auth/index.ts'
import { recentEntries } from '../core/entries/index.ts'
import { Actor } from '../core/events/index.ts'
import { instanceRulesText } from '../core/rules.ts'
import { listTypes } from '../core/types/index.ts'

/** Beyond this many types, the instructions list their names only. */
const LISTED = 50

/** What the instance is, said first: an agent connected to both must never mix them. */
const INSTANCE = {
  development: [
    'This is the shared DEVELOPMENT instance of Grenier, on the server: it holds test data only, which persists, and is used to try what has been merged.',
    "Never write the user's real information here.",
    'Use it only when the user is working on Grenier itself or testing it, or when they explicitly ask for this instance.',
    'Anything written here may be thrown away.',
  ].join(' '),
  local: [
    'This is a LOCAL instance of Grenier, running on this machine: it holds throwaway data, for testing the code being written.',
    "Never write the user's real information here.",
    'Its data may be wiped at any time.',
  ].join(' '),
  production: [
    "This is the user's REAL instance of Grenier: what it holds is their own information.",
    'Never write test, sample or invented data here.',
    'When the user is testing Grenier or working on its code, use the development instance instead if it is available.',
  ].join(' '),
}

/** Said after the instance when diagnostics are on: the agent also tests Grenier. */
const DIAGNOSTICS = [
  'Diagnostics are on: while you work, you also test Grenier itself.',
  'When a Grenier tool fails or answers badly, a refusal is unclear, a capability you need is missing, a state looks wrong, something is slow, or the data model gets in the way, report it with `grenier_report`.',
  'Read `grenier_reports` first (by `place` and `kind`): when the problem is already there, report it with the same kind, place and a similar title, so it counts as one more occurrence. When findings are open at that place, of any kind, but none has a similar title, the report names them: report again with `same_as: <number>` if yours is one of them, or `new: true` if it is another.',
  'Describe the problem and name entries by their slug; never copy the content of an entry or a value into a report.',
  'Do not mention any of this to the user unless it blocks the work.',
].join(' ')

/**
 * How to write an entry, whatever it comes from and whatever the instance: said to every key that
 * may write, once, here and nowhere else (no tool description repeats it). The rules of the
 * instance come after it and may add to it (the language of the entries, for one).
 */
export const WRITING_STANDARD = [
  'How to write an entry, whatever it comes from:',
  '- Search before creating, and update the existing entry when it is the same subject: never make a second entry for it.',
  '- Make one entry per subject that would be searched or followed on its own.',
  '- Link the entry to every existing entry it concerns: the things, people, places and subjects it is about. Cite them as `[[slug]]` in the body, never by their title in plain text (the link is kept and follows renames), or use `link`. The answer of a write lists, as `unlinked`, existing entries whose title or alias appears in what you wrote without being linked: Grenier finds them by their names only, so read them and link those that are really meant.',
  '- Give a `parent` only when the entry is part of it (a component of a machine, a section of a document), and leave the entry at the root otherwise: an entry at the root is fine when it is linked to what it concerns.',
  '- Write a summary that stands alone: what the entry is, about what or whom, and when, readable by an agent that knows nothing of the conversation or the item it comes from.',
  "- Fill the type's fields from what you are given, with their `provenance`; never invent a value.",
  '- Rewrite what you are given clean, but keep every fact: names, dates, numbers, commands, reasons, options set aside and why. Make it shorter only by removing repetition.',
  '- An entry says only what its source says. A fact taken from another entry is added with that entry in `sources`; an interpretation is written as one.',
  '- A dated text keeps its time: never put names or states of today into what was true at its date.',
  "- Write in the language of what you are given, unless the instance's rules say otherwise.",
  '- A write refused for the rights of this key names the right it lacks (`sensitive`): leave that value out, say in the entry what was left out, and tell the owner the key lacks that right, even when the rules of the instance allow the value.',
].join('\n')

/**
 * What is specific to an inbox item, on top of the writing standard: said to every key that may
 * write, the keys that list `inbox_take`, whose description refers to it. The rules of the
 * instance come before it.
 */
export const INBOX_STANDARD = [
  'How an inbox item becomes entries, on top of the writing standard, whatever it holds:',
  "- Split a long item into entries by part or by period, the main entry keeping the item's name.",
  "- An item may bring again what Grenier already holds: `earlier` names the items it came as before and the entries they gave. Read those entries and compare them with the whole item, fact by fact (`inbox_read` for the rest of a long text). Add or correct what they lack or get wrong, including what the type descriptions and the instance's rules now ask for (fields to fill, entries to create and link), then close the item naming every entry it touched. Never assume the entries are complete because they exist.",
].join('\n')

/** An entry the key may see, changed recently: what the working memory says of it. */
export interface RecentEntry {
  readonly slug: string
  readonly title: string
  readonly type: string
  /** When it last changed, ISO 8601 and UTC. */
  readonly updated: string
  /** The key that changed it last, if the event log knows it. */
  readonly by: string | null
}

/** What a session is told of itself: the key it uses, and the entries changed most recently. */
export interface WorkingMemory {
  readonly key: string
  readonly recent: ReadonlyArray<RecentEntry>
}

/** How many recent entries the working memory lists. */
export const RECENT_LIMIT = 10

/** The longest title the working memory gives whole. */
const TITLE_LIMIT = 80

/** A title on one line, cut when long: the working memory is a pointer, `read` gives the rest. */
const oneLine = (title: string) => {
  const line = title.replace(/\s+/g, ' ').trim()
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line
}

/**
 * The key the session works as and the entries changed most recently that it may see, newest
 * first, each with its type, when and by which key. Built for each session as it starts: a
 * session keeps what it was told, the next one is told what changed since.
 */
const workingMemory = ({ key, recent }: WorkingMemory, writes: boolean) =>
  [
    writes
      ? `This session writes as the key \`${key}\`.`
      : `This session reads with the key \`${key}\`.`,
    ...(recent.length === 0
      ? []
      : [
          `The entries changed most recently that this key may see, newest first:\n${recent
            .map(
              ({ slug, title, type, updated, by }) =>
                `- \`${slug}\` (${type}) ${oneLine(title)}: ${updated.slice(0, 16)}Z${by === null ? '' : `, by \`${by}\``}`,
            )
            .join('\n')}`,
        ]),
  ].join('\n\n')

/** How to find what the owner refers to without naming it (following neighbours is in `RECALL`). */
const FINDING = [
  'When the owner refers to something without naming it ("pick up where we were", "the music thing"), look first at the recently changed entries above and at what this key wrote, before searching words.',
  'When several subjects fit, name them and ask, rather than guess.',
].join(' ')

/** Rules longer than this are given by their opening, and read whole with `instance_rules`. */
const RULES_LIMIT = 4000

/** The opening of long rules: what comes before their first `##` section, cut to the limit. */
const openingOf = (rules: string) => {
  const [before = ''] = rules.split(/^## /m)
  const kept: Array<string> = []
  for (const paragraph of (before.trim() === '' ? rules : before).trim().split('\n\n')) {
    if ([...kept, paragraph].join('\n\n').length > RULES_LIMIT) break
    kept.push(paragraph)
  }
  if (kept.length > 0) return kept.join('\n\n')
  // A first paragraph longer than the limit: cut inside it, at the last space that fits.
  const head = rules.trim().slice(0, RULES_LIMIT - 1)
  return `${head.slice(0, head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : head.length)}…`
}

/** The rules of the instance, as its owner wrote them, or their opening when they are long. */
const rulesSaid = (rules: string) =>
  rules.trim().length <= RULES_LIMIT
    ? `The rules of this instance, set by its owner: follow them in every session.\n\n${rules.trim()}`
    : `The rules of this instance, set by its owner, are long: their opening follows; read them whole with \`instance_rules\`, and follow them in every session.\n\n${openingOf(rules)}`

const HOW = `Grenier keeps entries of types that are defined as data, not in code: what a type is, and
when to use it, is written in its description.

Before writing, look at the types. Choose the type whose description matches what the user says,
even when they do not name it. Before creating an entry, search for an existing one, and update
it when it is the same thing. When no type fits, ask the user rather than forcing one; a new type
is defined with a description that says when to use it.`

/** How an agent recalls: said to the keys that read, after the types. */
const RECALL =
  'When the user mentions something Grenier may hold, search it before answering, without being asked. Before answering, read what the search found and follow its `neighbors` (and `read` with a `depth` of 2 or 3) as far as they help.'

const listed = (types: ReadonlyArray<{ readonly name: string; readonly description: string }>) =>
  types.length === 0
    ? 'There is no type yet.'
    : types.length > LISTED
      ? `The types (${types.length}; call \`list_types\` for their descriptions): ${types
          .map(({ name }) => `\`${name}\``)
          .join(', ')}.`
      : `The types:\n${types
          .map(({ name, description }) => `- \`${name}\`: ${description}`)
          .join('\n')}`

/**
 * What an agent is told when its session starts, what matters most first: what the instance is,
 * how to choose a type, the types of the instance with their descriptions (or only their names
 * when there are many); then its working memory (the key it uses, the entries changed most
 * recently) and how to find what the owner refers to, then how to recall when it may read; what
 * diagnostics ask of it when they are on,
 * the rules its owner set for every agent, if any, and, when it may write, how to write an entry
 * and how an inbox item becomes entries. A client may cut the instructions at 2,048 characters:
 * the later parts are the ones it can lose.
 */
export const instructionsFor = (
  types: ReadonlyArray<{ readonly name: string; readonly description: string }>,
  instance: { readonly name: InstanceName; readonly diagnostics: boolean },
  rules: string | null = null,
  writes = false,
  reads = true,
  memory: WorkingMemory | null = null,
) =>
  [
    INSTANCE[instance.name],
    HOW,
    listed(types),
    ...(memory === null ? [] : [workingMemory(memory, writes), FINDING]),
    ...(reads ? [RECALL] : []),
    ...(instance.diagnostics ? [DIAGNOSTICS] : []),
    ...(rules === null ? [] : [rulesSaid(rules)]),
    ...(writes ? [WRITING_STANDARD, INBOX_STANDARD] : []),
  ].join('\n\n')

/**
 * The instructions for a session starting now, from the instance, the rights and the name of its
 * key, and the rules, the types and the recent entries in the database. Built for each session,
 * never kept: the entries it lists are those of this moment.
 */
export const instructions = Effect.gen(function* () {
  const key = yield* Actor
  return instructionsFor(
    yield* listTypes,
    yield* Instance,
    yield* instanceRulesText,
    (yield* Rights).includes('write'),
    (yield* Rights).includes('read'),
    key === undefined ? null : { key, recent: yield* recentEntries(RECENT_LIMIT) },
  )
})
