import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigProvider, Effect, Predicate } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { readEntry, writeEntry } from '../../src/core/entries/index.ts'
import { getPinned, isPrivateAddress } from '../../src/core/media/files.ts'
import { attachMedia, describeMedia, HostResolver, readMedia } from '../../src/core/media/index.ts'
import { Refused } from '../../src/core/refused.ts'
import { search } from '../../src/core/search/index.ts'
import { defineType } from '../../src/core/types/index.ts'
import { useScratchDatabase } from './scratch-database.ts'

const run = useScratchDatabase()
const directory = mkdtempSync(join(tmpdir(), 'grenier-media-'))

/** Runs with the media kept in this suite's own folder, and private addresses allowed or not. */
const withMedia =
  (allowPrivate = false) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(
      effect,
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          MEDIA_DIR: directory,
          MEDIA_ALLOW_PRIVATE: String(allowPrivate),
        }),
      ),
    )

/** The sentence a refused effect fails with. */
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E | Refused, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof Refused ? error.message : `not a refusal: ${error}`)),
  )

/** A PNG of one pixel, made for the tests. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const base64 = (text: string | Uint8Array) => Buffer.from(text).toString('base64')

const files = () =>
  readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())

let server: Server
let origin = ''

beforeAll(async () => {
  await run(
    defineType({ name: 'thing', label: 'Thing', description: 'Something kept.', fields: [] }),
  )
  server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(Buffer.from(PIXEL, 'base64'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = `http://127.0.0.1:${address === null || Predicate.isString(address) ? 0 : address.port}`
})

afterAll(() => {
  server.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('an image attached from bytes', () => {
  test('is stored once on disk, under its hash, and served back identical with its type', async () => {
    await run(writeEntry({ type: 'thing', title: 'Lamp' }))
    const { media } = await run(attachMedia({ entry: 'lamp', data: PIXEL }).pipe(withMedia()))
    expect(media).toMatchObject({ kind: 'image', mime: 'image/png', size: 68 })
    expect(media.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(files().map(({ name }) => name)).toEqual([media.sha256])
    const served = await run(readMedia(media.sha256).pipe(withMedia()))
    expect(served.mime).toBe('image/png')
    expect(Buffer.from(served.bytes).toString('base64')).toBe(PIXEL)
    expect((await run(readEntry('lamp'))).media).toEqual([
      expect.objectContaining({ id: media.id, mime: 'image/png', url: `/media/${media.sha256}` }),
    ])
  })

  test('the same image attached to two entries is stored once', async () => {
    await run(writeEntry({ type: 'thing', title: 'Shade' }))
    await run(attachMedia({ entry: 'shade', data: PIXEL }).pipe(withMedia()))
    expect(files()).toHaveLength(1)
    expect((await run(readEntry('shade'))).media).toHaveLength(1)
  })
})

describe('the same file attached several times at once', () => {
  test('every attachment succeeds and the file is kept whole, once', async () => {
    await run(writeEntry({ type: 'thing', title: 'Busy' }))
    const page = base64('<!doctype html><title>Same page, three times</title>')
    const attached = await Promise.all(
      [1, 2, 3].map(() => run(attachMedia({ entry: 'busy', data: page }).pipe(withMedia()))),
    )
    const [hash] = new Set(attached.map(({ media }) => media.sha256))
    expect(attached).toHaveLength(3)
    const served = await run(readMedia(hash ?? '').pipe(withMedia()))
    expect(Buffer.from(served.bytes).toString('base64')).toBe(page)
  })
})

describe('a download that never ends', () => {
  test('is stopped after its time, even when a byte comes now and then', async () => {
    const slow = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      const drip = setInterval(() => response.write('.'), 50)
      response.on('close', () => clearInterval(drip))
    })
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    const address = slow.address()
    const port = address === null || Predicate.isString(address) ? 0 : address.port
    const started = Date.now()
    await expect(
      getPinned(
        new URL(`http://127.0.0.1:${port}/`),
        { address: '127.0.0.1', family: 4 },
        1000,
        400,
        join(directory, 'incoming-slow'),
      ),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(3000)
    slow.close()
  })
})

describe('the type of a file is read from its content', () => {
  test('a file declared as an image but holding a PDF is recorded as a PDF', async () => {
    await run(writeEntry({ type: 'thing', title: 'Manual' }))
    const { media } = await run(
      attachMedia({
        entry: 'manual',
        data: base64('%PDF-1.4\n%invented\n'),
        mime: 'image/png',
      }).pipe(withMedia()),
    )
    expect(media).toMatchObject({ kind: 'pdf', mime: 'application/pdf' })
  })

  test('a file of a kind Grenier does not keep is refused', async () => {
    const gzip = new Uint8Array([
      0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0x03, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ])
    expect(
      await run(refusalOf(attachMedia({ entry: 'manual', data: base64(gzip) }).pipe(withMedia()))),
    ).toBe(
      'The file is `application/gzip`, which Grenier does not keep: images, videos, sounds, PDF and HTML only.',
    )
    expect(
      await run(
        refusalOf(attachMedia({ entry: 'manual', data: base64('just words') }).pipe(withMedia())),
      ),
    ).toBe(
      'The type of the file cannot be told from its content: images, videos, sounds, PDF and HTML only.',
    )
  })

  test('an HTML copy of a page is kept as HTML', async () => {
    const { media } = await run(
      attachMedia({ entry: 'manual', data: base64('<!doctype html><title>Invented</title>') }).pipe(
        withMedia(),
      ),
    )
    expect(media).toMatchObject({ kind: 'html', mime: 'text/html' })
  })
})

describe('a file fetched from a URL', () => {
  test('a URL to a private address is refused by default', async () => {
    expect(
      await run(
        refusalOf(attachMedia({ entry: 'manual', url: `${origin}/pixel` }).pipe(withMedia())),
      ),
    ).toBe(
      `The URL \`${origin}/pixel\` leads to a private address: Grenier fetches only from the Internet.`,
    )
  })

  test('with MEDIA_ALLOW_PRIVATE=true it is fetched, and its type read from the content', async () => {
    const { media } = await run(
      attachMedia({ entry: 'manual', url: `${origin}/pixel` }).pipe(withMedia(true)),
    )
    expect(media).toMatchObject({ mime: 'image/png', source_url: `${origin}/pixel` })
  })

  test('a fetch connects to the address it checked, and never asks the name again', async () => {
    // `files.invalid` resolves nowhere: only the address the check saw can reach the server.
    const resolver = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }])
    const url = origin.replace('127.0.0.1', 'files.invalid')
    const { media } = await run(
      attachMedia({ entry: 'manual', url: `${url}/pixel` }).pipe(
        withMedia(true),
        Effect.provideService(HostResolver, resolver),
      ),
    )
    expect(media).toMatchObject({ mime: 'image/png' })
    const rebinding = () => Promise.resolve([{ address: '10.0.0.7', family: 4 }])
    expect(
      await run(
        refusalOf(
          attachMedia({ entry: 'manual', url: `${url}/pixel` }).pipe(
            withMedia(),
            Effect.provideService(HostResolver, rebinding),
          ),
        ),
      ),
    ).toBe(
      `The URL \`${url}/pixel\` leads to a private address: Grenier fetches only from the Internet.`,
    )
  })

  test('only http and https are fetched', async () => {
    expect(
      await run(
        refusalOf(attachMedia({ entry: 'manual', url: 'file:///etc/hostname' }).pipe(withMedia())),
      ),
    ).toBe('The URL `file:///etc/hostname` must be an http or https address.')
  })
})

describe('the addresses a fetch may reach', () => {
  const v4 = (address: string) => isPrivateAddress({ address, family: 4 })
  const v6 = (address: string) => isPrivateAddress({ address, family: 6 })

  test('a public IPv4 address is accepted', () => {
    expect(['8.8.8.8', '1.1.1.1', '93.184.215.14'].map(v4)).toEqual([false, false, false])
  })

  test('a public IPv4 address written as IPv4-mapped IPv6 is accepted', () => {
    expect(['::ffff:8.8.8.8', '::ffff:1.1.1.1'].map(v6)).toEqual([false, false])
  })

  test('a private IPv4 address written as IPv4-mapped IPv6 is refused', () => {
    expect(['::ffff:127.0.0.1', '::ffff:10.0.0.7', '::ffff:7f00:1'].map(v6)).toEqual([
      true,
      true,
      true,
    ])
  })

  test('the unspecified, CGNAT and benchmarking IPv4 ranges are refused', () => {
    expect(['0.0.0.0', '0.1.2.3', '100.64.0.1', '100.100.100.100', '198.18.0.1'].map(v4)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ])
    expect(['198.19.255.255', '198.20.0.1', '100.128.0.1'].map(v4)).toEqual([true, false, false])
  })

  test('the IPv4 multicast, reserved and broadcast ranges are refused', () => {
    expect(['224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255'].map(v4)).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(v4('223.255.255.255')).toBe(false)
  })

  test('the IPv4-compatible IPv6 range is refused', () => {
    expect(['::', '::1', '::127.0.0.1', '::8.8.8.8'].map(v6)).toEqual([true, true, true, true])
  })

  test('the NAT64 IPv6 ranges are refused', () => {
    expect(['64:ff9b::a00:7', '64:ff9b::8.8.8.8', '64:ff9b:1::1'].map(v6)).toEqual([
      true,
      true,
      true,
    ])
  })

  test('the 6to4 IPv6 range is refused', () => {
    expect(v6('2002:a00:7::1')).toBe(true)
  })

  test('the site-local and multicast IPv6 ranges are refused', () => {
    expect(['fec0::1', 'feff::1', 'ff02::1', 'ff0e::1'].map(v6)).toEqual([true, true, true, true])
  })

  test('the loopback, unique local and link-local IPv6 ranges are still refused', () => {
    expect(['::1', 'fd00::1', 'fe80::1'].map(v6)).toEqual([true, true, true])
  })

  test('a public IPv6 address is accepted', () => {
    expect(['2001:4860:4860::8888', '2606:4700:4700::1111'].map(v6)).toEqual([false, false])
  })

  test('a host resolving to an IPv4-mapped private address is refused before any connection', async () => {
    const resolver = () => Promise.resolve([{ address: '::ffff:10.0.0.7', family: 6 }])
    expect(
      await run(
        refusalOf(
          attachMedia({ entry: 'manual', url: 'http://files.invalid/pixel' }).pipe(
            withMedia(),
            Effect.provideService(HostResolver, resolver),
          ),
        ),
      ),
    ).toBe(
      'The URL `http://files.invalid/pixel` leads to a private address: Grenier fetches only from the Internet.',
    )
  })
})

describe('describing a medium', () => {
  test('makes the entry findable by the words of its description', async () => {
    await run(writeEntry({ type: 'thing', title: 'Postcard' }))
    const { media } = await run(attachMedia({ entry: 'postcard', data: PIXEL }).pipe(withMedia()))
    expect(await run(search('lighthouse'))).toEqual([])
    await run(describeMedia(media.id, 'A red lighthouse at dusk'))
    expect((await run(search('lighthouse'))).map(({ slug }) => slug)).toEqual(['postcard'])
    expect((await run(readEntry('postcard'))).media[0]?.alt).toBe('A red lighthouse at dusk')
  })
})

describe('a file is held in memory once at most', () => {
  test('a download goes to disk as it arrives, hashed on the way', async () => {
    const into = join(directory, 'incoming-test')
    const answer = await getPinned(
      new URL(`${origin}/pixel`),
      { address: '127.0.0.1', family: 4 },
      1000,
      2000,
      into,
    )
    const bytes = readFileSync(into)
    expect(Buffer.from(bytes).toString('base64')).toBe(PIXEL)
    expect(answer.file).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: 68,
    })
    rmSync(into)
  })

  test('a base64 body longer than 20 MB is refused before it is decoded', async () => {
    await run(writeEntry({ type: 'thing', title: 'Heavy' }))
    // Not base64 at all: decoded, it would be almost nothing, so only its length can refuse it.
    const data = '!'.repeat(28 * 1024 * 1024)
    expect(await run(refusalOf(attachMedia({ entry: 'heavy', data }).pipe(withMedia())))).toBe(
      'A file sent as `data` is 20 MB at most: give a `url` for a larger one.',
    )
  })
})

describe('the dimensions of an image', () => {
  test('are measured when it is attached', async () => {
    await run(writeEntry({ type: 'thing', title: 'Frame' }))
    const { media } = await run(attachMedia({ entry: 'frame', data: PIXEL }).pipe(withMedia()))
    expect(media).toMatchObject({ width: 1, height: 1 })
  })
})
