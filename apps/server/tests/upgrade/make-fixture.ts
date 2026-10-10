#!/usr/bin/env bun
/**
 * Makes the fixture of a release for the upgrade test, with that release's own code: its command
 * line and its MCP server over stdio write invented, neutral data into a scratch database, which
 * is then dumped as plain SQL, beside the media it wrote. 0.5.0 writes first, as on an
 * installation made before 0.6.0: what it wrote says no provenance, and the release, opening the
 * database, migrates it. See `README.md` beside this file.
 *
 *   bun apps/server/tests/upgrade/make-fixture.ts <checkout of the release> <version> \
 *     <checkout of v0.5.0>
 *
 * `DATABASE_URL` names the server the scratch database is created on (the local PostgreSQL of
 * `docker-compose.yml`); the database is dropped at the end. `PG_DUMP` is the command that dumps
 * it, `docker run --rm --network host postgres:18.0 pg_dump` unless told.
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Effect, Schema } from 'effect'
import { createScratchDatabase, dropScratchDatabase } from '../../src/core/testing.ts'

const [checkout = '', version = '', older = ''] = process.argv.slice(2)
if (checkout === '' || version === '' || older === '') {
  console.error(
    'Usage: bun make-fixture.ts <checkout of the release> <version> <checkout of v0.5.0>',
  )
  process.exit(1)
}
const fixture = new URL(`${version}/`, import.meta.url).pathname
const scratch = mkdtempSync(join(tmpdir(), 'hippocampe-fixture-'))
const media = join(scratch, 'media')
const database = `hippocampe_fixture_${version.replaceAll('.', '_')}`

/** Invented for the fixture, and kept nowhere: the keys of the fixture verify with it. */
const AUTH_SECRET = 'fixture-secret-of-an-invented-database-0001'

/** The code of a release: its sources, and what its processes are started with. */
interface Code {
  readonly sources: string
  readonly environment: (url: string) => Readonly<Record<string, string>>
  /** What its MCP server is told of the agent that writes. */
  readonly writer: (actor: string, rights: string) => Readonly<Record<string, string>>
}

/** The release the fixture is of. */
const release: Code = {
  sources: join(resolve(checkout), 'apps/server/src'),
  environment: (url) => ({
    PATH: process.env['PATH'] ?? '',
    DATABASE_URL: url,
    MEDIA_DIR: media,
    SEARCH_LANGUAGE: 'simple',
    HIPPOCAMPE_INSTANCE: 'local',
    HIPPOCAMPE_DIAGNOSTICS: 'on',
    HIPPOCAMPE_VERSION: version,
    HIPPOCAMPE_COMMIT: 'fixture',
    BETTER_AUTH_SECRET: AUTH_SECRET,
  }),
  writer: (actor, rights) => ({ HIPPOCAMPE_ACTOR: actor, HIPPOCAMPE_RIGHTS: rights }),
}

/** 0.5.0, still named Grenier, which wrote no provenance unless told. */
const before: Code = {
  sources: join(resolve(older), 'apps/server/src'),
  environment: (url) => ({
    PATH: process.env['PATH'] ?? '',
    DATABASE_URL: url,
    MEDIA_DIR: media,
    SEARCH_LANGUAGE: 'simple',
    GRENIER_INSTANCE: 'local',
    BETTER_AUTH_SECRET: AUTH_SECRET,
  }),
  writer: (actor, rights) => ({ GRENIER_ACTOR: actor, GRENIER_RIGHTS: rights }),
}

/** Runs a command of the command line of `code`; its output, or the script stops. */
const hippo = (code: Code, url: string, ...args: ReadonlyArray<string>) => {
  const ran = spawnSync(process.execPath, [join(code.sources, 'cli.ts'), ...args], {
    env: code.environment(url),
    encoding: 'utf8',
  })
  if (ran.status !== 0) throw new Error(`hippo ${args.join(' ')}: ${ran.stderr}${ran.stdout}`)
  return ran.stdout
}

/** The secret a `key:create` printed, kept in the scratch folder under the key's name. */
const keep = (name: string, printed: string) =>
  writeFileSync(join(scratch, `${name}.key`), `${printed.trim().split('\n').at(-1)}\n`)

const Response = Schema.Struct({
  id: Schema.optionalKey(Schema.Number),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})
type Response = typeof Response.Type

const ToolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
  ),
})

/** An answer of a tool, as the JSON it is. */
const Answer = Schema.fromJsonString(Schema.Json)

/**
 * The MCP server of `code` on stdio, as an agent starts it, writing as `actor` with `rights`:
 * `call` calls a tool and gives its answer, or stops the script on a refusal.
 */
async function agent(code: Code, url: string, actor: string, rights: string) {
  const server = spawn(process.execPath, [join(code.sources, 'mcp/main.ts')], {
    env: { ...code.environment(url), ...code.writer(actor, rights) },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const waiting = new Map<number, (response: Response) => void>()
  createInterface({ input: server.stdout }).on('line', (line) => {
    const response = Schema.decodeUnknownSync(Response)(JSON.parse(line))
    if (response.id !== undefined) waiting.get(response.id)?.(response)
  })
  let next = 0
  const send = (message: Schema.Json) => server.stdin.write(`${JSON.stringify(message)}\n`)
  const request = (method: string, params: Schema.Json) =>
    new Promise<Response>((answer) => {
      next += 1
      waiting.set(next, answer)
      send({ jsonrpc: '2.0', id: next, method, params })
    })
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'hippocampe-fixture', version },
  })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    async call(tool: string, args: Schema.Json) {
      const { result, error } = await request('tools/call', { name: tool, arguments: args })
      if (error !== undefined) throw new Error(`${tool}: ${error.message}`)
      const { isError = false, content } = Schema.decodeUnknownSync(ToolResult)(result)
      const text = content.map((part) => part.text ?? '').join('')
      if (isError) throw new Error(`${tool} ${JSON.stringify(args)}: ${text}`)
      return Schema.decodeUnknownSync(Answer)(text)
    },
    close: () => server.kill(),
  }
}

/** What the script reads of an answer: the id or the number of what a call made. */
const read = <A>(schema: Schema.Codec<A, A>, answer: Schema.Json) =>
  Schema.decodeUnknownSync(schema)(answer)
const Made = (key: string) => Schema.Struct({ [key]: Schema.Struct({ id: Schema.String }) })
const idOf = (key: string, answer: Schema.Json) => read(Made(key), answer)[key]?.id ?? ''
const Reported = Schema.Struct({ finding: Schema.Struct({ number: Schema.Number }) })
const Listed = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) })),
})

/** Two PNG of one pixel and an SVG, made for the fixture. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const OTHER_PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const SKETCH = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#7a5"/></svg>',
).toString('base64')

/**
 * What 0.5.0 writes first: the owner, a key, and a few entries with fields, bodies, a summary, a
 * parent and a link, which say no provenance (but one value). Opening the database, the release
 * migrates it: the values, the bodies and the links become `unstated`, the parent a link
 * `part_of`, `unstated` too.
 */
async function writeBefore(url: string) {
  keep(
    'agent-desk',
    hippo(
      before,
      url,
      'key:create',
      '--name',
      'agent-desk',
      '--rights',
      'read,write',
      '--owner',
      'owner@example.org',
    ),
  )
  const desk = await agent(before, url, 'agent-desk', 'read,write')
  await desk.call('define_type', {
    name: 'room',
    label: 'Room',
    description: 'A room of the house.',
    fields: [],
  })
  await desk.call('define_type', {
    name: 'book',
    label: 'Book',
    description: 'A book on the shelves.',
    fields: [
      { name: 'publisher', kind: 'text' },
      { name: 'pages', kind: 'integer' },
      { name: 'shelf', kind: 'text' },
    ],
  })
  await desk.call('write', {
    type: 'room',
    title: 'Living room',
    body: 'Two bookcases by the window.',
    summary: 'The room with the books.',
  })
  await desk.call('write', {
    type: 'book',
    title: 'Field guide to moths',
    fields: { publisher: 'Lantern Press', pages: 96 },
    // The one provenance 0.5.0 is told: it stays as it is.
    provenance: { pages: 'inferred' },
  })
  await desk.call('write', {
    type: 'book',
    title: 'Atlas of rivers',
    parent: 'living-room',
    fields: { publisher: 'Riverbend Press', pages: 212, shelf: 'top' },
    body: 'Bought second-hand; read with the [[field-guide-to-moths]].',
  })
  await desk.call('link', {
    source: 'atlas-of-rivers',
    target: 'field-guide-to-moths',
    relation: 'see_also',
    note: 'same shelf',
    valid_from: '2021-05-01',
  })
  desk.close()
}

/** Everything else the fixture holds, written by the release as an owner and two agents would. */
async function write(url: string) {
  // The owner and the keys: one of each kind, one revoked.
  const created = hippo(
    release,
    url,
    'key:create',
    '--name',
    'agent-kitchen',
    '--rights',
    'read,write,sensitive',
    '--owner',
    'owner@example.org',
  )
  // The secret of an invented key of this database alone: the test checks the key still opens.
  keep('agent-kitchen', created)
  hippo(release, url, 'key:create', '--name', 'agent-garden', '--rights', 'read,write')
  hippo(
    release,
    url,
    'key:create',
    '--name',
    'reader',
    '--rights',
    'read',
    '--expires-in-days',
    '3650',
  )
  hippo(release, url, 'key:create', '--name', 'old-laptop', '--rights', 'read,write')
  hippo(release, url, 'key:revoke', '--name', 'old-laptop')
  const rules = join(scratch, 'rules.md')
  writeFileSync(rules, '# Rules\n\n- Write titles in sentence case.\n- Prices in euros.\n')
  hippo(release, url, 'rules:set', rules)

  const kitchen = await agent(release, url, 'agent-kitchen', 'read,write,sensitive')

  // Types, with every kind of field, `entry` fields, `many`, sensitive fields and a sensitive type.
  await kitchen.call('define_type', {
    name: 'organization',
    label: 'Organization',
    description: 'A company, a shop or a library people deal with.',
    fields: [
      { name: 'website', kind: 'url' },
      { name: 'city', kind: 'text' },
    ],
  })
  await kitchen.call('define_type', {
    name: 'person',
    label: 'Person',
    description: 'Someone the owner knows.',
    fields: [
      { name: 'email', kind: 'text', sensitive: true },
      { name: 'birthday', kind: 'date', recurs: { every: 'yearly', notice: 'P14D' } },
      { name: 'employer', kind: 'entry', types: ['organization'] },
      { name: 'languages', kind: 'text', many: true },
    ],
  })
  await kitchen.call('define_type', {
    name: 'item',
    label: 'Item',
    description: 'A thing the owner keeps: a tool, a machine, a piece of furniture.',
    read_in_parent: true,
    fields: [
      { name: 'brand', kind: 'text', required: true },
      { name: 'serial', kind: 'text', sensitive: true },
      { name: 'price', kind: 'money' },
      { name: 'bought_on', kind: 'date' },
      { name: 'warranty_until', kind: 'date', due: { notice: 'P30D' } },
      { name: 'sellers', kind: 'entry', many: true, types: ['organization'] },
      { name: 'power_watts', kind: 'integer' },
      { name: 'weight_kg', kind: 'number' },
      { name: 'portable', kind: 'boolean' },
      { name: 'condition', kind: 'enum', values: ['new', 'used', 'worn'] },
    ],
  })
  await kitchen.call('define_type', {
    name: 'contract',
    label: 'Contract',
    description: 'A contract or a subscription followed over time.',
    fields: [
      { name: 'provider', kind: 'entry', types: ['organization'] },
      { name: 'monthly_cost', kind: 'money' },
      { name: 'renewal', kind: 'date', recurs: { every: 'yearly', notice: 'P30D' } },
      { name: 'notice_period', kind: 'duration' },
      { name: 'signed_at', kind: 'datetime' },
    ],
  })
  await kitchen.call('define_type', {
    name: 'journal',
    label: 'Journal',
    description: 'A page of the private journal.',
    sensitive: true,
    fields: [{ name: 'mood', kind: 'enum', values: ['calm', 'busy', 'tired'] }],
  })
  await kitchen.call('define_type', {
    name: 'note',
    label: 'Note',
    description: 'A free note, or a place things are kept in.',
    fields: [],
  })
  await kitchen.call('define_type', {
    name: 'gadget',
    label: 'Gadget',
    description: 'A small device; to be merged into items.',
    fields: [{ name: 'brand', kind: 'text' }],
  })
  await kitchen.call('define_type', {
    name: 'draft',
    label: 'Draft',
    description: 'A type no entry uses.',
    fields: [],
  })

  // Entries, in one transaction: they name one another in fields, parents and bodies.
  await kitchen.call('write', {
    entries: [
      {
        type: 'person',
        title: 'Morgan Vale',
        summary: 'The owner of this Hippocampe.',
        provenance: { summary: 'inferred' },
      },
      {
        type: 'organization',
        title: 'Northwind Hardware',
        fields: { website: 'https://northwind.example', city: 'Port Alder' },
        provenance: { website: 'extracted', city: 'extracted' },
        sources: [{ url: 'https://northwind.example/contact', note: 'the contact page' }],
        tags: ['shop'],
      },
      {
        type: 'organization',
        title: 'Bluebell Energy',
        fields: { website: 'https://bluebell.example' },
        provenance: { website: 'inferred' },
      },
      {
        type: 'organization',
        title: 'Lakeside Library',
        fields: { city: 'Port Alder' },
        provenance: { city: 'ambiguous' },
      },
      {
        type: 'person',
        title: 'Alma Quillon',
        fields: {
          email: 'alma@example.org',
          birthday: '1990-04-12',
          employer: 'northwind-hardware',
          languages: ['English', 'Portuguese'],
        },
        provenance: {
          email: 'extracted',
          birthday: 'extracted',
          employer: 'extracted',
          languages: 'inferred',
          body: 'extracted',
        },
        sources: [{ said_by: 'morgan-vale', on: '2026-09-01', note: 'at the hardware shop' }],
        body: 'Met at [[northwind-hardware]]. Lends tools.',
        aliases: ['Alma Q.'],
      },
      {
        type: 'person',
        title: 'Bruno Tessaly',
        fields: { employer: 'bluebell-energy' },
        provenance: { employer: 'inferred' },
      },
      {
        type: 'note',
        title: 'Garden shed',
        body: 'The wooden shed at the end of the garden.',
        provenance: { body: 'extracted' },
        sources: [{ said_by: 'morgan-vale', on: '2026-09-02' }],
      },
      {
        type: 'note',
        title: 'Garage',
        body: 'Beside the house.',
        provenance: { body: 'inferred' },
      },
      {
        type: 'item',
        title: 'Workshop computer',
        fields: {
          brand: 'Corvid',
          serial: 'CV-1029-XA',
          price: '899.00 EUR',
          bought_on: '2024-02-14',
          warranty_until: '2027-02-14',
          sellers: ['northwind-hardware', 'lakeside-library'],
          power_watts: 350,
          weight_kg: 7.5,
          portable: false,
          condition: 'used',
        },
        provenance: {
          brand: 'extracted',
          serial: 'extracted',
          price: 'extracted',
          bought_on: 'ambiguous',
          warranty_until: 'extracted',
          sellers: 'inferred',
          power_watts: 'extracted',
          weight_kg: 'inferred',
          portable: 'inferred',
          condition: 'inferred',
          body: 'inferred',
        },
        sources: [{ identifier: 'INV-0042', label: 'invoice', note: 'the invoice' }],
        body: 'Under the workbench. Probably needs a new fan.',
        tags: ['workshop', 'computer'],
      },
      {
        type: 'item',
        title: 'Workshop computer disk',
        parent: 'workshop-computer',
        fields: { brand: 'Petrel', serial: 'PT-77-0031' },
        provenance: { parent: 'extracted', brand: 'extracted', serial: 'extracted' },
        sources: [{ entry: 'workshop-computer', note: 'listed on its invoice' }],
      },
      {
        type: 'item',
        title: 'Lawn mower',
        parent: 'garden-shed',
        fields: { brand: 'Greenfinch', condition: 'worn', portable: true },
        provenance: {
          parent: 'inferred',
          brand: 'inferred',
          condition: 'inferred',
          portable: 'inferred',
        },
      },
      {
        type: 'item',
        title: 'Bike pump',
        parent: 'garden-shed',
        fields: { brand: 'Swiftair' },
        provenance: { parent: 'inferred', brand: 'inferred' },
      },
      {
        type: 'item',
        title: 'Old radio',
        fields: { brand: 'Halcyon' },
        provenance: { brand: 'inferred' },
      },
      {
        type: 'contract',
        title: 'Home electricity',
        fields: {
          provider: 'bluebell-energy',
          monthly_cost: '64.20 EUR',
          renewal: '2025-11-01',
          notice_period: 'P1M',
          signed_at: '2024-10-15T09:30:00Z',
        },
        provenance: {
          provider: 'extracted',
          monthly_cost: 'extracted',
          renewal: 'extracted',
          notice_period: 'extracted',
          signed_at: 'extracted',
        },
        sources: [{ url: 'https://bluebell.example/account', note: 'the customer account' }],
        valid_from: '2024-11-01',
      },
      {
        type: 'journal',
        title: 'Journal, 30 September',
        slug: 'journal-2026-09-30',
        fields: { mood: 'calm' },
        provenance: { mood: 'extracted', body: 'extracted' },
        sources: [{ said_by: 'morgan-vale', on: '2026-09-30' }],
        body: 'A quiet day in the garden; the mower is getting old.',
      },
      {
        type: 'gadget',
        title: 'Pocket torch',
        fields: { brand: 'Lumen' },
        provenance: { brand: 'inferred' },
      },
      {
        type: 'note',
        title: 'Garden plan 2025',
        body: 'Tomatoes along the fence.',
        provenance: { body: 'extracted' },
        sources: [{ said_by: 'morgan-vale', on: '2025-02-01' }],
        created: '2025-02-01',
        updated: '2025-02-02T08:00:00Z',
      },
      {
        type: 'note',
        title: 'Garden plans',
        body: 'Beans by the [[garden-shed]], an [[herb-spiral]] by the path; mow with the [[lawn-mower]].',
        provenance: { body: 'inferred', summary: 'inferred' },
        summary: 'What grows where this year.',
        aliases: ['Vegetable plan'],
        tags: ['garden'],
        valid_from: '2026-03-01',
        valid_until: '2026-11-30',
      },
    ],
  })

  // Updates: each entry below gets several events.
  await kitchen.call('write', {
    entry: 'workshop-computer',
    fields: { price: '849.00 EUR', condition: 'worn' },
    provenance: { price: 'extracted', condition: 'inferred' },
  })
  await kitchen.call('write', {
    entry: 'workshop-computer',
    body: 'The fan was replaced in October.',
    append: true,
    provenance: { body: 'inferred' },
  })
  await kitchen.call('write', {
    entry: 'workshop-computer',
    edits: [{ find: 'Under the workbench.', replace: 'Under the left workbench.' }],
    provenance: { body: 'inferred' },
  })
  await kitchen.call('write', { entry: 'garden-plans', slug: 'garden-plan' })
  await kitchen.call('write', {
    entry: 'garden-plan',
    body: 'Started on 1 March.',
    prepend: true,
    provenance: { body: 'inferred' },
  })
  await kitchen.call('write', {
    entry: 'garden-plan-2025',
    superseded_by: 'garden-plan',
  })
  await kitchen.call('write', {
    entry: 'alma-quillon',
    fields: { birthday: '1990-04-21' },
    provenance: { birthday: 'extracted' },
  })
  // A move: the shed's stay ends yesterday, the garage's starts today.
  await kitchen.call('write', {
    entry: 'bike-pump',
    parent: 'garage',
    provenance: { parent: 'inferred' },
  })
  await kitchen.call('write', { entry: 'old-radio', archive: { reason: 'given to a neighbour' } })

  // Links: with notes and dates, past stays in a place, a link removed, an occurrence closed.
  await kitchen.call('link', {
    source: 'alma-quillon',
    target: 'northwind-hardware',
    relation: 'works_at',
    provenance: 'extracted',
    note: 'cashier',
    valid_from: '2019-03-01',
    valid_until: '2021-08-31',
  })
  await kitchen.call('link', {
    source: 'bruno-tessaly',
    target: 'bluebell-energy',
    relation: 'works_at',
    provenance: 'inferred',
    note: 'meter reader',
    valid_from: '2022-05-01',
  })
  await kitchen.call('link', {
    source: 'alma-quillon',
    target: 'bruno-tessaly',
    relation: 'knows',
    provenance: 'inferred',
  })
  await kitchen.call('link', {
    source: 'lawn-mower',
    target: 'northwind-hardware',
    relation: 'bought_from',
    provenance: 'inferred',
    note: 'spring sale',
  })
  await kitchen.call('link', {
    source: 'old-radio',
    target: 'garden-shed',
    relation: 'part_of',
    provenance: 'inferred',
    valid_from: '2018-01-01',
    valid_until: '2020-12-31',
  })
  await kitchen.call('link', {
    source: 'old-radio',
    target: 'garden-shed',
    relation: 'part_of',
    period: '2023-01-01',
    provenance: 'inferred',
    valid_from: '2023-01-01',
    valid_until: '2024-06-30',
  })
  await kitchen.call('link', {
    source: 'garden-plan',
    target: 'workshop-computer',
    relation: 'about',
    provenance: 'inferred',
  })
  await kitchen.call('link', {
    source: 'garden-plan',
    target: 'workshop-computer',
    relation: 'about',
    remove: true,
  })
  await kitchen.call('write', {
    type: 'note',
    title: 'Electricity renewal 2025',
    body: 'Renewed for a year.',
    provenance: { body: 'extracted' },
    sources: [{ said_by: 'morgan-vale', on: '2025-10-20' }],
  })
  await kitchen.call('link', {
    source: 'electricity-renewal-2025',
    target: 'home-electricity',
    relation: 'fulfills',
    period: '2025',
    field: 'renewal',
    provenance: 'extracted',
  })

  // Media: from base64, described again, and from an inbox item below.
  const attached = await kitchen.call('attach_media', {
    entry: 'workshop-computer',
    data: PIXEL,
    alt: 'Front of the case',
  })
  await kitchen.call('attach_media', {
    media: idOf('media', attached),
    alt: 'Front of the case, with the new fan',
  })
  await kitchen.call('attach_media', {
    entry: 'garden-plan',
    data: SKETCH,
    alt: 'Sketch of the beds',
  })

  // Type changes: a description, a field added, renamed, given values, made required, lifted.
  await kitchen.call('change_type', {
    type: 'organization',
    description: 'A company, a shop, a library or any body the owner deals with.',
  })
  await kitchen.call('define_type', {
    name: 'person',
    fields: [{ name: 'nickname', kind: 'text' }],
  })
  await kitchen.call('change_type', { type: 'item', field: 'power_watts', rename: 'power_w' })
  await kitchen.call('change_type', {
    type: 'item',
    field: 'condition',
    values: ['new', 'used', 'worn', 'broken'],
  })
  await kitchen.call('change_type', { type: 'contract', field: 'provider', required: true })
  await kitchen.call('define_type', {
    name: 'contract',
    fields: [{ name: 'account_number', kind: 'text', sensitive: true }],
  })
  await kitchen.call('write', {
    entry: 'home-electricity',
    fields: { account_number: 'ACC-5521' },
    provenance: { account_number: 'extracted' },
  })
  hippo(release, url, 'field:sensitive', 'contract', 'account_number', '--off')
  await kitchen.call('change_type', { type: 'note', sensitive: true })
  hippo(release, url, 'type:sensitive', 'note', '--off')

  // Proposals: a merge the owner confirms, a deletion left waiting.
  const merge = await kitchen.call('change_type', {
    type: 'gadget',
    propose: { action: 'merge', into: 'item', mapping: { brand: 'brand' } },
  })
  await kitchen.call('change_type', { type: 'draft', propose: { action: 'delete' } })
  hippo(release, url, 'proposal:confirm', idOf('proposal', merge))

  // Suppositions made known by the owner, a value and a link.
  hippo(release, url, 'supposed:confirm', 'bruno-tessaly', 'employer', '--as', 'morgan-vale')
  hippo(
    release,
    url,
    'supposed:confirm',
    'bruno-tessaly',
    'bluebell-energy',
    '--link',
    'works_at',
    '--as',
    'morgan-vale',
  )

  // The inbox, an item in each state.
  const drop = join(scratch, 'scanner')
  mkdirSync(drop)
  writeFileSync(join(drop, 'receipt.png'), Buffer.from(OTHER_PIXEL, 'base64'))
  writeFileSync(join(drop, 'to-do.txt'), 'Oil the hinges of the shed door.\n')
  hippo(release, url, 'inbox:add', drop, '--origin', 'scanner')
  const garden = await agent(release, url, 'agent-garden', 'read,write')
  const seeds = await garden.call('inbox_add', {
    kind: 'text',
    text: 'Buy seeds for the herb spiral.',
    origin: 'phone',
  })
  const guide = await garden.call('inbox_add', {
    kind: 'url',
    url: 'https://example.org/compost-guide',
    origin: 'phone',
  })
  const { items } = read(Listed, await garden.call('inbox_list', {}))
  const itemNamed = (wanted: string) => {
    const found = items.find(({ name }) => name === wanted)
    if (found === undefined) throw new Error(`No inbox item ${wanted} in ${JSON.stringify(items)}`)
    return found.id
  }
  const receipt = itemNamed('receipt.png')
  const chore = itemNamed('to-do.txt')
  const compost = idOf('item', guide)
  await garden.call('inbox_take', { id: receipt })
  await garden.call('inbox_finish', {
    id: receipt,
    outcome: 'done',
    entries: [{ entry: 'lawn-mower', attach: { alt: 'Receipt of the mower' } }],
  })
  await garden.call('inbox_take', { id: compost })
  await garden.call('inbox_finish', { id: compost, outcome: 'dismissed', reason: 'already read' })
  await garden.call('inbox_take', { id: idOf('item', seeds) })
  await garden.call('inbox_finish', { id: idOf('item', seeds), outcome: 'released' })
  await garden.call('inbox_take', { id: chore })
  await garden.call('write', {
    type: 'note',
    title: 'Shed door',
    body: 'The hinges need oil.',
    provenance: { body: 'extracted', parent: 'extracted' },
    sources: [{ source: 'inbox', item: chore }],
    parent: 'garden-shed',
  })

  // Findings of diagnostics: one seen twice, one merged into it.
  const first = await garden.call('report', {
    title: 'The parent of a moved entry is hard to find',
    kind: 'model_friction',
    place: 'read',
    severity: 'cosmetic',
    trying: 'Finding where the bike pump was before.',
    happened: 'Its former place is only in part_of.',
    expected: 'A word in the path.',
    new: true,
  })
  const number = read(Reported, first).finding.number
  await kitchen.call('report', {
    title: 'The parent of a moved entry is hard to find',
    kind: 'model_friction',
    place: 'read',
    severity: 'cosmetic',
    trying: 'Finding where the old radio was.',
    happened: 'Again only in part_of.',
    expected: 'A word in the path.',
    same_as: number,
  })
  const other = await garden.call('report', {
    title: 'Former places are not in the path',
    kind: 'model_friction',
    place: 'read',
    severity: 'hurts',
    trying: 'Reading the bike pump.',
    happened: 'The garden shed is not named in the path.',
    expected: 'The former place named.',
    new: true,
  })
  hippo(
    release,
    url,
    'findings:merge',
    String(number),
    String(read(Reported, other).finding.number),
  )

  // A heads-up of a coming deadline, told once a day.
  await kitchen.call('briefing', { from: '2027-01-20', to: '2027-02-20' })

  kitchen.close()
  garden.close()
}

await Effect.runPromise(
  Effect.gen(function* () {
    yield* dropScratchDatabase(database)
    const url = yield* createScratchDatabase(database)
    yield* Effect.promise(() => writeBefore(url))
    yield* Effect.promise(() => write(url))
    const dumpCommand = (
      process.env['PG_DUMP'] ?? 'docker run --rm --network host postgres:18.0 pg_dump'
    ).split(' ')
    const [command = 'pg_dump', ...args] = dumpCommand
    const dumped = spawnSync(
      command,
      [...args, '--no-owner', '--no-privileges', '--column-inserts', '--dbname', url],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    if (dumped.status !== 0) throw new Error(`pg_dump: ${dumped.stderr}`)
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(fixture, { recursive: true })
    // `\restrict` guards psql against a hostile dump; this one is loaded by the test, statement by
    // statement, and its random key would change the file at every run.
    writeFileSync(
      join(fixture, 'database.sql'),
      dumped.stdout
        .split('\n')
        .filter((line) => !line.startsWith('\\restrict ') && !line.startsWith('\\unrestrict '))
        .join('\n'),
    )
    cpSync(media, join(fixture, 'media'), { recursive: true })
    for (const key of ['agent-desk.key', 'agent-kitchen.key']) {
      cpSync(join(scratch, key), join(fixture, key))
    }
    yield* dropScratchDatabase(database)
  }).pipe(Effect.ensuring(Effect.sync(() => rmSync(scratch, { recursive: true, force: true })))),
)
console.log(`The fixture of ${version} is written in ${fixture}.`)
