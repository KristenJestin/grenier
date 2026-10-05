import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigProvider, Effect, Predicate } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { readEntry, writeEntry } from '../src/entries/index.ts'
import { attachMedia, describeMedia, readMedia } from '../src/media/index.ts'
import { Refused } from '../src/refused.ts'
import { search } from '../src/search/index.ts'
import { defineType } from '../src/types/index.ts'
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

  test('only http and https are fetched', async () => {
    expect(
      await run(
        refusalOf(attachMedia({ entry: 'manual', url: 'file:///etc/hostname' }).pipe(withMedia())),
      ),
    ).toBe('The URL `file:///etc/hostname` must be an http or https address.')
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
