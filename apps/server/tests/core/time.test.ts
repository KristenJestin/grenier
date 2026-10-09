import { Effect } from 'effect'
import { beforeAll, describe, expect, test } from 'vitest'
import { Rights } from '../../src/core/auth/index.ts'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { Actor } from '../../src/core/events/index.ts'
import { link } from '../../src/core/links/index.ts'
import { briefing, headsUp, TimeZone, Today, upcoming } from '../../src/core/time/index.ts'
import { defineType } from '../../src/core/types/index.ts'
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
    await run(
      writeEntry({
        type: 'person',
        title: 'Ada',
        fields: { birthday: '1990-11-04' },
        provenance: { birthday: 'inferred' },
      }),
    )
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
    await run(
      writeEntry({
        type: 'person',
        title: 'Bo',
        fields: { birthday: '1985-06-20' },
        provenance: { birthday: 'inferred' },
      }),
    )
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
    await run(
      writeEntry({
        type: 'tax',
        title: 'Land tax',
        fields: { deadline: '2024-04-15' },
        provenance: { deadline: 'inferred' },
      }),
    )
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
    await run(link('land-tax-paid', 'land-tax', 'fulfills', '2026', '', { provenance: 'inferred' }))
    expect(await taxes('2026-04-01', '2026-04-30')).toEqual([])
    expect(await taxes('2027-04-01', '2027-04-30')).toEqual(['2027-04-15'])
  })

  test('a fulfills link needs a period, and only a fulfills link takes one', async () => {
    await run(writeEntry({ type: 'note', title: 'Receipt' }))
    await expect(
      run(link('receipt', 'land-tax', 'fulfills', '', '', { provenance: 'inferred' })),
    ).rejects.toThrow(
      'The field `deadline` of `land-tax` comes back every year: a link `fulfills` names its period as `2026`.',
    )
    await expect(
      run(link('receipt', 'land-tax', 'fulfills', 'soon', '', { provenance: 'inferred' })),
    ).rejects.toThrow(
      'A link `fulfills` needs a period: `2026` for a yearly date, `2026-10` monthly, `2026-W41` weekly, or the date itself.',
    )
    await expect(
      run(link('receipt', 'land-tax', 'about', '2026', '', { provenance: 'inferred' })),
    ).rejects.toThrow('Only a link `fulfills` takes a period.')
  })
})

describe('a fulfills link closes one field', () => {
  test('a car whose insurance is paid for 2026 still announces its 2026 inspection', async () => {
    await run(
      writeEntry({
        type: 'car',
        title: 'Blue car',
        fields: { insurance_renewal: '2020-03-10', inspection: '2020-03-20' },
        provenance: { insurance_renewal: 'inferred', inspection: 'inferred' },
      }),
    )
    await run(writeEntry({ type: 'note', title: 'Blue car insurance paid' }))
    await run(
      link('blue-car-insurance-paid', 'blue-car', 'fulfills', '2026', 'insurance_renewal', {
        provenance: 'inferred',
      }),
    )
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
    await run(
      writeEntry({
        type: 'tax',
        title: 'Water tax',
        fields: { deadline: '2024-05-15' },
        provenance: { deadline: 'inferred' },
      }),
    )
    await run(writeEntry({ type: 'note', title: 'Water tax paid' }))
    expect(
      await run(
        link('water-tax-paid', 'water-tax', 'fulfills', '2026', '', { provenance: 'inferred' }),
      ),
    ).toMatchObject({
      field: 'deadline',
    })
    const { links } = await run(readEntry('water-tax-paid'))
    expect(links).toContainEqual(
      expect.objectContaining({ relation: 'fulfills', period: '2026', field: 'deadline' }),
    )
  })

  test('without a field, a link to a target with two such dates is refused, naming them', async () => {
    await run(
      writeEntry({
        type: 'car',
        title: 'Red car',
        fields: { inspection: '2021-06-01' },
        provenance: { inspection: 'inferred' },
      }),
    )
    await run(writeEntry({ type: 'note', title: 'Red car paper' }))
    await expect(
      run(link('red-car-paper', 'red-car', 'fulfills', '2026', '', { provenance: 'inferred' })),
    ).rejects.toThrow(
      'A link `fulfills` to `red-car` must name the field it closes: `insurance_renewal` or `inspection`.',
    )
  })

  test('a field that is not a deadline or recurring date of the target is refused', async () => {
    await run(writeEntry({ type: 'note', title: 'Red car invoice' }))
    await expect(
      run(
        link('red-car-invoice', 'red-car', 'fulfills', '2026', 'bought', {
          provenance: 'inferred',
        }),
      ),
    ).rejects.toThrow(
      'The field `bought` is not a deadline or a recurring date of `red-car`: name `insurance_renewal` or `inspection`.',
    )
  })
})

describe('briefing', () => {
  test('a deadline past and unfulfilled is reported as overdue', async () => {
    await run(
      writeEntry({
        type: 'bill',
        title: 'Plumber bill',
        fields: { due_on: '2026-09-30' },
        provenance: { due_on: 'inferred' },
      }),
    )
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
          writeEntry({
            type: 'person',
            title: `Born a ${title}`,
            fields: { birthday },
            provenance: { birthday: 'inferred' },
          }),
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
    await run(
      writeEntry({
        type: 'person',
        title: 'Leap',
        fields: { birthday: '2000-02-29' },
        provenance: { birthday: 'inferred' },
      }),
    )
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

describe('the period of upcoming', () => {
  const refusalOf = (effect: ReturnType<typeof upcoming>) =>
    run(
      Effect.flip(effect).pipe(
        on('2026-05-01'),
        Effect.map(({ message }) => message),
      ),
    )

  test('a period that ends before it starts is refused, not an error', async () => {
    expect(await refusalOf(upcoming('2026-05-01', '2026-04-01'))).toBe(
      'The period ends before it starts: `to` (`2026-04-01`) comes before `from` (`2026-05-01`).',
    )
  })

  test('a date that does not exist is refused', async () => {
    expect(await refusalOf(upcoming('2026-13-45', '2026-12-31'))).toBe(
      'The field `from` must be a date such as `2026-10-05`.',
    )
  })

  test('a period of more than a year is refused', async () => {
    expect(await refusalOf(upcoming('2026-01-01', '2028-01-01'))).toBe(
      'The period is a year at most: ask for `2026-01-01` to `2026-12-31`, then the next one.',
    )
  })
})

describe('notices', () => {
  test('a one-month notice before a date at a month end starts on its day', async () => {
    await run(
      defineType({
        name: 'lease',
        label: 'Lease',
        description: 'A lease that ends once.',
        fields: [{ name: 'ends', kind: 'date', due: { notice: 'P1M' } }],
      }),
    )
    await run(
      writeEntry({
        type: 'lease',
        title: 'Studio lease',
        fields: { ends: '2026-03-30' },
        provenance: { ends: 'inferred' },
      }),
    )
    const told = await run(headsUp.pipe(on('2026-02-28'), as('agent-lease')))
    expect(told.map(({ entry }) => entry.slug)).toContain('studio-lease')
  })

  test('a notice of hours counts as a day', async () => {
    await run(
      defineType({
        name: 'slot',
        label: 'Slot',
        description: 'A booked slot.',
        fields: [{ name: 'on', kind: 'date', due: { notice: 'PT12H' } }],
      }),
    )
    await run(
      writeEntry({
        type: 'slot',
        title: 'Court booking',
        fields: { on: '2026-06-10' },
        provenance: { on: 'inferred' },
      }),
    )
    const seen = async (day: string) =>
      (await run(headsUp.pipe(on(day), as(`agent-slot-${day}`)))).map(({ entry }) => entry.slug)
    expect(await seen('2026-06-08')).not.toContain('court-booking')
    expect(await seen('2026-06-09')).toContain('court-booking')
  })
})

describe('a year ago, in the owner time zone', () => {
  test('an entry created late in the evening counts on the day the owner lived it', async () => {
    await run(writeEntry({ type: 'note', title: 'Late evening', created: '2025-03-01T23:30:00Z' }))
    const paris = await run(
      briefing('today').pipe(on('2026-03-02'), Effect.provideService(TimeZone, 'Europe/Paris')),
    )
    expect(paris.a_year_ago.created.map(({ slug }) => slug)).toContain('late-evening')
    const utc = await run(
      briefing('today').pipe(on('2026-03-02'), Effect.provideService(TimeZone, 'UTC')),
    )
    expect(utc.a_year_ago.created.map(({ slug }) => slug)).not.toContain('late-evening')
  })
})

describe('sensitive dates, for a key without the right sensitive', () => {
  const plain = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Rights, ['read', 'write'])
  /** What a key without `sensitive` gets from each way time comes out, on a given day. */
  const seen = (day: string, actor: string) =>
    run(
      Effect.all({
        days: Effect.forEach(
          Array.from({ length: 30 }, (_, index) => `2041-04-${String(index + 1).padStart(2, '0')}`),
          (each) => upcoming(each, each),
        ),
        month: upcoming('2041-04-01', '2041-04-30'),
        told: headsUp.pipe(as(actor)),
        briefing: briefing('week'),
        later: briefing('week').pipe(on('2042-04-10')),
      }).pipe(on(day), plain),
    )

  test('day-by-day probing, heads_up and briefing find nothing of them, and count the same', async () => {
    await run(
      Effect.all([
        defineType({
          name: 'clinic',
          label: 'Clinic',
          description: 'A clinic visit.',
          sensitive: true,
          fields: [{ name: 'visit', kind: 'date', due: { notice: 'P30D' } }],
        }),
        defineType({
          name: 'locker',
          label: 'Locker',
          description: 'A locker rented every year.',
          fields: [
            {
              name: 'renews',
              kind: 'date',
              sensitive: true,
              due: { notice: 'P30D' },
              recurs: { every: 'yearly', notice: 'P30D' },
            },
          ],
        }),
      ]),
    )
    const before = await seen('2041-04-10', 'agent-probe-before')
    await run(
      Effect.all([
        writeEntry({
          type: 'clinic',
          title: 'Checkup',
          fields: { visit: '2041-04-14' },
          provenance: { visit: 'inferred' },
        }),
        writeEntry({
          type: 'locker',
          title: 'Gym locker',
          fields: { renews: '2041-04-17' },
          provenance: { renews: 'inferred' },
        }),
        writeEntry({
          type: 'clinic',
          title: 'Old visit',
          fields: { visit: '2041-04-03' },
          provenance: { visit: 'inferred' },
        }),
        writeEntry({ type: 'clinic', title: 'Lab results', created: '2041-04-12' }),
      ]),
    )
    const after = await seen('2041-04-10', 'agent-probe-after')
    expect(after).toEqual(before)
    const shown = JSON.stringify(after)
    for (const word of ['gym-locker', 'Checkup', 'clinic', 'renews', 'old-visit', 'lab-results'])
      expect(shown).not.toContain(word)
    const all = await run(upcoming('2041-04-01', '2041-04-30'))
    expect(
      all
        .filter(({ entry }) => ['checkup', 'gym-locker'].includes(entry.slug))
        .map(({ entry, date }) => [entry.slug, date]),
    ).toEqual([
      ['checkup', '2041-04-14'],
      ['gym-locker', '2041-04-17'],
    ])
    const told = await run(headsUp.pipe(on('2041-04-10'), as('agent-trusted')))
    expect(told.map(({ entry }) => entry.slug)).toEqual(
      expect.arrayContaining(['checkup', 'gym-locker']),
    )
  })
})
