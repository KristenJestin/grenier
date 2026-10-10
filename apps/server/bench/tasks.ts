import { Effect, Predicate } from 'effect'
import { writeEntries } from '../src/core/entries/index.ts'
import { Actor } from '../src/core/events/index.ts'
import { addDays } from '../src/core/time/index.ts'
import { addToInbox } from '../src/core/inbox/index.ts'
import { defineType } from '../src/core/types/index.ts'
import { dateWordings, mentions, mentionsInOrder, mentionsNone } from './answers.ts'
import { AGENT_KEY, DAYS, TYPES } from './fixture.ts'
import type { Role } from './roles.ts'
import type { World } from './world.ts'

/** What a check is given after a run: the final answer, and the database as the run left it. */
export interface Observed {
  readonly answer: string
  readonly world: World
  /** When the run started (ISO 8601), to tell what it changed. */
  readonly startedAt: string
}

/**
 * One task of the bench: what the owner asks, in their own words and never naming a tool; the roles
 * a good run needs (see `roles.ts`); and a check that reads the database through the core and the
 * final answer, and gives the reasons it fails (none when it passes).
 */
export interface Task {
  readonly id: string
  /** Not used to tune descriptions or instructions: it tells whether a gain holds elsewhere. */
  readonly heldOut: boolean
  readonly prompt: string
  readonly expects: ReadonlyArray<Role>
  /** Puts the database in the state the task starts from, after the copy of the instance. */
  readonly setup?: (world: World) => Promise<void>
  readonly check: (observed: Observed) => Promise<ReadonlyArray<string>>
}

const ok = (condition: boolean, problem: string) => (condition ? [] : [problem])

/** The types of the instance as it starts. */
const TYPE_NAMES = new Set(TYPES.map(({ name }) => name))

const read = (world: World, slug: string) => world.entry(slug)

/** The other end of the links an entry has, outgoing, by slug. */
const linked = (found: NonNullable<Awaited<ReturnType<World['entry']>>>) =>
  found.links.map(({ slug }) => slug)

/** The first titles of the recipes that do not use lemon. */
const OTHER_RECIPES = [
  'Sourdough bread',
  'Lentil soup',
  'Pumpkin risotto',
  'Apple crumble',
  'Shakshuka',
  'Plum jam',
  'Banana bread',
  'Tomato sauce',
  'Pancakes',
  'Chickpea chili',
]

/** The parts of the main server, by the words an answer may use for each. */
const ATLAS_PARTS: ReadonlyArray<ReadonlyArray<string>> = [
  ['Graphics card', 'GPU', 'Vireo RX 640'],
  ['Processor', 'CPU', 'Corvid 12-core'],
  ['Memory kit', 'RAM', 'Northgate 2x16'],
  ['System SSD', 'NVMe', 'Northgate 1 TB'],
  ['Server case', 'Pine tower'],
  ['Power supply', 'PSU', '650 W'],
  ['Cooling fans', 'fans'],
  ['Network card', 'Bluefin 2.5 Gb'],
]

const KEPT = /already|exist|duplicate|saved|kept|have it/i

const UNABLE =
  /\b(no|not|nothing|none|cannot|can't|couldn't|don't|do not|unable|isn't|aren't|haven't|doesn't)\b/i

/** The three subjects "the music thing" may mean, with how long ago each last changed. */
const MUSIC = [
  { title: 'Music library tagging', slug: 'music-library-tagging', daysAgo: 2 },
  { title: 'Music lessons schedule', slug: 'music-lessons-schedule', daysAgo: 21 },
  { title: 'Music festival tickets', slug: 'music-festival-tickets', daysAgo: 150 },
] as const

/** An entry as a check reads it, with its links and the places it is part of. */
type Found = NonNullable<Awaited<ReturnType<World['entry']>>>

/** The dates an entry holds as data: the day it starts to hold, and its fields that are dates. */
const datesOf = ({ entry }: Found) =>
  [entry.valid_from, ...Object.values(entry.fields)].filter(
    (value): value is string => Predicate.isString(value) && /^\d{4}-\d{2}-\d{2}/.test(value),
  )

/** Whether an entry is part of the entry of that slug today. */
const under = (found: Found, slug: string) => found.part_of.some((place) => place.slug === slug)

/**
 * The day an entry happened, when its type is dated (`dated_by`, among `types`): the value of that
 * field, or `undefined`.
 */
const happenedOn = (
  { entry }: Found,
  types: ReadonlyArray<{ readonly name: string; readonly dated_by?: string | undefined }>,
) => {
  const field = types.find(({ name }) => name === entry.type)?.dated_by
  const value = field === undefined ? undefined : entry.fields[field]
  return Predicate.isString(value) ? value : undefined
}

/** What an earlier session of the bench's key wrote: a dated type for sessions of work. */
const WORK_SESSION = {
  name: 'work-session',
  label: 'Work session',
  description:
    'A session of work on a project or a thing, on one day: what was done, decided or refused, and what comes next.',
  fields: [{ name: 'held_on', kind: 'date' as const, required: true }],
  dated_by: 'held_on',
}

/** A session of work, written by the bench's key under a subject, some days before the run. */
const workSession = (
  today: string,
  daysAgo: number,
  parent: string,
  title: string,
  body: string,
) => ({
  type: WORK_SESSION.name,
  title,
  parent,
  fields: { held_on: addDays(today, -daysAgo) },
  summary: `${title}, on ${addDays(today, -daysAgo)}.`,
  body,
  provenance: { held_on: 'inferred', parent: 'inferred', body: 'inferred', summary: 'inferred' },
})

/** Whether an entry is part of, or linked to, the entry of that slug. */
const about = (found: Found, slug: string) =>
  found.part_of.some((place) => place.slug === slug) || linked(found).includes(slug)

/**
 * What a run did with things that happened at a time: the entries it created, and the entries that
 * existed before whose body it changed (a body grown with each new thing is what is not wanted).
 */
const happenings = async (world: World, startedAt: string) => {
  const everything = await world.everything()
  const created = everything.filter(({ entry }) => entry.created >= startedAt)
  const touched = everything.filter(
    ({ entry }) => entry.created < startedAt && entry.updated >= startedAt,
  )
  const histories = await Promise.all(touched.map(({ entry }) => world.history(entry.slug)))
  const grown = touched.filter((_, index) =>
    (histories[index] ?? []).some(
      ({ at, changes }) => at >= startedAt && changes.some(({ field }) => field === 'body'),
    ),
  )
  return { created, grown: grown.map(({ entry }) => entry.slug) }
}

/** The March before the day of the run: its year and month, as a date begins with them. */
export const lastMarch = (today: string) => {
  const year = Number(today.slice(0, 4))
  return `${Number(today.slice(5, 7)) > 3 ? year : year - 1}-03`
}

export const TASKS: ReadonlyArray<Task> = [
  {
    id: 'recall-graphics-card',
    heldOut: false,
    prompt:
      'What do I know about the graphics card in my server? Tell me which server it is in, where I bought it, and which projects that server serves.',
    expects: ['search', 'read'],
    check: async ({ answer }) => [
      ...mentions(answer, ['Atlas server', 'Corvid Parts', 'Media streaming setup', 'Backup plan']),
    ],
  },
  {
    id: 'recall-shop-purchases',
    heldOut: true,
    prompt:
      'Everything I bought from Corvid Parts: what is it, and which machine is each item installed in?',
    expects: ['search', 'read'],
    check: async ({ answer }) => [
      ...mentions(answer, [
        ['Graphics card', 'GPU', 'Vireo RX 640'],
        ['Processor', 'CPU', 'Corvid 12-core'],
        ['Power supply', 'PSU', '650 W'],
        'Atlas server',
      ]),
      ...mentionsNone(answer, ['Memory kit', 'Network card', 'Cooling fans']),
    ],
  },
  {
    id: 'recall-person-role',
    heldOut: false,
    prompt: 'Where does Samir Haddad work now, and as what? Did he work somewhere else before?',
    expects: ['search', 'read'],
    check: async ({ answer }) => [
      ...mentions(answer, [
        'Harbor Credit Union',
        'loan officer',
        'Tidewater Insurance',
        'claims adviser',
      ]),
    ],
  },
  {
    id: 'recall-lemon-recipes',
    heldOut: false,
    prompt: 'Which of my recipes use lemon?',
    expects: ['search'],
    check: async ({ answer }) => [
      ...mentions(answer, ['Lemon curd', 'Lemon-herb chicken', 'Citrus salad']),
      ...mentionsNone(answer, OTHER_RECIPES),
    ],
  },
  {
    id: 'recall-contract-end',
    heldOut: false,
    prompt: 'When does my home internet contract end, who is the provider, and how does it renew?',
    expects: ['search', 'read'],
    check: async ({ answer, world }) => [
      ...mentions(answer, [
        dateWordings(addDays(world.today, DAYS.internetEnds)),
        'Skyline Internet',
        ['tacit', 'automatic', 'auto-renew', 'renews itself'],
      ]),
    ],
  },
  {
    id: 'recall-decision-reason',
    heldOut: false,
    prompt: 'Why did I choose snapshots for my backups, and what did I set aside in their favour?',
    expects: ['search', 'read'],
    check: async ({ answer }) => [
      ...mentions(answer, [
        ['single dataset', 'one dataset', 'a dataset', 'individual dataset', 'restore'],
        ['file sync', 'sync tool', 'syncing'],
      ]),
    ],
  },
  {
    id: 'recall-server-parts',
    heldOut: false,
    prompt: 'List all the parts of my main server.',
    expects: ['search', 'read'],
    check: async ({ answer }) => [...mentions(answer, ATLAS_PARTS)],
  },
  {
    id: 'history-location',
    heldOut: true,
    prompt: 'Who last changed where the Pantry NAS is kept, and where was it before?',
    expects: ['history'],
    check: async ({ answer }) => [
      ...mentions(answer, ['agent-desk', 'garage shelf', 'hallway cupboard']),
    ],
  },
  {
    id: 'due-this-week',
    heldOut: false,
    prompt: 'What is coming due this week?',
    expects: ['agenda'],
    check: async ({ answer }) => [
      ...mentions(answer, ['Home internet', 'Media streaming setup', 'Maya Okafor']),
    ],
  },
  {
    id: 'overdue',
    heldOut: false,
    prompt: 'Is anything overdue that I should have dealt with by now?',
    expects: ['agenda'],
    check: async ({ answer }) => [...mentions(answer, ['Home insurance'])],
  },
  {
    id: 'contracts-ending-soon',
    heldOut: true,
    prompt: 'Which of my contracts end in the next two months? Give them in the order they end.',
    expects: ['agenda'],
    check: async ({ answer }) => [
      ...mentions(answer, ['Home internet', 'Electricity plan', 'Gym membership', 'Phone plan']),
      ...mentionsInOrder(answer, [
        'Home internet',
        'Electricity plan',
        'Gym membership',
        'Phone plan',
      ]),
    ],
  },
  {
    id: 'renewed-contract',
    heldOut: false,
    prompt: 'I renewed my home internet contract yesterday, so stop treating it as due.',
    expects: ['agenda', 'link', 'write'],
    check: async ({ world }) => {
      const stillDue = (await world.upcoming(world.today, addDays(world.today, 30))).filter(
        ({ entry }) => entry.slug === 'home-internet',
      )
      const contract = await read(world, 'home-internet')
      return [
        ...ok(contract !== undefined, 'the contract is gone'),
        ...ok(stillDue.length === 0, 'the contract still comes due within the month'),
      ]
    },
  },
  {
    id: 'create-recipe',
    heldOut: false,
    prompt:
      'Add a recipe for lemon tart to my cookbook: it serves 8 and takes 90 minutes. Ingredients: 250 g flour, 125 g butter, 100 g sugar, 4 lemons, 3 eggs. Bake the shell blind for 15 minutes, fill it with the lemon cream and bake 20 minutes more.',
    expects: ['write'],
    check: async ({ world }) => {
      const found = (await world.everything()).filter(({ entry }) =>
        /lemon tart/i.test(entry.title),
      )
      const [tart] = found
      const body = tart?.entry.body.toLowerCase() ?? ''
      return [
        ...ok(found.length === 1, `expected one lemon tart, found ${found.length}`),
        ...ok(tart?.entry.type === 'recipe', 'the lemon tart is not a recipe'),
        ...ok(
          tart?.path.at(-1) === 'Kitchen',
          'the lemon tart is not filed under the Kitchen area',
        ),
        ...ok(tart?.entry.fields['servings'] === 8, 'servings is not 8'),
        ...ok(tart?.entry.fields['time_minutes'] === 90, 'time_minutes is not 90'),
        ...['flour', 'butter', 'sugar', 'lemons', 'eggs'].flatMap((word) =>
          ok(body.includes(word), `the body leaves out ${word}`),
        ),
        ...ok(!/kitchen/i.test(tart?.entry.title ?? ''), 'the title repeats its parent'),
      ]
    },
  },
  {
    id: 'add-disk',
    heldOut: false,
    prompt:
      'I added a fourth 4 TB disk to the Pantry NAS today. It came from Northgate Electronics, serial SW-1004.',
    expects: ['write', 'link'],
    check: async ({ world }) => {
      const nas = await read(world, 'pantry-nas')
      const parts = nas?.children ?? []
      const added = parts.filter(({ slug }) => !/^disk-(one|two|three)$/.test(slug))
      const fresh = added[0] === undefined ? undefined : await read(world, added[0].slug)
      return [
        ...ok(
          added.length === 1,
          `expected one new part under the Pantry NAS, found ${added.length}`,
        ),
        ...ok(fresh?.entry.type === 'component', 'the new disk is not a component'),
        ...ok(
          JSON.stringify(fresh?.entry.fields ?? {}).includes('SW-1004'),
          'the serial is not kept',
        ),
        ...ok(
          fresh !== undefined && linked(fresh).includes('northgate-electronics'),
          'the disk is not linked to Northgate Electronics',
        ),
        ...ok(!/pantry|nas/i.test(fresh?.entry.title ?? ''), 'the title repeats its parent'),
      ]
    },
  },
  {
    id: 'fix-serial',
    heldOut: false,
    prompt: 'The serial number of the processor in my server is wrong: it is CV-5522, not CV-5521.',
    expects: ['write'],
    check: async ({ world }) => {
      const processor = await read(world, 'processor')
      const components = (await world.tree()).filter(({ type }) => type === 'component')
      return [
        ...ok(processor?.entry.fields['serial'] === 'CV-5522', 'the serial is not corrected'),
        ...ok(components.length === 15, `expected 15 components, found ${components.length}`),
      ]
    },
  },
  {
    id: 'edit-recipe-time',
    heldOut: true,
    prompt: 'In my sourdough recipe, the bread now bakes for 50 minutes instead of 45.',
    expects: ['write'],
    check: async ({ world }) => {
      const bread = await read(world, 'sourdough-bread')
      const body = bread?.entry.body ?? ''
      return [
        ...ok(body.includes('50 minutes'), 'the body does not say 50 minutes'),
        ...ok(!body.includes('45 minutes'), 'the body still says 45 minutes'),
        ...ok(
          body.includes('500 g flour') && body.includes('starter'),
          'the rest of the body was lost',
        ),
      ]
    },
  },
  {
    id: 'archive-laptop',
    heldOut: false,
    prompt: 'I sold the desk laptop, so it should not show up any more. Keep the reason.',
    expects: ['archive'],
    check: async ({ world }) => {
      const laptop = await read(world, 'desk-laptop')
      const atlas = await read(world, 'atlas-server')
      return [
        ...ok(laptop?.entry.archived_at != null, 'the desk laptop is not archived'),
        ...ok((laptop?.entry.archived_reason ?? '').trim() !== '', 'no reason is kept'),
        ...ok(atlas?.entry.archived_at == null, 'the Atlas server was archived too'),
      ]
    },
  },
  {
    id: 'change-of-job',
    heldOut: false,
    prompt:
      'Nolan Reyes left Riverside Bakery on 2026-08-31 and started on 2026-09-01 as a claims adviser at Tidewater Insurance.',
    expects: ['link'],
    check: async ({ world }) => {
      const nolan = await read(world, 'nolan-reyes')
      const joined = nolan?.links.find(({ slug }) => slug === 'tidewater-insurance')
      const left = nolan?.links.find(({ slug }) => slug === 'riverside-bakery')
      return [
        ...ok(joined !== undefined, 'no link to Tidewater Insurance'),
        ...ok(/claims/i.test(joined?.note ?? ''), 'the role is not kept on the new link'),
        ...ok(joined?.valid_from === '2026-09-01', 'the new link does not start on 2026-09-01'),
        ...ok(left !== undefined, 'the link to Riverside Bakery was removed'),
        ...ok(left?.valid_until === '2026-08-31', 'the old link does not end on 2026-08-31'),
      ]
    },
  },
  {
    id: 'new-contact',
    heldOut: true,
    prompt:
      'I met Priya Nair, an accountant at Harbor Credit Union, who has been there since 2025-01-15. Add her to my contacts.',
    expects: ['write', 'link'],
    check: async ({ world }) => {
      const found = (await world.everything()).filter(({ entry }) =>
        /priya nair/i.test(entry.title),
      )
      const [priya] = found
      const toBank = priya?.links.find(({ slug }) => slug === 'harbor-credit-union')
      return [
        ...ok(found.length === 1, `expected one Priya Nair, found ${found.length}`),
        ...ok(priya?.entry.type === 'person', 'she is not a person'),
        ...ok(priya?.path.at(-1) === 'People', 'she is not filed under the People area'),
        ...ok(toBank !== undefined, 'no link to Harbor Credit Union'),
        ...ok(/accountant/i.test(toBank?.note ?? ''), 'the role is not on the link'),
        ...ok(toBank?.valid_from === '2025-01-15', 'the link does not start on 2025-01-15'),
      ]
    },
  },
  {
    id: 'relation-between-entries',
    heldOut: false,
    prompt: 'The Media streaming setup project depends on the Network router: record that.',
    expects: ['link'],
    check: async ({ world }) => {
      const project = await read(world, 'media-streaming-setup')
      const router = await read(world, 'network-router')
      return ok(
        (project !== undefined && linked(project).includes('network-router')) ||
          (router !== undefined && linked(router).includes('media-streaming-setup')),
        'the two are not linked',
      )
    },
  },
  {
    id: 'replace-decision',
    heldOut: false,
    prompt:
      'We changed our mind about backups: from now on we replicate to a second NAS instead of using ZFS snapshots, because the monthly offsite trip is too much hassle. Record the new decision, and mark the old one as replaced.',
    expects: ['write'],
    check: async ({ world }) => {
      const old = await read(world, 'use-zfs-snapshots-for-backups')
      const decisions = (await world.everything()).filter(
        ({ entry }) =>
          entry.type === 'decision' && /replicat/i.test(`${entry.title} ${entry.body}`),
      )
      const [fresh] = decisions
      return [
        ...ok(decisions.length === 1, `expected one new decision, found ${decisions.length}`),
        ...ok(
          fresh !== undefined && old?.entry.superseded_by === fresh.entry.id,
          'the old decision does not point to the new one',
        ),
        ...ok(old?.entry.archived_at == null, 'the old decision was archived instead'),
      ]
    },
  },
  {
    id: 'bookmark-already-kept',
    heldOut: false,
    prompt:
      'Keep this link for later, it is good on snapshots: https://example.org/guides/zfs-basics',
    expects: ['write'],
    check: async ({ answer, world }) => {
      const kept = (await world.everything()).filter(
        ({ entry }) => entry.fields['url'] === 'https://example.org/guides/zfs-basics',
      )
      return [
        ...ok(kept.length === 1, `expected the link once, found ${kept.length}`),
        ...ok(KEPT.test(answer), 'the answer does not say the link was already kept'),
      ]
    },
  },
  {
    id: 'move-part',
    heldOut: false,
    prompt: 'The network card is now in the Pantry NAS, no longer in the Atlas server.',
    expects: ['write'],
    check: async ({ world }) => {
      const card = await read(world, 'network-card')
      return ok(
        card?.path.at(-1) === 'Pantry NAS',
        'the network card is not filed under the Pantry NAS',
      )
    },
  },
  {
    id: 'note-with-quote',
    heldOut: true,
    prompt:
      'Add a note to the Kitchen renovation project: Pine Street Hardware quoted 2400 EUR for the worktop, valid until 2026-11-30.',
    expects: ['write', 'link'],
    check: async ({ world }) => {
      const everything = await world.everything()
      const quote = everything.find(
        ({ entry }) => entry.body.includes('2400') && entry.body.includes('2026-11-30'),
      )
      return [
        ...ok(quote !== undefined, 'no entry holds the quote and its validity'),
        ...ok(
          quote !== undefined && quote.path.at(-1) === 'Kitchen renovation',
          'the note is not filed under the Kitchen renovation project',
        ),
        ...ok(
          quote !== undefined && linked(quote).includes('pine-street-hardware'),
          'the note does not cite Pine Street Hardware',
        ),
      ]
    },
  },
  {
    id: 'add-field',
    heldOut: false,
    prompt: 'I want to track the warranty end date of every component of my machines. Set that up.',
    expects: ['type_define'],
    check: async ({ world }) => {
      const component = (await world.types()).find(({ name }) => name === 'component')
      return ok(
        (component?.fields ?? []).some(
          ({ kind, name }) => kind === 'date' && /warranty/i.test(name),
        ),
        'the component type has no date field for the warranty',
      )
    },
  },
  {
    id: 'new-type',
    heldOut: false,
    prompt:
      'I want to keep track of my houseplants: species, where each one stands, and when it was last watered. Set up what is needed and add my Monstera, in the living room, last watered 2026-10-06.',
    expects: ['type_define', 'write'],
    check: async ({ world }) => {
      const monstera = (await world.everything()).find(({ entry }) => /monstera/i.test(entry.title))
      const type = (await world.types()).find(({ name }) => name === monstera?.entry.type)
      const kept = JSON.stringify(monstera?.entry.fields ?? {}) + (monstera?.entry.body ?? '')
      return [
        ...ok(monstera !== undefined, 'the Monstera is not there'),
        ...ok(
          type !== undefined && !['note', 'area'].includes(type.name),
          'the Monstera is not of a type made for plants',
        ),
        ...ok(
          (type?.fields ?? []).some(({ kind }) => kind === 'date'),
          'the type has no date field',
        ),
        ...ok(
          monstera?.entry.fields !== undefined &&
            Object.values(monstera.entry.fields).includes('2026-10-06'),
          'the watering date is not in a field',
        ),
        ...ok(/living room/i.test(kept), 'the living room is not kept'),
      ]
    },
  },
  {
    id: 'make-field-required',
    heldOut: false,
    prompt:
      'From now on every contract must say how it renews, so make that mandatory. The ones that do not say yet renew manually.',
    expects: ['type_change'],
    check: async ({ world }) => {
      const contract = (await world.types()).find(({ name }) => name === 'contract')
      const renewal = contract?.fields.find(({ name }) => name === 'renewal')
      const value = async (slug: string) => (await read(world, slug))?.entry.fields['renewal']
      return [
        ...ok(renewal?.required === true, 'the renewal field is not required'),
        ...ok((await value('phone-plan')) === 'manual', 'the phone plan does not renew manually'),
        ...ok(
          (await value('bank-account-package')) === 'manual',
          'the bank account package does not renew manually',
        ),
        ...ok((await value('home-internet')) === 'tacit', 'a renewal that was set was changed'),
      ]
    },
  },
  {
    id: 'inbox-three-items',
    heldOut: true,
    prompt: 'Please go through everything waiting in my inbox.',
    expects: ['inbox_list', 'inbox_take', 'inbox_finish', 'write'],
    setup: async (world) => {
      await world.arrange(
        addToInbox({
          kind: 'text',
          origin: 'chat',
          text: 'Hummus: blend 400 g chickpeas, 2 tbsp tahini, the juice of 1 lemon and a clove of garlic until smooth. Serves 4, ready in 10 minutes.',
        }),
      )
      await world.arrange(
        addToInbox({
          kind: 'text',
          origin: 'chat',
          text: 'Update on the Pantry NAS: the spare disk was replaced under warranty on 2026-09-20. The new disk has the serial SW-2003.',
        }),
      )
      await world.arrange(
        addToInbox({
          kind: 'url',
          origin: 'newsletter',
          url: 'https://example.org/guides/zfs-snapshots-deep-dive',
        }),
      )
    },
    check: async ({ world }) => {
      const items = await world.inbox()
      const everything = await world.everything()
      const hummus = everything.find(({ entry }) => /hummus/i.test(entry.title))
      const spare = await read(world, 'disk-three')
      const components = (await world.tree()).filter(({ type }) => type === 'component')
      return [
        ...ok(
          items.length === 3 && items.every(({ status }) => status === 'processed'),
          'not every item is processed',
        ),
        ...ok(hummus?.entry.type === 'recipe', 'the hummus is not a recipe'),
        ...ok(hummus?.path.at(-1) === 'Kitchen', 'the hummus is not filed under the Kitchen area'),
        ...ok(hummus?.entry.fields['servings'] === 4, 'servings is not 4'),
        ...ok(spare?.entry.fields['serial'] === 'SW-2003', 'the spare disk was not updated'),
        ...ok(components.length === 15, `expected 15 components, found ${components.length}`),
        ...ok(
          everything.some(
            ({ entry }) =>
              entry.fields['url'] === 'https://example.org/guides/zfs-snapshots-deep-dive',
          ),
          'the page of the newsletter is not kept',
        ),
      ]
    },
  },
  {
    id: 'inbox-set-aside-junk',
    heldOut: false,
    prompt: 'Go through my inbox: file what is worth keeping and set aside what is junk.',
    expects: ['inbox_list', 'inbox_take', 'inbox_finish', 'write'],
    setup: async (world) => {
      await world.arrange(
        addToInbox({
          kind: 'text',
          origin: 'chat',
          text: 'Pesto: crush basil, pine nuts, parmesan and olive oil with a pinch of salt. Serves 4.',
        }),
      )
      await world.arrange(
        addToInbox({ kind: 'text', origin: 'chat', text: 'asdf qwer 12345 test test' }),
      )
    },
    check: async ({ world }) => {
      const items = await world.inbox()
      const pesto = (await world.everything()).find(({ entry }) => /pesto/i.test(entry.title))
      return [
        ...ok(pesto?.entry.type === 'recipe', 'the pesto is not a recipe'),
        ...ok(
          items.filter(({ status }) => status === 'processed').length === 1,
          'the pesto item is not processed',
        ),
        ...ok(
          items.filter(({ status }) => status === 'dismissed').length === 1,
          'the junk is not set aside',
        ),
      ]
    },
  },
  {
    id: 'inbox-capture',
    heldOut: false,
    prompt:
      'Put this in my inbox for later, it comes from the newsletter: https://example.org/articles/rack-cooling',
    expects: ['inbox_add'],
    check: async ({ world }) => {
      const waiting = (await world.inbox()).filter(({ status }) => status === 'pending')
      const everything = await world.everything()
      return [
        ...ok(
          waiting.some(
            (item) => 'preview' in item && String(item.preview).includes('rack-cooling'),
          ),
          'the link is not waiting in the inbox',
        ),
        ...ok(
          !everything.some(({ entry }) =>
            JSON.stringify(entry.fields).includes('articles/rack-cooling'),
          ),
          'the link was filed as an entry instead',
        ),
      ]
    },
  },
  {
    id: 'supposed-queue',
    heldOut: false,
    prompt: 'What in my notes is only a guess, not something I told you?',
    expects: ['supposed'],
    check: async ({ answer }) => [
      ...mentions(answer, [
        'Router settings',
        'Cable management ideas',
        'Lemon curd',
        'Flatbreads',
      ]),
      ...mentionsNone(answer, ['Atlas server', 'Pantry NAS', 'Sourdough bread']),
    ],
  },
  {
    id: 'nothing-known',
    heldOut: true,
    prompt: 'What is the wifi password at the cabin?',
    expects: ['search'],
    check: async ({ answer, world, startedAt }) => {
      const changed = (await world.everything()).filter(({ entry }) => entry.updated >= startedAt)
      return [
        ...ok(changed.length === 0, `${changed.length} entries were written`),
        ...ok(UNABLE.test(answer), 'the answer does not say that nothing is known'),
      ]
    },
  },
  {
    id: 'resume-discussion',
    heldOut: false,
    prompt: 'Resume where we were.',
    expects: ['search', 'read'],
    // What an earlier session, using the same key, wrote a few minutes ago about a discussion
    // with the owner: nothing says so to this session but the entries themselves.
    setup: async (world) => {
      await world.arrange(
        Effect.provideService(
          writeEntries([
            {
              type: 'project',
              title: 'Pantry NAS disk replacement',
              summary:
                'Replacing the failing second disk of the [[pantry-nas]] with a new one, decided in a talk with the owner: which disk, the order of the work, the warranty claim.',
              fields: { status: 'active' },
              body: 'The second disk of the [[pantry-nas]] reports errors. Disk chosen and steps are in the parts of this project.',
              provenance: { status: 'inferred', body: 'inferred', summary: 'inferred' },
            },
            {
              type: 'note',
              title: 'Replacement disk comparison',
              parent: 'pantry-nas-disk-replacement',
              summary: 'Why the Halden 8 TB was chosen over the Corvid 6 TB for the Pantry NAS.',
              body: 'The Halden 8 TB is quieter and has a five-year warranty; the Corvid 6 TB is cheaper but only has two years.',
              provenance: { parent: 'inferred', body: 'inferred', summary: 'inferred' },
            },
            {
              type: 'note',
              title: 'Warranty claim steps',
              parent: 'pantry-nas-disk-replacement',
              summary: 'What to send to claim the warranty of the failing disk of the Pantry NAS.',
              body: 'Send the serial number and the error log to the maker, then ship the disk back within thirty days.',
              provenance: { parent: 'inferred', body: 'inferred', summary: 'inferred' },
            },
            {
              type: 'note',
              title: 'Disk swap order',
              parent: 'pantry-nas-disk-replacement',
              summary: 'The order of the work to swap the failing disk of the Pantry NAS.',
              body: 'Snapshot first, replace the disk, let the pool resilver, then check the data.',
              provenance: { parent: 'inferred', body: 'inferred', summary: 'inferred' },
            },
          ]),
          Actor,
          AGENT_KEY,
        ),
      )
    },
    check: async ({ answer }) => [
      ...mentions(answer, ['Pantry NAS disk replacement', 'Halden 8 TB']),
    ],
  },
  {
    id: 'vague-music-thing',
    heldOut: false,
    prompt: 'Where are we on the music thing?',
    expects: ['search', 'read'],
    // Three subjects that fit, written at different times: none is the obvious one.
    setup: async (world) => {
      const day = (daysAgo: number) => addDays(world.today, -daysAgo)
      await world.arrange(
        writeEntries([
          {
            type: 'project',
            title: MUSIC[0].title,
            summary: 'Clean the tags of the music files kept on the Atlas server.',
            fields: { status: 'active' },
            body: 'Fix artist and album names, one folder at a time.',
            created: day(MUSIC[0].daysAgo),
            updated: day(MUSIC[0].daysAgo),
            provenance: { status: 'inferred', body: 'inferred', summary: 'inferred' },
          },
          {
            type: 'note',
            title: MUSIC[1].title,
            summary: 'The weekly timetable of the music lessons at the conservatory.',
            body: 'Tuesday evening and Saturday morning.',
            created: day(MUSIC[1].daysAgo),
            updated: day(MUSIC[1].daysAgo),
            provenance: { body: 'inferred', summary: 'inferred' },
          },
          {
            type: 'bookmark',
            title: MUSIC[2].title,
            summary: 'Where to buy tickets for the summer music festival.',
            fields: { url: 'https://example.org/festival/tickets' },
            created: day(MUSIC[2].daysAgo),
            updated: day(MUSIC[2].daysAgo),
            provenance: { url: 'inferred', summary: 'inferred' },
          },
        ]),
      )
    },
    check: async ({ answer, world, startedAt }) => {
      const changed = (await world.everything()).filter(({ entry }) => entry.updated >= startedAt)
      return [
        ...mentions(
          answer,
          MUSIC.map(({ title }) => title),
        ),
        ...ok(answer.includes('?'), 'the answer does not ask which one is meant'),
        ...ok(changed.length === 0, `${changed.length} entries were written`),
      ]
    },
  },
  {
    id: 'link-two-by-title',
    heldOut: false,
    prompt:
      'Add a note called "Saturday tinkering": I spent the afternoon tidying the cables behind the Network router, and Samir Haddad came by for a coffee.',
    expects: ['write'],
    check: async ({ world }) => {
      const found = (await world.everything()).filter(({ entry }) =>
        /saturday tinkering/i.test(entry.title),
      )
      const [idea] = found
      const targets = idea === undefined ? [] : linked(idea)
      return [
        ...ok(found.length === 1, `expected one note, found ${found.length}`),
        ...ok(targets.includes('network-router'), 'the note is not linked to the Network router'),
        ...ok(targets.includes('samir-haddad'), 'the note is not linked to Samir Haddad'),
        ...ok(
          !['Network router', 'Samir Haddad'].includes(idea?.path.at(-1) ?? ''),
          'the note is filed under one of the two entries it is only about',
        ),
      ]
    },
  },
  {
    id: 'session-journal',
    heldOut: false,
    prompt:
      'Keep a journal of this session: I cleaned the dust filters of the Atlas server, then updated its firmware to version 2.4. The fans are still noisy, to be checked next month.',
    expects: ['write', 'link', 'type_define'],
    check: async ({ world, startedAt }) => {
      const { created, grown } = await happenings(world, startedAt)
      const types = await world.types()
      const session = created.filter(
        (found) =>
          under(found, 'atlas-server') &&
          happenedOn(found, types) === world.today &&
          /firmware/i.test(`${found.entry.title} ${found.entry.summary} ${found.entry.body}`),
      )
      return [
        ...ok(grown.length === 0, `the body of ${grown.join(', ')} was grown`),
        ...ok(
          session.length > 0,
          'no entry of its own, of a dated type, dated today and part of the Atlas server, records the session',
        ),
      ]
    },
  },
  {
    id: 'boiler-serviced',
    heldOut: false,
    prompt: 'Record that the boiler was serviced today, and that it was serviced last March.',
    expects: ['write', 'link', 'type_define'],
    setup: async (world) => {
      await world.arrange(
        writeEntries([
          {
            type: 'note',
            title: 'Gas boiler',
            summary: 'The gas boiler of the house, in the cellar: a wall-hung condensing model.',
            body: 'Installed by the previous owners. The manual is in the cellar drawer.',
            provenance: { body: 'inferred', summary: 'inferred' },
          },
        ]),
      )
    },
    check: async ({ world, startedAt }) => {
      const { created, grown } = await happenings(world, startedAt)
      const services = created.filter((found) => about(found, 'gas-boiler'))
      const dated = (day: string) =>
        services.some((found) => datesOf(found).some((date) => date.startsWith(day)))
      // The owner gives no day in March: an entry of its own that names the month, without
      // inventing a day, is dated as well as it can be.
      const march = services.some(
        (found) =>
          datesOf(found).length === 0 &&
          /\bmarch\b/i.test(`${found.entry.title} ${found.entry.summary}`),
      )
      return [
        ...ok(grown.length === 0, `the body of ${grown.join(', ')} was grown`),
        ...ok(dated(world.today), 'no entry about the boiler is dated today'),
        ...ok(
          dated(lastMarch(world.today)) || march,
          'no entry about the boiler is dated last March',
        ),
      ]
    },
  },
  {
    id: 'pick-up-project',
    heldOut: false,
    prompt: 'Pick up the work on the kitchen renovation.',
    expects: ['search', 'read'],
    // Three sessions written by earlier sessions of the same key, under the project: what the last
    // one found, and what comes next, is said nowhere else.
    setup: async (world) => {
      await world.arrange(
        Effect.provideService(
          Effect.gen(function* () {
            yield* defineType(WORK_SESSION)
            yield* writeEntries([
              workSession(
                world.today,
                25,
                'kitchen-renovation',
                'Old tiles removed',
                'Removed the old wall tiles behind the hob. Next: order the new worktop.',
              ),
              workSession(
                world.today,
                12,
                'kitchen-renovation',
                'Worktop ordered',
                'Ordered the oak worktop; delivery in about ten days. Next: fit it when it comes.',
              ),
              workSession(
                world.today,
                3,
                'kitchen-renovation',
                'Worktop delivered, sink opening wrong',
                'The worktop came, but its sink opening is two centimetres too narrow: the joiner takes it back to recut it. Next: call the joiner on Thursday to fix the recut date, and only then lay the tiles.',
              ),
            ])
          }),
          Actor,
          AGENT_KEY,
        ),
      )
    },
    check: async ({ answer }) => [
      ...mentions(answer, [['recut', 're-cut', 'too narrow', 'sink opening']]),
    ],
  },
  {
    id: 'second-session-reuses-type',
    heldOut: false,
    prompt:
      'Keep a journal of this session: I replaced the two noisy fans of the Atlas server, it is quiet now.',
    expects: ['write', 'link'],
    // An earlier session defined a dated type for sessions of work and wrote one under the server.
    setup: async (world) => {
      await world.arrange(
        Effect.provideService(
          Effect.gen(function* () {
            yield* defineType(WORK_SESSION)
            yield* writeEntries([
              workSession(
                world.today,
                30,
                'atlas-server',
                'Atlas server upkeep',
                'Cleaned the dust filters, then updated the firmware to version 2.4. The fans are still noisy: check them next month.',
              ),
            ])
          }),
          Actor,
          AGENT_KEY,
        ),
      )
    },
    check: async ({ world, startedAt }) => {
      const { created } = await happenings(world, startedAt)
      const types = await world.types()
      const session = created.filter(
        (found) =>
          found.entry.type === WORK_SESSION.name &&
          under(found, 'atlas-server') &&
          happenedOn(found, types) === world.today,
      )
      const defined = types.filter(({ name }) => !TYPE_NAMES.has(name) && name !== 'work-session')
      return [
        ...ok(
          session.length > 0,
          'no work session dated today, part of the Atlas server, records the session',
        ),
        ...ok(
          defined.length === 0,
          `another type was defined: ${defined.map(({ name }) => name).join(', ')}`,
        ),
      ]
    },
  },
]
