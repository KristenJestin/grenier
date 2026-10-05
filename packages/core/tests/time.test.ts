import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vite-plus/test'
import { readEntry, writeEntry } from '../src/entries/index.ts'
import { Actor } from '../src/events/index.ts'
import { link } from '../src/links/index.ts'
import { briefing, headsUp, Today, upcoming } from '../src/time/index.ts'
import { defineType } from '../src/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()

/** Runs as if today were `day`. */
const on =
  (day: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Today, () => day)

const as =
  (actor: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Actor, actor)

beforeAll(() =>
  run(
    Effect.all([
      defineType({
        name: 'person',
        label: 'Person',
        description: 'Someone.',
        fields: [{ name: 'birthday', kind: 'date', recurs: { every: 'yearly', notice: 'P30D' } }],
      }),
      defineType({
        name: 'tax',
        label: 'Tax',
        description: 'A tax paid every year.',
        fields: [
          {
            name: 'deadline',
            kind: 'date',
            due: { notice: 'P30D' },
            recurs: { every: 'yearly', notice: 'P30D' },
          },
        ],
      }),
      defineType({
        name: 'bill',
        label: 'Bill',
        description: 'A bill to pay once.',
        fields: [{ name: 'due_on', kind: 'date', due: { notice: 'P7D' } }],
      }),
      defineType({
        name: 'car',
        label: 'Car',
        description: 'A car, insured and inspected every year.',
        fields: [
          {
            name: 'insurance_renewal',
            kind: 'date',
            due: { notice: 'P30D' },
            recurs: { every: 'yearly', notice: 'P30D' },
          },
          {
            name: 'inspection',
            kind: 'date',
            due: { notice: 'P30D' },
            recurs: { every: 'yearly', notice: 'P30D' },
          },
          { name: 'bought', kind: 'date' },
        ],
      }),
      defineType({ name: 'note', label: 'Note', description: 'A free note.', fields: [] }),
    ]),
  ),
)

describe('a yearly date with a 30-day notice', () => {
  test('appears in upcoming and in heads_up 30 days before, with its age; not 31 days before', async () => {
    await run(writeEntry({ type: 'person', title: 'Ada', fields: { birthday: '1990-11-04' } }))
    const coming = await run(upcoming('2026-10-05', '2026-12-31').pipe(on('2026-10-05')))
    expect(coming.filter(({ entry }) => entry.slug === 'ada')).toEqual([
      {
        entry: expect.objectContaining({ slug: 'ada', title: 'Ada', type: 'person' }),
        field: 'birthday',
        date: '2026-11-04',
        period: '2026',
        days_left: 30,
        age: 36,
        deadline: false,
      },
    ])
    const thirty = await run(headsUp.pipe(on('2026-10-05'), as('agent-one')))
    expect(thirty.map(({ entry, date }) => [entry.slug, date])).toContainEqual([
      'ada',
      '2026-11-04',
    ])
    const thirtyOne = await run(headsUp.pipe(on('2026-10-04'), as('agent-two')))
    expect(thirtyOne.map(({ entry }) => entry.slug)).not.toContain('ada')
  })
})

describe('heads_up', () => {
  test('shows an occurrence once a day per actor, then again the next day', async () => {
    await run(writeEntry({ type: 'person', title: 'Bo', fields: { birthday: '1985-06-20' } }))
    const seen = (day: string, actor: string) =>
      run(
        headsUp.pipe(
          on(day),
          as(actor),
          Effect.map((list) => list.some(({ entry }) => entry.slug === 'bo')),
        ),
      )
    expect(await seen('2026-06-10', 'agent-a')).toBe(true)
    expect(await seen('2026-06-10', 'agent-a')).toBe(false)
    expect(await seen('2026-06-10', 'agent-b')).toBe(true)
    expect(await seen('2026-06-11', 'agent-a')).toBe(true)
  })
})

describe('closing an occurrence', () => {
  test('a yearly deadline fulfilled for this year is no longer announced; next year’s is', async () => {
    await run(writeEntry({ type: 'tax', title: 'Land tax', fields: { deadline: '2024-04-15' } }))
    const taxes = (from: string, to: string) =>
      run(
        upcoming(from, to).pipe(
          on(from),
          Effect.map((list) =>
            list.filter(({ entry }) => entry.slug === 'land-tax').map(({ date }) => date),
          ),
        ),
      )
    expect(await taxes('2026-04-01', '2026-04-30')).toEqual(['2026-04-15'])
    await run(writeEntry({ type: 'note', title: 'Land tax paid' }))
    await run(link('land-tax-paid', 'land-tax', 'fulfills', '2026'))
    expect(await taxes('2026-04-01', '2026-04-30')).toEqual([])
    expect(await taxes('2027-04-01', '2027-04-30')).toEqual(['2027-04-15'])
  })

  test('a fulfills link needs a period, and only a fulfills link takes one', async () => {
    await run(writeEntry({ type: 'note', title: 'Receipt' }))
    await expect(run(link('receipt', 'land-tax', 'fulfills'))).rejects.toThrow(
      'A link `fulfills` needs a period: `2026` for a yearly date, `2026-10` monthly, `2026-W41` weekly, or the date itself.',
    )
    await expect(run(link('receipt', 'land-tax', 'about', '2026'))).rejects.toThrow(
      'Only a link `fulfills` takes a period.',
    )
  })
})

describe('a fulfills link closes one field', () => {
  test('a car whose insurance is paid for 2026 still announces its 2026 inspection', async () => {
    await run(
      writeEntry({
        type: 'car',
        title: 'Blue car',
        fields: { insurance_renewal: '2020-03-10', inspection: '2020-03-20' },
      }),
    )
    await run(writeEntry({ type: 'note', title: 'Blue car insurance paid' }))
    await run(link('blue-car-insurance-paid', 'blue-car', 'fulfills', '2026', 'insurance_renewal'))
    const fieldsOf = (list: ReadonlyArray<{ entry: { slug: string }; field: string }>) =>
      list.filter(({ entry }) => entry.slug === 'blue-car').map(({ field }) => field)
    expect(
      fieldsOf(await run(upcoming('2026-03-01', '2026-03-31').pipe(on('2026-03-01')))),
    ).toEqual(['inspection'])
    expect(fieldsOf(await run(headsUp.pipe(on('2026-03-01'), as('car-agent'))))).toEqual([
      'inspection',
    ])
    const { overdue } = await run(briefing('today').pipe(on('2026-03-25')))
    expect(fieldsOf(overdue)).toEqual(['inspection'])
  })

  test('the field is inferred when the target has one deadline or recurring date', async () => {
    await run(writeEntry({ type: 'tax', title: 'Water tax', fields: { deadline: '2024-05-15' } }))
    await run(writeEntry({ type: 'note', title: 'Water tax paid' }))
    expect(await run(link('water-tax-paid', 'water-tax', 'fulfills', '2026'))).toEqual({
      field: 'deadline',
    })
    const { links } = await run(readEntry('water-tax-paid'))
    expect(links).toContainEqual(
      expect.objectContaining({ relation: 'fulfills', period: '2026', field: 'deadline' }),
    )
  })

  test('without a field, a link to a target with two such dates is refused, naming them', async () => {
    await run(writeEntry({ type: 'car', title: 'Red car', fields: { inspection: '2021-06-01' } }))
    await run(writeEntry({ type: 'note', title: 'Red car paper' }))
    await expect(run(link('red-car-paper', 'red-car', 'fulfills', '2026'))).rejects.toThrow(
      'A link `fulfills` to `red-car` must name the field it closes: `insurance_renewal` or `inspection`.',
    )
  })

  test('a field that is not a deadline or recurring date of the target is refused', async () => {
    await run(writeEntry({ type: 'note', title: 'Red car invoice' }))
    await expect(
      run(link('red-car-invoice', 'red-car', 'fulfills', '2026', 'bought')),
    ).rejects.toThrow(
      'The field `bought` is not a deadline or a recurring date of `red-car`: name `insurance_renewal` or `inspection`.',
    )
  })
})

describe('briefing', () => {
  test('a deadline past and unfulfilled is reported as overdue', async () => {
    await run(writeEntry({ type: 'bill', title: 'Plumber bill', fields: { due_on: '2026-09-30' } }))
    const { overdue } = await run(briefing('today').pipe(on('2026-10-05')))
    expect(overdue.filter(({ entry }) => entry.slug === 'plumber-bill')).toEqual([
      expect.objectContaining({ date: '2026-09-30', days_left: -5, deadline: true }),
    ])
  })

  test('briefing(weekend) on a Thursday covers the next Saturday and Sunday', async () => {
    await run(
      Effect.forEach(
        [
          { title: 'Friday', birthday: '2001-10-09' },
          { title: 'Saturday', birthday: '2001-10-10' },
          { title: 'Sunday', birthday: '2001-10-11' },
          { title: 'Monday', birthday: '2001-10-12' },
        ],
        ({ title, birthday }) =>
          writeEntry({ type: 'person', title: `Born a ${title}`, fields: { birthday } }),
      ),
    )
    const result = await run(briefing('weekend').pipe(on('2026-10-08')))
    expect([result.from, result.to]).toEqual(['2026-10-10', '2026-10-11'])
    expect(
      result.upcoming.map(({ entry }) => entry.title).filter((title) => title.startsWith('Born a')),
    ).toEqual(['Born a Saturday', 'Born a Sunday'])
  })

  test('a year ago: what was created on the same date one year earlier', async () => {
    await run(writeEntry({ type: 'note', title: 'Planted the pear tree', created: '2025-10-05' }))
    const { a_year_ago } = await run(briefing('today').pipe(on('2026-10-05')))
    expect(a_year_ago.created.map(({ slug }) => slug)).toContain('planted-the-pear-tree')
  })
})

describe('29 February', () => {
  test('falls on 28 February in a year that is not a leap year', async () => {
    await run(writeEntry({ type: 'person', title: 'Leap', fields: { birthday: '2000-02-29' } }))
    const leap = (from: string, to: string) =>
      run(
        upcoming(from, to).pipe(
          on(from),
          Effect.map((list) =>
            list.filter(({ entry }) => entry.slug === 'leap').map(({ date, age }) => [date, age]),
          ),
        ),
      )
    expect(await leap('2027-02-01', '2027-03-31')).toEqual([['2027-02-28', 27]])
    expect(await leap('2028-02-01', '2028-03-31')).toEqual([['2028-02-29', 28]])
  })
})
