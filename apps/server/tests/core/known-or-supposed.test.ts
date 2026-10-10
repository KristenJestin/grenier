import { HIDDEN } from '@hippocampe/api/model'
import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import {
  confirmValue,
  readEntry,
  supposedValues,
  writeEntries,
  writeEntry,
} from '../../src/core/entries/index.ts'
import { execute } from '../../src/core/database/contention.ts'
import { Actor, entryHistory } from '../../src/core/events/index.ts'
import { confirmLink, link, linksOf, backlinksOf } from '../../src/core/links/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { search } from '../../src/core/search/index.ts'
import { addField, changeField, defineType } from '../../src/core/types/index.ts'
import { useScratchDatabaseAs } from './scratch-database.ts'

const { run, as } = useScratchDatabaseAs()

const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

const asOwner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(
    Effect.provideService(effect, Rights, ['read', 'write', 'sensitive', 'owner']),
    Actor,
    'owner',
  )

const REQUIRED = (name: string, at = `fields.${name}`) =>
  `The field \`provenance.${name}\` is required with \`${at}\`: say \`extracted\` (known, read in a source), \`inferred\` (supposed by you) or \`ambiguous\` (sources disagree).`

beforeAll(() =>
  run(
    Effect.gen(function* () {
      yield* defineType({
        name: 'person',
        label: 'Person',
        description: 'A person.',
        fields: [{ name: 'phone', kind: 'text' }],
      })
      yield* defineType({
        name: 'visit',
        label: 'Visit',
        description: 'Where someone will be.',
        fields: [
          { name: 'place', kind: 'text' },
          { name: 'host', kind: 'entry' },
          { name: 'days', kind: 'integer' },
        ],
      })
      yield* defineType({
        name: 'diary',
        label: 'Diary',
        description: 'A private page.',
        fields: [],
        sensitive: true,
      })
      yield* writeEntry({ type: 'person', title: 'Marie Lund' })
      yield* writeEntry({ type: 'person', title: 'Owner Person' })
    }),
  ),
)

describe('provenance is required on every field value written', () => {
  test('a write setting a field without provenance is refused, naming the field', async () => {
    expect(
      await run(
        refusalOf(writeEntry({ type: 'visit', title: 'Dinner', fields: { place: 'Lyon' } })),
      ),
    ).toBe(REQUIRED('place'))
  })

  test('every field without one is named, in one refusal', async () => {
    expect(
      await run(
        refusalOf(
          writeEntry({
            type: 'visit',
            title: 'Dinner',
            fields: { place: 'Lyon', days: 2 },
            provenance: { days: null },
          }),
        ),
      ),
    ).toBe(`${REQUIRED('place')} ${REQUIRED('days')}`)
  })

  test('unstated is accepted when stored but never written', async () => {
    expect(
      await run(
        refusalOf(
          writeEntry({
            type: 'visit',
            title: 'Dinner',
            fields: { place: 'Lyon' },
            provenance: { place: 'unstated' },
          }),
        ),
      ),
    ).toBe(
      'The field `provenance.place` cannot be `unstated`: say `extracted`, `inferred` or `ambiguous`.',
    )
  })

  test('a value written again as it is stored needs no provenance, a changed one does', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Lunch',
        fields: { place: 'Lyon' },
        provenance: { place: 'inferred' },
      }),
    )
    const same = await run(writeEntry({ entry: 'lunch', fields: { place: 'Lyon' } }))
    expect(same.provenance).toEqual({ place: 'inferred' })
    expect(await run(refusalOf(writeEntry({ entry: 'lunch', fields: { place: 'Nice' } })))).toBe(
      REQUIRED('place'),
    )
  })

  test('a value removed takes its provenance with it', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Brunch',
        fields: { place: 'Lyon', days: 1 },
        provenance: { place: 'inferred', days: 'inferred' },
      }),
    )
    const removed = await run(writeEntry({ entry: 'brunch', fields: { days: null } }))
    expect(removed.fields).toEqual({ place: 'Lyon' })
    expect(removed.provenance).toEqual({ place: 'inferred' })
  })

  test('the references of a batch that wait for the second write say their provenance too', async () => {
    const written = await run(
      writeEntries([
        {
          type: 'visit',
          title: 'Tea one',
          fields: { host: 'tea-two' },
          provenance: { host: 'inferred' },
        },
        {
          type: 'visit',
          title: 'Tea two',
          fields: { host: 'tea-one' },
          provenance: { host: 'inferred' },
        },
      ]),
    )
    expect(written.map(({ provenance }) => provenance)).toEqual([
      { host: 'inferred' },
      { host: 'inferred' },
    ])
    expect(
      await run(
        refusalOf(
          writeEntries([
            { type: 'visit', title: 'Tea three', fields: { host: 'tea-four' } },
            { type: 'visit', title: 'Tea four', fields: { host: 'tea-three' } },
          ]),
        ),
      ),
    ).toContain(REQUIRED('host'))
  })
})

describe('a known value has a source', () => {
  test('a write giving extracted with no source on the entry is refused, naming the field', async () => {
    expect(
      await run(
        refusalOf(
          writeEntry({
            type: 'visit',
            title: 'Known dinner',
            fields: { place: 'Lyon' },
            provenance: { place: 'extracted' },
          }),
        ),
      ),
    ).toBe(
      'The field `provenance.place` is `extracted` but the entry has no source: give one in `sources` (what someone said is `{ "said_by": "<slug or id of a person>", "on": "2026-10-08" }`, what you did or saw yourself `{ "seen_by": "writer", "on": "2026-10-08" }`), or write it `inferred`.',
    )
  })

  test('the same write may give the source; inferred needs none', async () => {
    const known = await run(
      writeEntry({
        type: 'visit',
        title: 'Known lunch',
        fields: { place: 'Lyon' },
        provenance: { place: 'extracted' },
        sources: [{ url: 'https://example.org/invitation' }],
      }),
    )
    expect(known.provenance).toEqual({ place: 'extracted' })
    const supposed = await run(
      writeEntry({
        type: 'visit',
        title: 'Supposed lunch',
        fields: { place: 'Lyon' },
        provenance: { place: 'inferred' },
      }),
    )
    expect(supposed.sources).toEqual([])
  })

  test('a body or a summary that is extracted needs a source too', async () => {
    const refused = await run(
      refusalOf(
        writeEntry({
          type: 'visit',
          title: 'Known text',
          body: 'Said on the phone.',
          summary: 'A call.',
          provenance: { body: 'extracted', summary: 'extracted' },
        }),
      ),
    )
    expect(refused).toContain(
      'The field `provenance.body` is `extracted` but the entry has no source',
    )
    expect(refused).toContain(
      'The field `provenance.summary` is `extracted` but the entry has no source',
    )
  })

  test('sources taken away from an entry that holds a known value are refused', async () => {
    expect(await run(refusalOf(writeEntry({ entry: 'known-lunch', sources: [] })))).toContain(
      'The field `provenance.place` is `extracted` but the entry has no source',
    )
  })
})

describe('a source can name what a person said', () => {
  test('a source { said_by, on } naming an invented person is accepted, and read with their slug and title', async () => {
    const written = await run(
      writeEntry({
        type: 'visit',
        title: 'Said dinner',
        fields: { place: 'Annecy' },
        provenance: { place: 'extracted' },
        sources: [{ said_by: 'marie-lund', on: '2026-10-08', note: 'heard yesterday' }],
      }),
    )
    const marie = await run(readEntry('marie-lund'))
    const expected = [
      {
        said_by: marie.entry.id,
        slug: 'marie-lund',
        title: 'Marie Lund',
        on: '2026-10-08',
        note: 'heard yesterday',
      },
    ]
    expect(written.sources).toEqual(expected)
    expect((await run(readEntry('said-dinner'))).entry.sources).toEqual(expected)
    // The person lists what they said.
    expect(marie.cited_by).toEqual([{ id: written.id, slug: 'said-dinner', title: 'Said dinner' }])
  })

  test('a source naming no entry, or giving no day, is refused', async () => {
    expect(
      await run(
        refusalOf(
          writeEntry({
            type: 'visit',
            title: 'Nobody',
            sources: [{ said_by: 'nobody', on: '2026-10-08' }],
          }),
        ),
      ),
    ).toBe('The source `sources.0` names `nobody`, which is not an entry.')
    expect(
      await run(
        refusalOf(
          writeEntry({
            type: 'visit',
            title: 'Never',
            sources: [{ said_by: 'marie-lund', on: 'yesterday' }],
          }),
        ),
      ),
    ).toBe(
      'The source `sources.0` needs `on`, the day it was said, such as `2026-10-08`: `yesterday` is not a date.',
    )
  })

  test('a person of a sensitive type does not exist to a key without the right, and shows as hidden to it', async () => {
    await run(writeEntry({ type: 'diary', title: 'Confidant' }))
    await run(
      writeEntry({
        type: 'visit',
        title: 'Told in private',
        sources: [{ said_by: 'confidant', on: '2026-10-08' }],
      }),
    )
    expect(
      await as(['read', 'write'])(
        refusalOf(
          writeEntry({
            type: 'visit',
            title: 'Told again',
            sources: [{ said_by: 'confidant', on: '2026-10-08' }],
          }),
        ),
      ),
    ).toBe('The source `sources.0` names `confidant`, which is not an entry.')
    const seen = await as(['read'])(readEntry('told-in-private'))
    expect(seen.entry.sources).toEqual([
      { said_by: HIDDEN, slug: HIDDEN, title: HIDDEN, on: '2026-10-08' },
    ])
    // Written back as read, the hidden source stays.
    await as(['read', 'write'])(
      writeEntry({
        entry: 'told-in-private',
        sources: [{ said_by: HIDDEN, on: '2026-10-08' }, { url: 'https://example.org/news' }],
      }),
    )
    expect((await run(readEntry('told-in-private'))).entry.sources).toHaveLength(2)
  })
})

describe('links carry their certainty', () => {
  test('a link is read with its provenance on both ends', async () => {
    await run(link('marie-lund', 'said-dinner', 'invited_to', '', '', { provenance: 'inferred' }))
    expect((await run(linksOf('marie-lund')))[0]).toMatchObject({
      relation: 'invited_to',
      provenance: 'inferred',
    })
    expect((await run(backlinksOf('said-dinner')))[0]).toMatchObject({
      relation: 'invited_to',
      provenance: 'inferred',
    })
  })

  test('linking again with another provenance changes it, in one event', async () => {
    await run(link('marie-lund', 'said-dinner', 'invited_to', '', '', { provenance: 'inferred' }))
    const before = (await run(entryHistory('marie-lund'))).length
    await run(writeEntry({ entry: 'marie-lund', sources: [{ url: 'https://example.org/guests' }] }))
    await run(link('marie-lund', 'said-dinner', 'invited_to', '', '', { provenance: 'extracted' }))
    const events = await run(entryHistory('marie-lund'))
    expect(events).toHaveLength(before + 2)
    expect(events.at(-1)).toMatchObject({
      action: 'link',
      changes: [
        {
          field: 'links.invited_to',
          before: { provenance: 'inferred' },
          after: { provenance: 'extracted' },
        },
      ],
    })
  })

  test('a link that is extracted needs a source on its entry', async () => {
    expect(
      await run(
        refusalOf(
          link('owner-person', 'said-dinner', 'invited_to', '', '', { provenance: 'extracted' }),
        ),
      ),
    ).toBe(
      'The link `invited_to` is `extracted` but `owner-person` has no source: give the entry one in `sources` (what someone said is `{ "said_by": "<slug or id of a person>", "on": "2026-10-08" }`, what you did or saw yourself `{ "seen_by": "writer", "on": "2026-10-08" }`), or link it `inferred`.',
    )
  })

  test('the mentions of a body take the provenance of the body', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Plan with a mention',
        body: 'Probably at [[marie-lund]].',
        provenance: { body: 'inferred' },
      }),
    )
    const mention = async () =>
      (await run(linksOf('plan-with-a-mention'))).find(({ relation }) => relation === 'mentions')
    expect(await mention()).toMatchObject({ provenance: 'inferred', slug: 'marie-lund' })
    expect(
      (await run(backlinksOf('marie-lund'))).find(({ slug }) => slug === 'plan-with-a-mention'),
    ).toMatchObject({
      provenance: 'inferred',
    })
    await run(
      writeEntry({
        entry: 'plan-with-a-mention',
        provenance: { body: 'extracted' },
        sources: [{ said_by: 'marie-lund', on: '2026-10-08' }],
      }),
    )
    expect(await mention()).toMatchObject({ provenance: 'extracted' })
  })
})

describe('the body and the summary say theirs', () => {
  test('a write of a body or a summary without its provenance is refused', async () => {
    expect(
      await run(refusalOf(writeEntry({ type: 'visit', title: 'Body only', body: 'Some text.' }))),
    ).toBe(REQUIRED('body', 'body'))
    expect(
      await run(
        refusalOf(writeEntry({ type: 'visit', title: 'Summary only', summary: 'A visit.' })),
      ),
    ).toBe(REQUIRED('summary', 'summary'))
  })

  test('a part appended, prepended or edited is a body written', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Journal',
        body: 'One.\n',
        provenance: { body: 'inferred' },
      }),
    )
    const refused = await Promise.all(
      [
        { body: 'Two.\n', append: true },
        { body: 'Zero.\n', prepend: true },
        { edits: [{ find: 'One', replace: 'Uno' }] },
      ].map((input) => run(refusalOf(writeEntry({ entry: 'journal', ...input })))),
    )
    expect(refused).toEqual(Array.from({ length: 3 }, () => REQUIRED('body', 'body')))
  })

  test('a body emptied takes its provenance with it', async () => {
    const emptied = await run(writeEntry({ entry: 'journal', body: '' }))
    expect(emptied.provenance).toEqual({})
  })
})

describe('the owner confirms a supposition', () => {
  test('an inferred field is listed, then confirmed: extracted, said by the person, one event, gone from the list', async () => {
    await as(['read', 'write'])(
      Effect.provideService(
        writeEntry({
          type: 'visit',
          title: 'Dinner next week',
          fields: { place: 'Annecy' },
          provenance: { place: 'inferred' },
        }),
        Actor,
        'agent-listener',
      ),
    )
    const listed = await run(supposedValues({ type: 'visit', by: 'agent-listener' }))
    expect(listed).toEqual([
      expect.objectContaining({
        slug: 'dinner-next-week',
        what: 'place',
        provenance: 'inferred',
        by: 'agent-listener',
        when: expect.any(String),
      }),
    ])
    const before = (await run(entryHistory('dinner-next-week'))).length
    const confirmed = await run(asOwner(confirmValue('dinner-next-week', 'place', 'owner-person')))
    const today = confirmed.sources.flatMap((source) => ('on' in source ? [source.on] : []))
    expect(confirmed.provenance).toEqual({ place: 'extracted' })
    expect(confirmed.sources).toEqual([
      expect.objectContaining({ slug: 'owner-person', on: today[0] }),
    ])
    expect(today[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const events = await run(entryHistory('dinner-next-week'))
    expect(events).toHaveLength(before + 1)
    expect(events.at(-1)).toMatchObject({ actor: 'owner', action: 'update' })
    expect(await run(supposedValues({ by: 'agent-listener' }))).toEqual([])
  })

  test('an agent writing it again as extracted with said_by the owner gives the same result', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Dinner after',
        fields: { place: 'Annecy' },
        provenance: { place: 'inferred' },
      }),
    )
    const said = await run(
      writeEntry({
        entry: 'dinner-after',
        fields: { place: 'Annecy' },
        provenance: { place: 'extracted' },
        sources: [{ said_by: 'owner-person', on: '2026-10-09' }],
      }),
    )
    const confirmed = await run(readEntry('dinner-next-week'))
    expect(said.provenance).toEqual(confirmed.entry.provenance)
    const saidBy = (entry: { readonly sources: ReadonlyArray<object> }) =>
      entry.sources.map((source) => ('slug' in source ? source.slug : undefined))
    expect(saidBy(said)).toEqual(saidBy(confirmed.entry))
    expect((await run(supposedValues({}))).filter(({ slug }) => slug === 'dinner-after')).toEqual(
      [],
    )
  })

  test('the body and the summary are confirmed as a field is', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Supposed text',
        body: 'Probably Lyon.',
        summary: 'A guess.',
        provenance: { body: 'inferred', summary: 'inferred' },
      }),
    )
    await run(asOwner(confirmValue('supposed-text', 'body', 'owner-person')))
    const after = await run(readEntry('supposed-text'))
    expect(after.entry.provenance).toEqual({ body: 'extracted', summary: 'inferred' })
    expect(
      (await run(supposedValues({})))
        .filter(({ slug }) => slug === 'supposed-text')
        .map(({ what }) => what),
    ).toEqual(['summary'])
  })

  test('a link is confirmed with the source on its entry, in one event', async () => {
    await run(
      link('owner-person', 'dinner-after', 'invited_to', '', '', { provenance: 'inferred' }),
    )
    const before = (await run(entryHistory('owner-person'))).length
    await run(asOwner(confirmLink('owner-person', 'invited_to', 'dinner-after', 'owner-person')))
    expect((await run(linksOf('owner-person')))[0]).toMatchObject({ provenance: 'extracted' })
    expect((await run(readEntry('owner-person'))).entry.sources).toHaveLength(1)
    expect(await run(entryHistory('owner-person'))).toHaveLength(before + 1)
  })

  test('only the owner confirms, and what is known already cannot be', async () => {
    expect(await run(refusalOf(confirmValue('supposed-text', 'summary', 'owner-person')))).toBe(
      'Only the owner of Hippocampe may confirm a supposition, from the command line.',
    )
    expect(
      await run(refusalOf(asOwner(confirmValue('supposed-text', 'body', 'owner-person')))),
    ).toBe('The `body` of `supposed-text` is known already (`extracted`).')
  })

  test('a supposition about a field of the type is found by the search that lists them, with what and who', async () => {
    const found = await run(search(undefined, { supposed: true, type: 'visit' }))
    const dinner = found.find(({ slug }) => slug === 'supposed-text')
    expect(dinner).toMatchObject({
      summary_provenance: 'inferred',
      supposed: [{ what: 'summary', by: 'test-suite' }],
    })
    expect(found.map(({ slug }) => slug)).not.toContain('dinner-next-week')
  })
})

describe('the names of the body and the summary are the keys of their provenance', () => {
  test('a field is not named body or summary', async () => {
    expect(
      await run(
        refusalOf(
          defineType({
            name: 'recipe',
            label: 'Recipe',
            description: 'A dish.',
            fields: [{ name: 'summary', kind: 'text' }],
          }),
        ),
      ),
    ).toBe(
      'The field `summary` cannot be named so: `body` and `summary` are the body and the summary of every entry, and the keys of their `provenance`. Choose another name.',
    )
    expect(await run(refusalOf(addField('person', { name: 'body', kind: 'text' })))).toContain(
      'The field `body` cannot be named so',
    )
    expect(
      await run(refusalOf(changeField({ type: 'person', field: 'phone', rename: 'summary' }))),
    ).toContain('The field `summary` cannot be named so')
  })
})

describe('a part added to a body does not make the whole body known', () => {
  const source = [{ url: 'https://example.org/minutes' }]
  const bodyOf = async (slug: string) => (await run(readEntry(slug))).entry.provenance['body']

  test('an extracted part appended to an inferred body leaves the body inferred', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Guessed minutes',
        body: 'Probably Lyon.\n',
        provenance: { body: 'inferred' },
      }),
    )
    await run(
      writeEntry({
        entry: 'guessed-minutes',
        body: 'Confirmed by phone.\n',
        append: true,
        provenance: { body: 'extracted' },
        sources: source,
      }),
    )
    expect(await bodyOf('guessed-minutes')).toBe('inferred')
  })

  test('the same through prepend and through edits', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Guessed notes',
        body: 'Probably Lyon.\n',
        provenance: { body: 'inferred' },
      }),
    )
    await run(
      writeEntry({
        entry: 'guessed-notes',
        body: 'Said on the phone.\n',
        prepend: true,
        provenance: { body: 'extracted' },
        sources: source,
      }),
    )
    expect(await bodyOf('guessed-notes')).toBe('inferred')
    await run(
      writeEntry({
        entry: 'guessed-notes',
        edits: [{ find: 'Lyon', replace: 'Annecy' }],
        provenance: { body: 'extracted' },
      }),
    )
    expect(await bodyOf('guessed-notes')).toBe('inferred')
  })

  test('the body stays extracted only when the old and the new provenance both are', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Known minutes',
        body: 'Said on the phone.\n',
        provenance: { body: 'extracted' },
        sources: source,
      }),
    )
    await run(
      writeEntry({
        entry: 'known-minutes',
        body: 'Said again.\n',
        append: true,
        provenance: { body: 'extracted' },
      }),
    )
    expect(await bodyOf('known-minutes')).toBe('extracted')
    await run(
      writeEntry({
        entry: 'known-minutes',
        body: 'Perhaps by mail.\n',
        append: true,
        provenance: { body: 'inferred' },
      }),
    )
    expect(await bodyOf('known-minutes')).toBe('inferred')
  })

  test('either provenance ambiguous makes the body ambiguous', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Disputed minutes',
        body: 'Said on the phone.\n',
        provenance: { body: 'extracted' },
        sources: source,
      }),
    )
    await run(
      writeEntry({
        entry: 'disputed-minutes',
        body: 'Another version.\n',
        append: true,
        provenance: { body: 'ambiguous' },
      }),
    )
    expect(await bodyOf('disputed-minutes')).toBe('ambiguous')
    await run(
      writeEntry({
        entry: 'disputed-minutes',
        body: 'Said once more.\n',
        append: true,
        provenance: { body: 'extracted' },
      }),
    )
    expect(await bodyOf('disputed-minutes')).toBe('ambiguous')
  })

  test('an unstated body with an extracted part is inferred: what the old part was cannot be known', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Old minutes',
        body: 'Written before.\n',
        provenance: { body: 'inferred' },
      }),
    )
    await run(
      execute(
        `UPDATE entries SET provenance = jsonb_set(provenance, '{body}', '"unstated"') WHERE slug = $1`,
        'old-minutes',
      ),
    )
    await run(
      writeEntry({
        entry: 'old-minutes',
        body: 'Heard today.\n',
        append: true,
        provenance: { body: 'extracted' },
        sources: source,
      }),
    )
    expect(await bodyOf('old-minutes')).toBe('inferred')
  })

  test('a body written whole again takes the provenance given', async () => {
    await run(
      writeEntry({
        entry: 'guessed-minutes',
        body: 'All of it said on the phone.\n',
        provenance: { body: 'extracted' },
      }),
    )
    expect(await bodyOf('guessed-minutes')).toBe('extracted')
  })
})

describe('a field sent again in any accepted form needs no provenance', () => {
  test('an entry field named by its slug, then by its id, unchanged', async () => {
    const marie = await run(readEntry('marie-lund'))
    await run(
      writeEntry({
        type: 'visit',
        title: 'Hosted tea',
        fields: { host: 'marie-lund' },
        provenance: { host: 'inferred' },
      }),
    )
    const bySlug = await run(writeEntry({ entry: 'hosted-tea', fields: { host: 'marie-lund' } }))
    const byId = await run(writeEntry({ entry: 'hosted-tea', fields: { host: marie.entry.id } }))
    expect(bySlug.provenance).toEqual({ host: 'inferred' })
    expect(byId.fields).toEqual({ host: marie.entry.id })
    expect(await run(entryHistory('hosted-tea'))).toHaveLength(1)
  })
})

describe('sources sent unchanged', () => {
  test('sources: [] on a legacy entry holding an extracted value without a source is accepted', async () => {
    await run(
      writeEntry({
        type: 'visit',
        title: 'Legacy tea',
        fields: { place: 'Lyon' },
        provenance: { place: 'inferred' },
      }),
    )
    await run(
      execute(
        `UPDATE entries SET provenance = '{"place": "extracted"}' WHERE slug = $1`,
        'legacy-tea',
      ),
    )
    const written = await run(writeEntry({ entry: 'legacy-tea', sources: [] }))
    expect(written.provenance).toEqual({ place: 'extracted' })
  })
})

describe('a refused source is said once', () => {
  test('a said_by naming no entry does not add that the entry has no source', async () => {
    const refusal = await run(
      refusalOf(
        writeEntries([
          {
            type: 'visit',
            title: 'Told by nobody',
            fields: { place: 'Lyon' },
            provenance: { place: 'extracted' },
            sources: [{ said_by: 'nobody', on: '2026-10-08' }],
          },
        ]),
      ),
    )
    expect(refusal).toBe(
      'Entry 1 (`Told by nobody`): The source `sources.0` names `nobody`, which is not an entry.',
    )
  })
})

describe('the owner confirms a link in one write of the entry', () => {
  test('the entry is updated by the owner, in one event', async () => {
    await run(writeEntry({ type: 'visit', title: 'Confirmed outing' }))
    await run(writeEntry({ type: 'visit', title: 'Outing target' }))
    await run(
      link('confirmed-outing', 'outing-target', 'goes_to', '', '', { provenance: 'inferred' }),
    )
    const before = await run(readEntry('confirmed-outing'))
    const events = (await run(entryHistory('confirmed-outing'))).length
    await run(asOwner(confirmLink('confirmed-outing', 'goes_to', 'outing-target', 'owner-person')))
    const after = await run(readEntry('confirmed-outing'))
    expect(after.entry.updated > before.entry.updated).toBe(true)
    const history = await run(entryHistory('confirmed-outing'))
    expect(history).toHaveLength(events + 1)
    expect(history.at(-1)).toMatchObject({ actor: 'owner', action: 'update' })
    const found = await run(search(undefined, { limit: 100 }))
    expect(found.find(({ slug }) => slug === 'confirmed-outing')?.by).toBe('owner')
  })
})

describe('confirming a link', () => {
  test('a mention takes the provenance of its body: confirm the body', async () => {
    expect(
      await run(
        refusalOf(
          asOwner(confirmLink('plan-with-a-mention', 'mentions', 'marie-lund', 'owner-person')),
        ),
      ),
    ).toBe('A mention takes the provenance of its body: confirm the `body`.')
  })

  test('several supposed links of a relation are listed, and one is chosen by period and field', async () => {
    await run(
      defineType({
        name: 'bill',
        label: 'Bill',
        description: 'A bill that comes back every year.',
        fields: [{ name: 'due_on', kind: 'date', recurs: { every: 'yearly', notice: 'P7D' } }],
      }),
    )
    await run(
      writeEntry({
        type: 'bill',
        title: 'Water bill',
        fields: { due_on: '2025-03-01' },
        provenance: { due_on: 'inferred' },
      }),
    )
    await run(writeEntry({ type: 'visit', title: 'Water payment' }))
    await run(
      Effect.forEach(['2025', '2026'], (period) =>
        link('water-payment', 'water-bill', 'fulfills', period, 'due_on', {
          provenance: 'inferred',
        }),
      ),
    )
    expect(
      await run(
        refusalOf(asOwner(confirmLink('water-payment', 'fulfills', 'water-bill', 'owner-person'))),
      ),
    ).toBe(
      'Several links `fulfills` from `water-payment` to `water-bill` are supposed: say which with `--period` and `--field`: period `2025` field `due_on`; period `2026` field `due_on`.',
    )
    await run(
      asOwner(
        confirmLink('water-payment', 'fulfills', 'water-bill', 'owner-person', {
          period: '2026',
          field: 'due_on',
        }),
      ),
    )
    const links = await run(linksOf('water-payment'))
    expect(links.map(({ period, provenance }) => [period, provenance]).toSorted()).toEqual([
      ['2025', 'inferred'],
      ['2026', 'extracted'],
    ])
  })
})
