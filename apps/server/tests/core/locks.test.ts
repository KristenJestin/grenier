import { Deferred, Effect, Fiber, Result } from 'effect'
import { SqlClient } from 'effect/sql'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { execute, whileLocked } from '../../src/core/database/contention.ts'
import { readEntry, writeEntries, writeEntry } from '../../src/core/entries/index.ts'
import { TREE_LOCK } from '../../src/core/entries/operations.ts'
import {
  addToInbox,
  finishItem,
  peekItem,
  readItem,
  takeItem,
  takeItems,
} from '../../src/core/inbox/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import { link, pendingOf } from '../../src/core/links/index.ts'
import { confirmProposal, defineType, proposeTypeDeletion } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** The sentence of a refusal, or how the effect ended. */
const outcomeOf = <A, E extends { readonly message: string }>(ended: Result.Result<A, E>) =>
  Result.isSuccess(ended) ? 'written' : ended.failure.message

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({ name: 'note', label: 'Note', description: 'A note.', fields: [] })
      yield* defineType({
        name: 'bill',
        label: 'Bill',
        description: 'A bill.',
        fields: [
          { name: 'due_on', kind: 'date', recurs: { every: 'monthly', notice: 'P7D' } },
          { name: 'renew_on', kind: 'date', recurs: { every: 'yearly', notice: 'P30D' } },
          { name: 'checked_on', kind: 'date', recurs: { every: 'weekly', notice: 'P1D' } },
          { name: 'pay_by', kind: 'date', due: { notice: 'P7D' } },
        ],
      })
    }),
  ),
)

describe('concurrent writes never lose a change', () => {
  test('an entry renamed while a body that cites it is edited keeps the edit, named consistently', async () => {
    await run(writeEntry({ type: 'note', title: 'Apple', slug: 'apple' }))
    const citing = await run(
      writeEntry({
        type: 'note',
        title: 'Orchard',
        body: 'See [[apple]].',
        provenance: { body: 'inferred' },
      }),
    )
    const ended = await run(
      whileLocked(execute('SELECT 1 FROM entries WHERE id = $1::uuid FOR UPDATE', citing.id), [
        writeEntry({
          entry: 'orchard',
          body: 'See [[apple]], twice.',
          provenance: { body: 'inferred' },
        }),
        writeEntry({ entry: 'apple', slug: 'pear' }),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
    // The edit is never lost. Written first, it is rewritten by the rename; written after, its
    // reference to the old slug waits for an entry with that slug.
    const orchard = await run(readEntry('orchard'))
    if (orchard.entry.body === 'See [[pear]], twice.')
      expect(orchard.links.map(({ slug }) => slug)).toEqual(['pear'])
    else {
      expect(orchard.entry.body).toBe('See [[apple]], twice.')
      expect(await run(pendingOf(orchard.entry.id))).toEqual(['apple'])
    }
  })

  test('a type deleted while an entry of it is created is refused, and the entry keeps a live type', async () => {
    await run(defineType({ name: 'crate', label: 'Crate', description: 'A crate.', fields: [] }))
    const proposal = await run(proposeTypeDeletion('crate'))
    const ended = await run(
      whileLocked(execute("SELECT 1 FROM types WHERE name = 'crate' FOR UPDATE"), [
        Effect.asVoid(writeEntry({ type: 'crate', title: 'Apple crate' })),
        confirmProposal(proposal.id).pipe(
          Effect.asVoid,
          Effect.provideService(Rights, ['read', 'write', 'sensitive', 'owner']),
        ),
      ]),
    )
    // Whichever gets the type first, the other is refused: never an entry of a deleted type.
    const [created, deleted] = ended.map(outcomeOf)
    if (created === 'written')
      expect(deleted).toBe(
        'The type `crate` still has 1 entries: merge them into another type before deleting it.',
      )
    else
      expect([created, deleted]).toEqual([
        'The field `type` must name an existing type: `crate` does not exist.',
        'written',
      ])
  })

  test('two inbox items finished on the same entry both stay cited', async () => {
    const entry = await run(writeEntry({ type: 'note', title: 'Hedge' }))
    const [first, second] = await run(
      Effect.forEach(['Trim in May.', 'Trim in August.'], (text) =>
        Effect.gen(function* () {
          const item = yield* addToInbox({ kind: 'text', text })
          yield* takeItem({ id: item.id })
          return item.id
        }),
      ),
    )
    const ended = await run(
      whileLocked(execute('SELECT 1 FROM entries WHERE id = $1::uuid FOR UPDATE', entry.id), [
        finishItem({ id: first ?? '', entries: ['hedge'] }),
        finishItem({ id: second ?? '', entries: ['hedge'] }),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
    // In whichever order the two got the entry.
    const { sources } = (await run(readEntry('hedge'))).entry
    expect(sources).toHaveLength(2)
    expect(sources).toEqual(
      expect.arrayContaining([
        { source: 'inbox', item: first },
        { source: 'inbox', item: second },
      ]),
    )
  })
})

describe('a link fulfills names a period of the form its date comes back by', () => {
  beforeAll(() =>
    run(
      Effect.gen(function* () {
        yield* writeEntry({
          type: 'bill',
          title: 'Water bill',
          fields: {
            due_on: '2026-01-10',
            renew_on: '2026-03-01',
            checked_on: '2026-01-05',
            pay_by: '2026-11-30',
          },
          provenance: {
            due_on: 'inferred',
            renew_on: 'inferred',
            checked_on: 'inferred',
            pay_by: 'inferred',
          },
        })
        yield* writeEntry({ type: 'note', title: 'Payment' })
      }),
    ),
  )

  const fulfills = (period: string, field: string) =>
    run(
      Effect.result(
        link('payment', 'water-bill', 'fulfills', period, field, { provenance: 'inferred' }),
      ),
    ).then(outcomeOf)

  test('a period of the wrong form is refused, naming the form expected', async () => {
    expect(await fulfills('2026', 'due_on')).toBe(
      'The field `due_on` of `water-bill` comes back every month: a link `fulfills` names its period as `2026-10`.',
    )
    expect(await fulfills('2026-10', 'renew_on')).toBe(
      'The field `renew_on` of `water-bill` comes back every year: a link `fulfills` names its period as `2026`.',
    )
    expect(await fulfills('2026-10', 'checked_on')).toBe(
      'The field `checked_on` of `water-bill` comes back every week: a link `fulfills` names its period as `2026-W41`.',
    )
    expect(await fulfills('2026', 'pay_by')).toBe(
      'The field `pay_by` of `water-bill` is a single deadline: a link `fulfills` names no period, or its date `2026-11-30`.',
    )
  })

  test('the form of each recurrence is taken, and a deadline is closed without a period', async () => {
    expect(await fulfills('2026-10', 'due_on')).toBe('written')
    expect(await fulfills('2026', 'renew_on')).toBe('written')
    expect(await fulfills('2026-W41', 'checked_on')).toBe('written')
    expect(await fulfills('', 'pay_by')).toBe('written')
    const { links } = await run(readEntry('payment'))
    expect(links.find(({ field }) => field === 'pay_by')).toMatchObject({ period: '2026-11-30' })
  })
})

describe('references and renames at the same moment', () => {
  const holdingSlug = (slug: string) =>
    execute(`SELECT pg_advisory_xact_lock(hashtext('hippocampe.reference ' || $1))`, slug)

  test('an entry created while another one cites it is linked, never left pending', async () => {
    const ended = await run(
      whileLocked(holdingSlug('quince-tree'), [
        Effect.asVoid(writeEntry({ type: 'note', title: 'Quince tree' })),
        Effect.asVoid(
          writeEntry({
            type: 'note',
            title: 'Grafts',
            body: 'From [[quince-tree]].',
            provenance: { body: 'inferred' },
          }),
        ),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
    const { links } = await run(readEntry('grafts'))
    expect(links.map(({ slug }) => slug)).toEqual(['quince-tree'])
    expect(await run(pendingOf((await run(readEntry('grafts'))).entry.id))).toEqual([])
  })

  test('a body written while the entry it cites is renamed is linked and named consistently', async () => {
    await run(writeEntry({ type: 'note', title: 'Medlar', slug: 'medlar' }))
    const ended = await run(
      whileLocked(holdingSlug('medlar'), [
        Effect.asVoid(writeEntry({ entry: 'medlar', slug: 'medlar-tree' })),
        Effect.asVoid(
          writeEntry({
            type: 'note',
            title: 'Jelly',
            body: 'Of [[medlar]].',
            provenance: { body: 'inferred' },
          }),
        ),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
    const jelly = await run(readEntry('jelly'))
    const linked = jelly.links.map(({ slug }) => slug)
    // Either the body follows the rename and links the entry, or it waits for `medlar`.
    if (jelly.entry.body === 'Of [[medlar-tree]].') expect(linked).toEqual(['medlar-tree'])
    else {
      expect(jelly.entry.body).toBe('Of [[medlar]].')
      expect(linked).toEqual([])
      expect(await run(pendingOf(jelly.entry.id))).toEqual(['medlar'])
    }
  })
})

describe('slug locks come before row locks: concurrent writes never deadlock', () => {
  // Held while both writes start: each takes what it takes before the type, then waits for it.
  const holdingType = execute("SELECT 1 FROM types WHERE name = 'note' FOR UPDATE")

  test('two entries created at once, each citing the other, are both written and linked', async () => {
    const ended = await run(
      whileLocked(holdingType, [
        Effect.asVoid(
          writeEntry({
            type: 'note',
            title: 'Alder',
            body: 'Beside [[birch]].',
            provenance: { body: 'inferred' },
          }),
        ),
        Effect.asVoid(
          writeEntry({
            type: 'note',
            title: 'Birch',
            body: 'Beside [[alder]].',
            provenance: { body: 'inferred' },
          }),
        ),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
    expect((await run(readEntry('alder'))).links.map(({ slug }) => slug)).toEqual(['birch'])
    expect((await run(readEntry('birch'))).links.map(({ slug }) => slug)).toEqual(['alder'])
  })

  test('an alias added while the same entry gets a body citing it: both written', async () => {
    await run(writeEntry({ type: 'note', title: 'Hornbeam' }))
    const ended = await run(
      whileLocked(holdingType, [
        Effect.asVoid(writeEntry({ entry: 'hornbeam', aliases: ['charmille'] })),
        Effect.asVoid(
          writeEntry({
            entry: 'hornbeam',
            body: 'Also [[charmille]].',
            provenance: { body: 'inferred' },
          }),
        ),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
  })

  test('a batch that leaves a body as it is, while the entry it cites is renamed: both written', async () => {
    await run(writeEntry({ type: 'note', title: 'Rowan' }))
    await run(
      writeEntry({
        type: 'note',
        title: 'Berries',
        body: 'Of [[rowan]].',
        provenance: { body: 'inferred' },
      }),
    )
    const ended = await run(
      whileLocked(holdingType, [
        Effect.asVoid(
          writeEntries([
            { entry: 'berries', summary: 'Red ones.', provenance: { summary: 'inferred' } },
          ]),
        ),
        Effect.asVoid(writeEntry({ entry: 'rowan', slug: 'rowan-tree' })),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
  })
})

describe('a batch takes every slug lock before any row lock', () => {
  // The new slug held: the single write waits for it before any row, the batch, without the
  // fix, only after the row of the entry it edits.
  const holdingSlug = execute(
    `SELECT pg_advisory_xact_lock(hashtext('hippocampe.reference wisteria'))`,
  )

  test('a batch that edits an entry and creates one, while a write of that entry cites the new one', async () => {
    await run(writeEntry({ type: 'note', title: 'Pergola' }))
    const ended = await run(
      whileLocked(holdingSlug, [
        Effect.asVoid(
          writeEntries([
            { entry: 'pergola', summary: 'Wood, painted.', provenance: { summary: 'inferred' } },
            { type: 'note', title: 'Wisteria' },
          ]),
        ),
        Effect.asVoid(
          writeEntry({
            entry: 'pergola',
            body: 'Under the [[wisteria]].',
            provenance: { body: 'inferred' },
          }),
        ),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
    expect((await run(readEntry('pergola'))).links.map(({ slug }) => slug)).toEqual(['wisteria'])
  })
})

describe('a rename locks every slug the stored body cites, before any row', () => {
  test('an entry renamed without a body, while another write holds a slug its body cites and waits for the entry', async () => {
    const elder = await run(
      writeEntry({
        type: 'note',
        title: 'Elder',
        body: 'About [[elder]] and [[hazel]].',
        provenance: { body: 'inferred' },
      }),
    )
    // The entry's row is held while both start. The rename queues for it first and, with the row,
    // wants `hazel`; the other write holds `hazel` as an alias and waits for the same row.
    const ended = await run(
      whileLocked(execute('SELECT 1 FROM entries WHERE id = $1::uuid FOR UPDATE', elder.id), [
        Effect.asVoid(writeEntry({ entry: elder.id, slug: 'elderberry' })),
        Effect.asVoid(writeEntry({ entry: elder.id, aliases: ['hazel'] })).pipe(
          Effect.delay('300 millis'),
        ),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
    expect((await run(readEntry('elderberry'))).entry).toMatchObject({
      body: 'About [[elderberry]] and [[hazel]].',
      aliases: ['hazel'],
    })
  })
})

describe('a batch that moves an entry takes the tree lock before its slug locks', () => {
  test('write_many moving an entry and citing a slug, while a write moves another and cites it too', async () => {
    await run(
      Effect.forEach(['Drawer', 'Shelf', 'Cabinet', 'Closet'], (title) =>
        writeEntry({ type: 'note', title }),
      ),
    )
    // The tree lock held while both start. The write that moves one entry queues for it first,
    // holding nothing; the batch, without the fix, takes `lichen` before it queues.
    const ended = await run(
      whileLocked(execute('SELECT pg_advisory_xact_lock($1::bigint)', String(TREE_LOCK)), [
        Effect.asVoid(
          writeEntry({
            entry: 'shelf',
            parent: 'closet',
            body: 'Grows [[lichen]].',
            provenance: { parent: 'inferred', body: 'inferred' },
          }),
        ),
        Effect.asVoid(
          writeEntries([
            {
              entry: 'drawer',
              parent: 'cabinet',
              body: 'Grows [[lichen]] too.',
              provenance: { parent: 'inferred', body: 'inferred' },
            },
          ]),
        ).pipe(Effect.delay('300 millis')),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
    expect((await run(readEntry('drawer'))).path).toEqual(['Cabinet'])
  })
})

describe('the rows of a batch are locked in one order', () => {
  test('two batches of the same entries in opposite orders are both written', async () => {
    await run(
      Effect.forEach(['Spade', 'Rake head'], (title) => writeEntry({ type: 'note', title })),
    )
    const holdingType = execute("SELECT 1 FROM types WHERE name = 'note' FOR UPDATE")
    const ended = await run(
      whileLocked(holdingType, [
        Effect.asVoid(
          writeEntries([
            { entry: 'spade', summary: 'Long handle.', provenance: { summary: 'inferred' } },
            { entry: 'rake-head', summary: 'Wide.', provenance: { summary: 'inferred' } },
          ]),
        ),
        Effect.asVoid(
          writeEntries([
            { entry: 'rake-head', summary: 'Wide, bent.', provenance: { summary: 'inferred' } },
            { entry: 'spade', summary: 'Long handle, split.', provenance: { summary: 'inferred' } },
          ]),
        ),
      ]),
    )
    expect(ended.map(outcomeOf)).toEqual(['written', 'written'])
  })
})

describe('a body sent as it is changes nothing it names', () => {
  test('a batch that sends a body unchanged does not wait for the slugs it cites', async () => {
    await run(
      writeEntry({
        type: 'note',
        title: 'Arbour',
        body: 'Beside the [[sundial]].',
        provenance: { body: 'inferred' },
      }),
    )
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const held = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        // Another transaction holds the slug the body cites, until the batch is done.
        const holder = yield* Effect.forkChild(
          sql.withTransaction(
            execute(`SELECT pg_advisory_xact_lock(hashtext('hippocampe.reference sundial'))`).pipe(
              Effect.andThen(Deferred.succeed(held, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
          ),
        )
        yield* Deferred.await(held)
        const written = yield* writeEntries([
          {
            entry: 'arbour',
            body: 'Beside the [[sundial]].',
            summary: 'Shady.',
            provenance: { body: 'inferred', summary: 'inferred' },
          },
        ]).pipe(
          Effect.timeout('3 seconds'),
          Effect.as('written'),
          Effect.catch(() => Effect.succeed('waited')),
        )
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)
        return written
      }),
    )
    expect(outcome).toBe('written')
  })
})

describe('several inbox items taken at once', () => {
  test('two agents taking the same items in two orders never wait for each other in a circle', async () => {
    const [a, b] = await run(
      Effect.forEach(['Mow.', 'Rake.'], (text) =>
        Effect.map(addToInbox({ kind: 'text', text }), ({ id }) => id),
      ),
    )
    const as = (actor: string) => Effect.provideService(Actor, actor)
    const ended = await run(
      whileLocked(execute('SELECT 1 FROM inbox WHERE id = $1::uuid FOR UPDATE', a ?? ''), [
        as('agent-one')(Effect.asVoid(takeItems([a ?? '', b ?? '']))),
        as('agent-two')(Effect.asVoid(takeItems([b ?? '', a ?? '']))),
      ]),
    )
    const outcomes = ended.map(outcomeOf)
    expect(outcomes.filter((outcome) => outcome === 'written')).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome !== 'written')).toMatch(/is taken by `agent-/)
  })

  test('an item named twice is refused', async () => {
    const id = await run(
      Effect.map(addToInbox({ kind: 'text', text: 'Sweep.' }), (item) => item.id),
    )
    const refused = await run(Effect.flip(takeItems([id, id])))
    expect(refused.message).toBe(`Give each item once: \`${id}\` comes twice.`)
  })

  test('an id in upper case takes its item and answers it; the same id in two cases is twice', async () => {
    const id = await run(
      Effect.map(addToInbox({ kind: 'text', text: 'Shout.' }), (item) => item.id),
    )
    const refused = await run(Effect.flip(takeItems([id, id.toUpperCase()])))
    expect(refused.message).toBe(`Give each item once: \`${id.toUpperCase()}\` comes twice.`)
    expect(await run(takeItems([id.toUpperCase()]))).toMatchObject([{ id, status: 'taken' }])
  })

  test('a long text is cut between characters, never inside one', async () => {
    const text = `${'a'.repeat(15_999)}😀b`
    const id = await run(Effect.map(addToInbox({ kind: 'text', text }), (item) => item.id))
    const first = await run(peekItem(id))
    expect(first.text?.endsWith('😀')).toBe(true)
    const rest = await run(readItem({ id, offset: first.next_offset ?? 0 }))
    expect(`${first.text}${rest.text}`).toBe(text)
  })
})
