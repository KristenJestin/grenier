import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, Context, Effect } from 'effect'
import { fileTypeFromBuffer } from 'file-type'
import { Refused } from '../refused.ts'

/** Where files live: `MEDIA_DIR` (`/data/media` in the container), else a folder of the system's. */
export const mediaDirectory = Config.String('MEDIA_DIR').pipe(
  Config.withDefault(join(tmpdir(), 'grenier-media')),
)

export const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A file's place on disk, from its hash: `ab/abcdef…`, so no folder grows too large. */
const pathOf = (directory: string, hash: string) => join(directory, hash.slice(0, 2), hash)

/** Keeps a file once: written only if its hash is not on disk yet, and never half written. */
export const storeFile = Effect.fn('storeFile')(function* (bytes: Uint8Array) {
  const directory = yield* mediaDirectory
  const hash = sha256Of(bytes)
  const path = pathOf(directory, hash)
  yield* Effect.promise(async () => {
    const present = await stat(path).then(
      () => true,
      () => false,
    )
    if (present) return
    await mkdir(join(directory, hash.slice(0, 2)), { recursive: true })
    // A name of its own for each write: two attachments of one file at once do not share it.
    const partial = `${path}.${randomUUID()}.part`
    await writeFile(partial, bytes)
    await rename(partial, path)
  })
  return hash
})

/** The bytes of a file by its hash. */
export const readFileOf = Effect.fn('readFileOf')(function* (hash: string) {
  const directory = yield* mediaDirectory
  return yield* Effect.tryPromise({
    try: () => readFile(pathOf(directory, hash)),
    catch: () => new Refused({ message: `There is no file \`${hash}\`.` }),
  })
})

const KINDS = [
  ['image/', 'image'],
  ['video/', 'video'],
  ['audio/', 'audio'],
  ['application/pdf', 'pdf'],
  ['text/html', 'html'],
] as const
export type MediaKind = (typeof KINDS)[number][1]

const KEPT = 'images, videos, sounds, PDF and HTML only.'

/** An HTML copy of a page, which carries no magic number. */
const looksLikeHtml = (bytes: Uint8Array) =>
  /^\s*(<!doctype html|<html)/i.test(new TextDecoder().decode(bytes.slice(0, 512)))

/** The type of a file, read from its content, never from what the caller says. */
export const typeOf = Effect.fn('typeOf')(function* (bytes: Uint8Array) {
  const detected = yield* Effect.promise(() => fileTypeFromBuffer(bytes))
  const mime = detected?.mime ?? (looksLikeHtml(bytes) ? 'text/html' : undefined)
  if (mime === undefined) {
    return yield* new Refused({
      message: `The type of the file cannot be told from its content: ${KEPT}`,
    })
  }
  const kind = KINDS.find(([prefix]) => mime.startsWith(prefix))?.[1]
  if (kind === undefined) {
    return yield* new Refused({
      message: `The file is \`${mime}\`, which Grenier does not keep: ${KEPT}`,
    })
  }
  return { mime, kind }
})

/** Addresses of the machine and its networks, which a fetch must not reach unless allowed. */
const PRIVATE = (() => {
  const list = new BlockList()
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv4')
  }
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['::ffff:0:0', 96],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv6')
  }
  return list
})()

const LIMIT = 200 * 1024 * 1024
const TIMEOUT = 30_000

/** An address a host name resolves to. */
export type ResolvedAddress = { readonly address: string; readonly family: number }

/**
 * How a host name becomes addresses: the system's DNS. A test gives its own, to see which address a
 * fetch connects to.
 */
export const HostResolver = Context.Reference<
  (host: string) => Promise<ReadonlyArray<ResolvedAddress>>
>('@grenier/core/media/HostResolver', {
  defaultValue: () => (host) => lookup(host, { all: true }),
})

/** What a request answered: its status, where it redirects, and its body if it is to be read. */
interface Answer {
  readonly status: number
  readonly location: string | undefined
  readonly bytes: Uint8Array | undefined
  readonly tooLarge: boolean
}

/**
 * One GET, connected to `pinned`, the address that was checked, whatever the name resolves to now:
 * a DNS answer that changes between the check and the connection cannot lead it elsewhere. TLS
 * still checks the certificate against the name of the URL.
 */
export const getPinned = (url: URL, pinned: ResolvedAddress, limit: number, timeout = TIMEOUT) =>
  new Promise<Answer>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsGet : httpGet)(
      url,
      {
        timeout,
        lookup: (_host, options, callback) =>
          options.all === true
            ? callback(null, [pinned])
            : callback(null, pinned.address, pinned.family),
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if ((status >= 300 && status < 400) || status < 200 || status >= 300) {
          response.resume()
          resolve({ status, location, bytes: undefined, tooLarge: false })
          return
        }
        const chunks: Array<Buffer> = []
        let total = 0
        response.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > limit) {
            response.destroy()
            resolve({ status, location, bytes: undefined, tooLarge: true })
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () =>
          resolve({ status, location, bytes: Buffer.concat(chunks), tooLarge: false }),
        )
        response.on('error', reject)
      },
    )
    // `timeout` only notices a silent connection; this bounds the whole download.
    const deadline = setTimeout(() => request.destroy(new Error('timed out')), timeout)
    request.on('close', () => clearTimeout(deadline))
    request.on('timeout', () => request.destroy(new Error('timed out')))
    request.on('error', reject)
  })

/**
 * Fetches a file from the Internet: http or https only, 200 MB at most, 30 seconds at most, and
 * never from a private address (every redirect is checked too) unless `MEDIA_ALLOW_PRIVATE=true`.
 */
export const fetchFile = Effect.fn('fetchFile')(function* (address: string) {
  const allowPrivate = yield* Config.Boolean('MEDIA_ALLOW_PRIVATE').pipe(Config.withDefault(false))
  const refuse = (message: string) => Effect.fail(new Refused({ message }))
  let current = address
  for (let hop = 0; hop <= 5; hop += 1) {
    const url = URL.canParse(current) ? new URL(current) : undefined
    if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return yield* refuse(`The URL \`${current}\` must be an http or https address.`)
    }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const resolve = yield* HostResolver
    const addresses =
      isIP(host) === 0
        ? yield* Effect.tryPromise({
            try: () => resolve(host),
            catch: () => new Refused({ message: `The host of \`${current}\` cannot be found.` }),
          })
        : [{ address: host, family: isIP(host) }]
    const reachesPrivate = addresses.some(({ address: each, family }) =>
      PRIVATE.check(each, family === 6 ? 'ipv6' : 'ipv4'),
    )
    const [pinned] = addresses
    if (pinned === undefined) {
      return yield* refuse(`The host of \`${current}\` cannot be found.`)
    }
    if (reachesPrivate && !allowPrivate) {
      return yield* refuse(
        `The URL \`${current}\` leads to a private address: Grenier fetches only from the Internet.`,
      )
    }
    const answer = yield* Effect.tryPromise({
      try: () => getPinned(url, pinned, LIMIT),
      catch: () => new Refused({ message: `The URL \`${current}\` could not be fetched.` }),
    })
    if (answer.status >= 300 && answer.status < 400 && answer.location !== undefined) {
      current = new URL(answer.location, url).toString()
      continue
    }
    if (answer.tooLarge) return yield* refuse(`The file at \`${current}\` is larger than 200 MB.`)
    if (answer.bytes === undefined) {
      return yield* refuse(`The URL \`${current}\` answered ${answer.status}.`)
    }
    return new Uint8Array(answer.bytes)
  }
  return yield* refuse(`The URL \`${address}\` redirects too many times.`)
})
