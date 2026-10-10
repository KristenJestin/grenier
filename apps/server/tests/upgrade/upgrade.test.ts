import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Auth, Rights } from '../../src/core/auth/index.ts'
import type { Right } from '../../src/core/auth/index.ts'
import { readEntry, supposedValues, writeEntry } from '../../src/core/entries/index.ts'
import { Actor, entryHistory } from '../../src/core/events/index.ts'
import { findingsWithOccurrences } from '../../src/core/findings/index.ts'
import { listInbox } from '../../src/core/inbox/index.ts'
import { pendingReferences } from '../../src/core/links/index.ts'
import { attachMedia, readMedia } from '../../src/core/media/index.ts'
import { instanceRulesText } from '../../src/core/rules.ts'
import { search } from '../../src/core/search/index.ts'
import { rowCounts, scratchDatabaseFrom } from '../../src/core/testing.ts'
import { listProposals, listTypes } from '../../src/core/types/index.ts'

/**
 * The releases whose fixture `make-fixture.ts` made, each with that release's own code (0.5.0
 * writing first, as on an installation made before 0.6.0): the data of each must read the same
 * after the migrations of this version. The fixtures hold the same invented data, so the
 * expectations below are those of every one of them.
 */
const FIXTURES = ['0.6.0']

/** The secret the fixtures' keys were made with, invented for them (see `make-fixture.ts`). */
const AUTH_SECRET = 'fixture-secret-of-an-invented-database-0001'

/** The slugs of every entry the fixture holds, the archived one included. */
const SLUGS = [
  'alma-quillon',
  'atlas-of-rivers',
  'bike-pump',
  'bluebell-energy',
  'bruno-tessaly',
  'electricity-renewal-2025',
  'field-guide-to-moths',
  'garage',
  'garden-plan',
  'garden-plan-2025',
  'garden-shed',
  'home-electricity',
  'journal-2026-09-30',
  'lakeside-library',
  'lawn-mower',
  'living-room',
  'morgan-vale',
  'northwind-hardware',
  'old-radio',
  'pocket-torch',
  'shed-door',
  'workshop-computer',
  'workshop-computer-disk',
]

describe.each(FIXTURES)(
  'the data of Hippocampe %s, after the migrations of this version',
  (version) => {
    const folder = new URL(`${version}/`, import.meta.url).pathname
    const media = mkdtempSync(join(tmpdir(), 'hippocampe-upgrade-'))
    // The media are copied: a write of the suite never touches the fixture.
    cpSync(join(folder, 'media'), media, { recursive: true })
    const settings = ConfigProvider.layer(
      ConfigProvider.fromUnknown({ MEDIA_DIR: media, BETTER_AUTH_SECRET: AUTH_SECRET }),
    )
    const suite = Layer.mergeAll(
      Auth.layer.pipe(Layer.provide(settings)),
      Layer.succeed(Actor, 'agent-after-update'),
      Layer.succeed(Rights, ['read', 'write', 'sensitive']),
    ).pipe(
      Layer.provideMerge(scratchDatabaseFrom(readFileSync(join(folder, 'database.sql'), 'utf8'))),
    )
    type Suite = Layer.Success<typeof suite>
    const runtime = ManagedRuntime.make(suite)
    const run = <A, E>(effect: Effect.Effect<A, E, Suite>) =>
      runtime.runPromise(Effect.provide(effect, settings))
    const as =
      (rights: ReadonlyArray<Right>) =>
      <A, E>(effect: Effect.Effect<A, E, Suite>) =>
        run(Effect.provideService(effect, Rights, rights))

    /** The id of each entry, by slug, as the loaded database gives it. */
    const ids = new Map<string, string>()
    const id = (slug: string) => ids.get(slug) ?? `no entry ${slug}`
    const read = (slug: string) => run(readEntry(slug))

    beforeAll(async () => {
      const entries = await Promise.all(SLUGS.map(read))
      for (const { entry } of entries) ids.set(entry.slug, entry.id)
    })
    afterAll(async () => {
      await runtime.dispose()
      rmSync(media, { recursive: true, force: true })
    })

    test('every table keeps its rows', async () => {
      expect(await run(rowCounts)).toMatchObject({
        'drizzle.__drizzle_migrations': expect.any(Number),
        'public.auth_apikey': 5,
        'public.auth_user': 1,
        'public.entries': 23,
        'public.events': 72,
        'public.finding_occurrences': 3,
        'public.findings': 2,
        'public.heads_up': 2,
        'public.inbox': 4,
        'public.instance_rules': 1,
        'public.links': 18,
        'public.media': 3,
        'public.pending_references': 1,
        'public.type_proposals': 2,
        'public.types': 10,
      })
    })

    test('every entry reads with its type, title, fields, and whether each value is known or supposed', async () => {
      const said = (slug: string, on: string) => ({
        said_by: id(slug),
        on,
        slug,
        title: expect.any(String),
      })
      const expected = {
        'morgan-vale': {
          type: 'person',
          title: 'Morgan Vale',
          fields: {},
          summary: 'The owner of this Hippocampe.',
          provenance: { summary: 'inferred' },
        },
        'northwind-hardware': {
          type: 'organization',
          title: 'Northwind Hardware',
          fields: { website: 'https://northwind.example', city: 'Port Alder' },
          provenance: { website: 'extracted', city: 'extracted' },
          sources: [{ url: 'https://northwind.example/contact', note: 'the contact page' }],
          tags: ['shop'],
        },
        'bluebell-energy': {
          type: 'organization',
          title: 'Bluebell Energy',
          fields: { website: 'https://bluebell.example' },
          provenance: { website: 'inferred' },
        },
        'lakeside-library': {
          type: 'organization',
          title: 'Lakeside Library',
          fields: { city: 'Port Alder' },
          provenance: { city: 'ambiguous' },
        },
        'alma-quillon': {
          type: 'person',
          title: 'Alma Quillon',
          fields: {
            email: 'alma@example.org',
            birthday: '1990-04-21',
            employer: id('northwind-hardware'),
            languages: ['English', 'Portuguese'],
          },
          provenance: {
            email: 'extracted',
            birthday: 'extracted',
            employer: 'extracted',
            languages: 'inferred',
            body: 'extracted',
          },
          sources: [{ ...said('morgan-vale', '2026-09-01'), note: 'at the hardware shop' }],
          body: 'Met at [[northwind-hardware]]. Lends tools.',
          aliases: ['Alma Q.'],
        },
        'bruno-tessaly': {
          type: 'person',
          title: 'Bruno Tessaly',
          fields: { employer: id('bluebell-energy') },
          // Supposed when written, then confirmed by the owner from the command line.
          provenance: { employer: 'extracted' },
          sources: [said('morgan-vale', expect.any(String))],
        },
        'garden-shed': {
          type: 'note',
          title: 'Garden shed',
          body: 'The wooden shed at the end of the garden.',
          provenance: { body: 'extracted' },
          sources: [said('morgan-vale', '2026-09-02')],
        },
        garage: {
          type: 'note',
          title: 'Garage',
          body: 'Beside the house.',
          provenance: { body: 'inferred' },
        },
        'workshop-computer': {
          type: 'item',
          title: 'Workshop computer',
          fields: {
            brand: 'Corvid',
            serial: 'CV-1029-XA',
            price: '849.00 EUR',
            bought_on: '2024-02-14',
            warranty_until: '2027-02-14',
            sellers: [id('northwind-hardware'), id('lakeside-library')],
            power_w: 350,
            weight_kg: 7.5,
            portable: false,
            condition: 'worn',
          },
          provenance: {
            brand: 'extracted',
            serial: 'extracted',
            price: 'extracted',
            bought_on: 'ambiguous',
            warranty_until: 'extracted',
            sellers: 'inferred',
            power_w: 'extracted',
            weight_kg: 'inferred',
            portable: 'inferred',
            condition: 'inferred',
            body: 'inferred',
          },
          sources: [{ identifier: 'INV-0042', label: 'invoice', note: 'the invoice' }],
          body: 'Under the left workbench. Probably needs a new fan.The fan was replaced in October.',
          tags: ['workshop', 'computer'],
        },
        'workshop-computer-disk': {
          type: 'item',
          title: 'Workshop computer disk',
          fields: { brand: 'Petrel', serial: 'PT-77-0031' },
          provenance: { brand: 'extracted', serial: 'extracted' },
          sources: [
            {
              entry: id('workshop-computer'),
              note: 'listed on its invoice',
              slug: 'workshop-computer',
              title: 'Workshop computer',
            },
          ],
        },
        'lawn-mower': {
          type: 'item',
          title: 'Lawn mower',
          fields: { brand: 'Greenfinch', condition: 'worn', portable: true },
          provenance: { brand: 'inferred', condition: 'inferred', portable: 'inferred' },
          sources: [{ source: 'inbox', item: expect.any(String) }],
        },
        'bike-pump': {
          type: 'item',
          title: 'Bike pump',
          fields: { brand: 'Swiftair' },
          provenance: { brand: 'inferred' },
        },
        'old-radio': {
          type: 'item',
          title: 'Old radio',
          fields: { brand: 'Halcyon' },
          provenance: { brand: 'inferred' },
          archived_at: expect.any(String),
          archived_reason: 'given to a neighbour',
        },
        'home-electricity': {
          type: 'contract',
          title: 'Home electricity',
          fields: {
            provider: id('bluebell-energy'),
            monthly_cost: '64.20 EUR',
            renewal: '2025-11-01',
            notice_period: 'P1M',
            signed_at: '2024-10-15T09:30:00Z',
            account_number: 'ACC-5521',
          },
          provenance: {
            provider: 'extracted',
            monthly_cost: 'extracted',
            renewal: 'extracted',
            notice_period: 'extracted',
            signed_at: 'extracted',
            account_number: 'extracted',
          },
          sources: [{ url: 'https://bluebell.example/account', note: 'the customer account' }],
          valid_from: '2024-11-01',
          valid_until: null,
        },
        'journal-2026-09-30': {
          type: 'journal',
          title: 'Journal, 30 September',
          fields: { mood: 'calm' },
          provenance: { mood: 'extracted', body: 'extracted' },
          sources: [said('morgan-vale', '2026-09-30')],
          body: 'A quiet day in the garden; the mower is getting old.',
        },
        // A gadget, merged into the items by the owner.
        'pocket-torch': {
          type: 'item',
          title: 'Pocket torch',
          fields: { brand: 'Lumen' },
          provenance: { brand: 'inferred' },
        },
        'garden-plan-2025': {
          type: 'note',
          title: 'Garden plan 2025',
          body: 'Tomatoes along the fence.',
          provenance: { body: 'extracted' },
          sources: [said('morgan-vale', '2025-02-01')],
          created: '2025-02-01T00:00:00.000Z',
          superseded_by: id('garden-plan'),
        },
        // Written as `garden-plans`, then renamed.
        'garden-plan': {
          type: 'note',
          title: 'Garden plans',
          body: 'Started on 1 March.\n\nBeans by the [[garden-shed]], an [[herb-spiral]] by the path; mow with the [[lawn-mower]].',
          provenance: { body: 'inferred', summary: 'inferred' },
          summary: 'What grows where this year.',
          aliases: ['Vegetable plan'],
          tags: ['garden'],
          valid_from: '2026-03-01',
          valid_until: '2026-11-30',
        },
        'electricity-renewal-2025': {
          type: 'note',
          title: 'Electricity renewal 2025',
          body: 'Renewed for a year.',
          provenance: { body: 'extracted' },
          sources: [said('morgan-vale', '2025-10-20')],
        },
        'shed-door': {
          type: 'note',
          title: 'Shed door',
          body: 'The hinges need oil.',
          provenance: { body: 'extracted' },
          sources: [{ source: 'inbox', item: expect.any(String) }],
        },
        // Written by 0.5.0, before writers were asked.
        'living-room': {
          type: 'room',
          title: 'Living room',
          fields: {},
          body: 'Two bookcases by the window.',
          summary: 'The room with the books.',
          provenance: { body: 'unstated', summary: 'unstated' },
        },
        'atlas-of-rivers': {
          type: 'book',
          title: 'Atlas of rivers',
          fields: { publisher: 'Riverbend Press', pages: 212, shelf: 'top' },
          body: 'Bought second-hand; read with the [[field-guide-to-moths]].',
          provenance: {
            publisher: 'unstated',
            pages: 'unstated',
            shelf: 'unstated',
            body: 'unstated',
          },
        },
        // The one value 0.5.0 was told the provenance of keeps it.
        'field-guide-to-moths': {
          type: 'book',
          title: 'Field guide to moths',
          fields: { publisher: 'Lantern Press', pages: 96 },
          provenance: { publisher: 'unstated', pages: 'inferred' },
        },
      }
      expect(Object.keys(expected).toSorted()).toEqual(SLUGS)
      const entries = await Promise.all(SLUGS.map(read))
      expect(Object.fromEntries(entries.map(({ entry }) => [entry.slug, entry]))).toMatchObject(
        expected,
      )
    })

    test('links keep their relation, provenance, note and dates, each way', async () => {
      const link = (
        slug: string,
        relation: string,
        more: Readonly<Record<string, string | null>> = {},
      ) => ({
        slug,
        relation,
        period: null,
        field: null,
        note: null,
        valid_from: null,
        valid_until: null,
        ...more,
      })
      const alma = await read('alma-quillon')
      expect(alma.links).toEqual([
        expect.objectContaining(link('bruno-tessaly', 'knows', { provenance: 'inferred' })),
        expect.objectContaining(
          link('northwind-hardware', 'mentions', { provenance: 'extracted' }),
        ),
        expect.objectContaining(
          link('northwind-hardware', 'works_at', {
            provenance: 'extracted',
            note: 'cashier',
            valid_from: '2019-03-01',
            valid_until: '2021-08-31',
          }),
        ),
      ])
      // Supposed when written, then confirmed by the owner.
      expect((await read('bruno-tessaly')).links).toEqual([
        expect.objectContaining(
          link('bluebell-energy', 'works_at', {
            provenance: 'extracted',
            note: 'meter reader',
            valid_from: '2022-05-01',
          }),
        ),
      ])
      expect((await read('northwind-hardware')).backlinks).toEqual([
        expect.objectContaining(
          link('lawn-mower', 'bought_from', { provenance: 'inferred', note: 'spring sale' }),
        ),
        expect.objectContaining(link('alma-quillon', 'mentions', { provenance: 'extracted' })),
        expect.objectContaining(
          link('alma-quillon', 'works_at', {
            provenance: 'extracted',
            note: 'cashier',
            valid_from: '2019-03-01',
            valid_until: '2021-08-31',
          }),
        ),
      ])
      expect((await read('home-electricity')).backlinks).toEqual([
        expect.objectContaining(
          link('electricity-renewal-2025', 'fulfills', {
            provenance: 'extracted',
            period: '2025',
            field: 'renewal',
          }),
        ),
      ])
      // The link `about` was made, then removed: only the mentions of the body are left.
      expect((await read('garden-plan')).links).toEqual([
        expect.objectContaining(link('garden-shed', 'mentions', { provenance: 'inferred' })),
        expect.objectContaining(link('lawn-mower', 'mentions', { provenance: 'inferred' })),
      ])
      expect((await read('garden-plan')).references).toEqual([
        expect.objectContaining({ reference: 'garden-shed', id: id('garden-shed') }),
        { reference: 'herb-spiral', id: null, title: null },
        expect.objectContaining({ reference: 'lawn-mower', id: id('lawn-mower') }),
      ])
      expect(await run(pendingReferences)).toEqual([
        { slug: 'herb-spiral', cited_by: [expect.objectContaining({ slug: 'garden-plan' })] },
      ])
    })

    test('parts and places: the tree today, the parts read in their whole, the stays that are over', async () => {
      const computer = await read('workshop-computer')
      expect(computer.children).toEqual([
        expect.objectContaining({
          slug: 'workshop-computer-disk',
          in_parent: true,
          fields: { brand: 'Petrel', serial: 'PT-77-0031' },
        }),
      ])
      expect((await read('workshop-computer-disk')).path).toEqual(['Workshop computer'])
      const shed = await read('garden-shed')
      expect(shed.children.map(({ slug }) => slug)).toEqual(['lawn-mower', 'shed-door'])
      expect((await read('lawn-mower')).path).toEqual(['Garden shed'])
      // Moved from the shed to the garage: the stay in the shed ended the day before the move.
      const pump = await read('bike-pump')
      expect(pump.path).toEqual(['Garage'])
      expect(pump.part_of).toEqual([
        expect.objectContaining({
          slug: 'garden-shed',
          provenance: 'inferred',
          valid_until: expect.any(String),
        }),
        expect.objectContaining({
          slug: 'garage',
          provenance: 'inferred',
          valid_from: expect.any(String),
          valid_until: null,
        }),
      ])
      expect(pump.part_of[0]?.valid_until ?? '').toBe(
        previousDay(pump.part_of[1]?.valid_from ?? ''),
      )
      // Two stays in the shed, both over, the second named by the day it began.
      expect((await read('old-radio')).part_of).toEqual([
        expect.objectContaining({
          slug: 'garden-shed',
          period: null,
          valid_from: '2018-01-01',
          valid_until: '2020-12-31',
        }),
        expect.objectContaining({
          slug: 'garden-shed',
          period: '2023-01-01',
          valid_from: '2023-01-01',
          valid_until: '2024-06-30',
        }),
      ])
    })

    test('history: every event of an entry, in order, with its actor and what it changed', async () => {
      const story = async (slug: string) =>
        (await run(entryHistory(slug))).map(({ actor, action, changes }) => [
          actor,
          action,
          changes.map(({ field }) => field.replace(/^media\.[0-9a-f-]+/, 'media')),
        ])
      expect(await story('workshop-computer')).toEqual([
        [
          'agent-kitchen',
          'create',
          expect.arrayContaining(['fields.power_watts', 'provenance.condition']),
        ],
        ['agent-kitchen', 'update', ['fields.price', 'fields.condition']],
        ['agent-kitchen', 'update', ['body']],
        ['agent-kitchen', 'update', ['body']],
        ['agent-kitchen', 'attach', ['media']],
        ['agent-kitchen', 'update', ['media.alt']],
        [
          'agent-kitchen',
          'update',
          ['fields.power_watts', 'provenance.power_watts', 'fields.power_w', 'provenance.power_w'],
        ],
      ])
      expect(await story('garden-plan')).toEqual([
        ['agent-kitchen', 'create', expect.arrayContaining(['slug', 'body', 'aliases'])],
        ['agent-kitchen', 'update', ['slug']],
        ['agent-kitchen', 'update', ['body']],
        ['agent-kitchen', 'link', ['links.about']],
        ['agent-kitchen', 'unlink', ['links.about']],
        ['agent-kitchen', 'attach', ['media']],
      ])
      expect(await story('bruno-tessaly')).toEqual([
        ['agent-kitchen', 'create', expect.arrayContaining(['fields.employer'])],
        ['agent-kitchen', 'link', ['links.works_at']],
        ['owner', 'update', ['sources', 'provenance.employer']],
        ['owner', 'update', ['links.works_at']],
      ])
      expect(await story('lawn-mower')).toEqual([
        ['agent-kitchen', 'create', expect.arrayContaining(['links.part_of'])],
        ['agent-kitchen', 'link', ['links.bought_from']],
        ['agent-garden', 'update', ['sources']],
        ['agent-garden', 'attach', ['media']],
      ])
      expect(await story('old-radio')).toEqual([
        ['agent-kitchen', 'create', expect.any(Array)],
        ['agent-kitchen', 'archive', ['archived_at', 'archived_reason']],
        ['agent-kitchen', 'link', ['links.part_of']],
        ['agent-kitchen', 'link', ['links.part_of.2023-01-01']],
      ])
      expect(await story('atlas-of-rivers')).toEqual([
        ['agent-desk', 'create', expect.arrayContaining(['parent_id', 'fields.pages'])],
        ['agent-desk', 'link', ['links.see_also']],
      ])
      expect(await story('pocket-torch')).toEqual([
        ['agent-kitchen', 'create', expect.any(Array)],
        ['owner', 'update', ['type']],
      ])
      const [created] = await run(entryHistory('alma-quillon'))
      expect(created?.changes).toContainEqual({
        field: 'fields.birthday',
        before: null,
        after: '1990-04-12',
      })
    })

    test('media: each file is served by its hash, with its kind, size and description', async () => {
      const fileOf = (sha256: string) =>
        readFileSync(join(folder, 'media', sha256.slice(0, 2), sha256))
      const attached = [
        ['workshop-computer', 'image/png', 'Front of the case, with the new fan'],
        ['garden-plan', 'image/svg+xml', 'Sketch of the beds'],
        ['lawn-mower', 'image/png', 'Receipt of the mower'],
      ]
      const holding = await Promise.all(attached.map(([slug = '']) => read(slug)))
      expect(holding.map((entry) => entry.media)).toEqual(
        attached.map(([, mime, alt]) => [
          expect.objectContaining({ kind: 'image', mime, alt, position: 1 }),
        ]),
      )
      const files = holding.flatMap((entry) => entry.media)
      const served = await Promise.all(files.map(({ sha256 }) => run(readMedia(sha256))))
      expect(served.map(({ bytes }) => Buffer.from(bytes))).toEqual(
        files.map(({ sha256 }) => fileOf(sha256)),
      )
      expect(served.map(({ bytes }) => createHash('sha256').update(bytes).digest('hex'))).toEqual(
        files.map(({ sha256 }) => sha256),
      )
      expect(served.map(({ bytes }) => bytes.length)).toEqual(files.map(({ size }) => size))
    })

    test('search finds what it found: words of titles, bodies, aliases, fields and media descriptions', async () => {
      const found = async (query: string) => (await run(search(query, {}))).map(({ slug }) => slug)
      expect(await found('quillon')).toEqual(['alma-quillon'])
      expect(await found('riverbend')).toEqual(['atlas-of-rivers'])
      expect(await found('herb')).toEqual(['garden-plan'])
      expect(await found('vegetable plan')).toEqual(['garden-plan'])
      expect(await found('hinges')).toEqual(['shed-door'])
      expect(await found('sketch')).toEqual(['garden-plan'])
      expect(await found('quiet')).toEqual(['journal-2026-09-30'])
      expect((await found('port alder')).toSorted()).toEqual([
        'lakeside-library',
        'northwind-hardware',
      ])
      expect(await found('fan')).toContain('workshop-computer')
      const recent = await run(search(undefined, { by: 'agent-garden' }))
      expect(recent.map(({ slug }) => slug)).toEqual(['shed-door', 'lawn-mower'])
    })

    test('what is sensitive stays hidden from a key without the right', async () => {
      const reader = as(['read'])
      expect(Exit.isFailure(await reader(Effect.exit(readEntry('journal-2026-09-30'))))).toBe(true)
      expect((await reader(readEntry('workshop-computer'))).entry.fields).toMatchObject({
        brand: 'Corvid',
        serial: '[hidden]',
      })
      expect((await reader(readEntry('alma-quillon'))).entry.fields).toMatchObject({
        email: '[hidden]',
      })
      // Lifted by the owner from the command line.
      expect((await reader(readEntry('home-electricity'))).entry.fields).toMatchObject({
        account_number: 'ACC-5521',
      })
      expect(await reader(search('quiet', {}))).toEqual([])
    })

    test('types, keys, inbox, proposals, findings and rules are kept', async () => {
      const fieldsOf = (fields: ReadonlyArray<{ readonly name: string }>) =>
        fields.map(({ name }) => name)
      const types = await run(listTypes)
      expect(
        types.map(({ name, sensitive, read_in_parent, fields }) => [
          name,
          sensitive === true,
          read_in_parent === true,
          fieldsOf(fields),
        ]),
      ).toEqual([
        ['book', false, false, ['publisher', 'pages', 'shelf']],
        [
          'contract',
          false,
          false,
          ['provider', 'monthly_cost', 'renewal', 'notice_period', 'signed_at', 'account_number'],
        ],
        ['draft', false, false, []],
        [
          'item',
          false,
          true,
          [
            'brand',
            'serial',
            'price',
            'bought_on',
            'warranty_until',
            'sellers',
            'power_w',
            'weight_kg',
            'portable',
            'condition',
          ],
        ],
        ['journal', true, false, ['mood']],
        ['note', false, false, []],
        ['organization', false, false, ['website', 'city']],
        ['person', false, false, ['email', 'birthday', 'employer', 'languages', 'nickname']],
        ['room', false, false, []],
      ])
      const field = (type: string, name: string) =>
        types.find((found) => found.name === type)?.fields.find((found) => found.name === name)
      expect(field('item', 'sellers')).toMatchObject({
        kind: 'entry',
        many: true,
        types: ['organization'],
      })
      expect(field('item', 'serial')).toMatchObject({ kind: 'text', sensitive: true })
      expect(field('item', 'warranty_until')).toMatchObject({
        kind: 'date',
        due: { notice: 'P30D' },
      })
      expect(field('item', 'condition')).toMatchObject({
        values: ['new', 'used', 'worn', 'broken'],
      })
      expect(field('person', 'birthday')).toMatchObject({
        recurs: { every: 'yearly', notice: 'P14D' },
      })
      expect(field('contract', 'provider')).toMatchObject({ required: true })
      expect(field('contract', 'account_number')?.sensitive).not.toBe(true)
      expect(types.find(({ name }) => name === 'organization')?.description).toBe(
        'A company, a shop, a library or any body the owner deals with.',
      )

      const auth = await run(
        Effect.gen(function* () {
          return yield* Auth
        }),
      )
      expect(await run(auth.listKeys)).toEqual([
        { name: 'agent-desk', rights: ['read', 'write'], expires_at: null, revoked: false },
        { name: 'agent-garden', rights: ['read', 'write'], expires_at: null, revoked: false },
        {
          name: 'agent-kitchen',
          rights: ['read', 'write', 'sensitive'],
          expires_at: null,
          revoked: false,
        },
        { name: 'old-laptop', rights: ['read', 'write'], expires_at: null, revoked: true },
        { name: 'reader', rights: ['read'], expires_at: expect.any(String), revoked: false },
      ])
      const secret = (name: string) => readFileSync(join(folder, `${name}.key`), 'utf8').trim()
      expect(await run(auth.verifyKey(secret('agent-kitchen')))).toEqual({
        name: 'agent-kitchen',
        rights: ['read', 'write', 'sensitive'],
      })
      // Made by 0.5.0, under the old name: its secret still opens.
      expect(await run(auth.verifyKey(secret('agent-desk')))).toEqual({
        name: 'agent-desk',
        rights: ['read', 'write'],
      })

      const inbox = async (status: 'pending' | 'taken' | 'processed' | 'dismissed') =>
        (await run(listInbox({ status }))).items.map(({ name, origin }) => [name, origin])
      expect(await inbox('pending')).toEqual([[null, 'phone']])
      expect(await inbox('taken')).toEqual([['to-do.txt', 'scanner']])
      expect(await inbox('processed')).toEqual([['receipt.png', 'scanner']])
      expect(await inbox('dismissed')).toEqual([[null, 'phone']])

      expect(
        (await run(listProposals)).map(({ action, type, into, status, proposed_by }) => [
          action,
          type,
          into,
          status,
          proposed_by,
        ]),
      ).toEqual([
        ['merge', 'gadget', 'item', 'confirmed', 'agent-kitchen'],
        ['delete', 'draft', null, 'pending', 'agent-kitchen'],
      ])

      // The second finding was merged into the first: its occurrence counts there.
      const [finding, ...others] = await run(findingsWithOccurrences({}))
      expect(others).toEqual([])
      expect(finding?.finding).toMatchObject({
        number: 1,
        title: 'The parent of a moved entry is hard to find',
        kind: 'model_friction',
        place: 'read',
        occurrences: 3,
      })
      expect(finding?.occurrences.map(({ key_name, version: made }) => [key_name, made])).toEqual([
        ['agent-garden', version],
        ['agent-kitchen', version],
        ['agent-garden', version],
      ])

      expect(await run(instanceRulesText)).toBe(
        '# Rules\n\n- Write titles in sentence case.\n- Prices in euros.\n',
      )
    })

    test('what was written before writers were asked stays unstated: values, a body, a summary, a link, a place', async () => {
      const atlas = await read('atlas-of-rivers')
      expect(atlas.links).toEqual([
        expect.objectContaining({
          slug: 'field-guide-to-moths',
          relation: 'mentions',
          provenance: 'unstated',
        }),
        expect.objectContaining({
          slug: 'field-guide-to-moths',
          relation: 'see_also',
          provenance: 'unstated',
          note: 'same shelf',
          valid_from: '2021-05-01',
          valid_until: null,
        }),
      ])
      // The parent 0.5.0 gave became a place without dates.
      expect(atlas.path).toEqual(['Living room'])
      expect(atlas.part_of).toEqual([
        expect.objectContaining({
          slug: 'living-room',
          period: null,
          provenance: 'unstated',
          valid_from: null,
          valid_until: null,
        }),
      ])
      expect((await read('living-room')).children.map(({ slug }) => slug)).toEqual([
        'atlas-of-rivers',
      ])
      const unstated = async () =>
        (await run(supposedValues({ unstated: true }))).map(({ slug, what, provenance }) => [
          slug,
          what,
          provenance,
        ])
      expect(await unstated()).toEqual([
        ['atlas-of-rivers', 'body', 'unstated'],
        ['atlas-of-rivers', 'link part_of living-room', 'unstated'],
        ['atlas-of-rivers', 'link see_also field-guide-to-moths', 'unstated'],
        ['atlas-of-rivers', 'pages', 'unstated'],
        ['atlas-of-rivers', 'publisher', 'unstated'],
        ['atlas-of-rivers', 'shelf', 'unstated'],
        ['field-guide-to-moths', 'publisher', 'unstated'],
        ['living-room', 'body', 'unstated'],
        ['living-room', 'summary', 'unstated'],
      ])
      // A write over an unstated value says its provenance; the others stay unstated.
      await run(
        writeEntry({
          entry: 'atlas-of-rivers',
          fields: { pages: 214 },
          provenance: { pages: 'inferred' },
        }),
      )
      expect((await read('atlas-of-rivers')).entry).toMatchObject({
        fields: { publisher: 'Riverbend Press', pages: 214, shelf: 'top' },
        provenance: {
          publisher: 'unstated',
          pages: 'inferred',
          shelf: 'unstated',
          body: 'unstated',
        },
      })
      expect(await unstated()).not.toContainEqual(['atlas-of-rivers', 'pages', 'unstated'])
      expect(await unstated()).toHaveLength(8)
    })

    test('a write still works: a value changed, an entry a body awaited, a medium attached', async () => {
      await run(
        Effect.gen(function* () {
          yield* writeEntry({
            entry: 'workshop-computer',
            fields: { price: '799.00 EUR' },
            provenance: { price: 'extracted' },
          })
          yield* writeEntry({
            type: 'note',
            title: 'Herb spiral',
            body: 'Thyme at the top.',
            provenance: { body: 'inferred' },
          })
          yield* attachMedia({ entry: 'herb-spiral', data: PIXEL })
        }),
      )
      const computer = await read('workshop-computer')
      expect(computer.entry.fields).toMatchObject({ price: '799.00 EUR', serial: 'CV-1029-XA' })
      expect((await run(entryHistory('workshop-computer'))).at(-1)).toMatchObject({
        actor: 'agent-after-update',
        action: 'update',
      })
      // The body that cited it before it existed now mentions it.
      expect((await read('garden-plan')).links.map(({ slug }) => slug)).toContain('herb-spiral')
      expect(await run(pendingReferences)).toEqual([])
      expect((await read('herb-spiral')).media).toHaveLength(1)
    })
  },
)

/** A PNG of one pixel, made for the tests. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** The day before a date such as `2026-10-10`. */
const previousDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
