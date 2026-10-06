import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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

/**
 * Keeps a file already on disk, written at `path` by a download: moved under its hash, or
 * removed when that hash is kept already.
 */
export const keepFile = Effect.fn('keepFile')(function* (path: string, hash: string) {
  const directory = yield* mediaDirectory
  const target = pathOf(directory, hash)
  yield* Effect.promise(async () => {
    const present = await stat(target).then(
      () => true,
      () => false,
    )
    if (present) return rm(path, { force: true })
    await mkdir(join(directory, hash.slice(0, 2)), { recursive: true })
    await rename(path, target)
  })
})

/** Where a download is written while it arrives: a name of its own, beside the kept files. */
export const incomingPath = Effect.fn('incomingPath')(function* () {
  const directory = yield* mediaDirectory
  yield* Effect.promise(() => mkdir(join(directory, 'incoming'), { recursive: true }))
  return join(directory, 'incoming', randomUUID())
})

/** The first bytes of a file on disk, enough to tell its type and its dimensions. */
export const headOf = Effect.fn('headOf')(function* (path: string) {
  return yield* Effect.promise(async () => {
    const file = await open(path)
    try {
      const head = new Uint8Array(64 * 1024)
      const { bytesRead } = await file.read(head, 0, head.length, 0)
      return head.slice(0, bytesRead)
    } finally {
      await file.close()
    }
  })
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

/**
 * Addresses of the machine and its networks, which a fetch must not reach unless allowed. An
 * IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is checked against the IPv4 ranges by BlockList
 * itself, so no rule names `::ffff:0:0/96`: such a rule would match every IPv4 address.
 */
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
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    // Reserved, up to the broadcast address 255.255.255.255.
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv4')
  }
  for (const [network, prefix] of [
    // IPv4-compatible, which holds the unspecified address `::` and the loopback `::1`.
    ['::', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv6')
  }
  return list
})()

const LIMIT = 200 * 1024 * 1024
const TIMEOUT = 30_000

/** An address a host name resolves to. */
export type ResolvedAddress = { readonly address: string; readonly family: number }

/** Whether an address belongs to the machine or its networks, which a fetch must not reach. */
export const isPrivateAddress = ({ address, family }: ResolvedAddress) =>
  PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4')

/**
 * How a host name becomes addresses: the system's DNS. A test gives its own, to see which address a
 * fetch connects to.
 */
export const HostResolver = Context.Reference<
  (host: string) => Promise<ReadonlyArray<ResolvedAddress>>
>('@grenier/core/media/HostResolver', {
  defaultValue: () => (host) => lookup(host, { all: true }),
})

/**
 * What a request answered: its status, where it redirects, and, when its body was read, the hash
 * and size of the file it was written to.
 */
interface Answer {
  readonly status: number
  readonly location: string | undefined
  readonly file: { readonly sha256: string; readonly size: number } | undefined
  readonly tooLarge: boolean
}

/**
 * One GET, connected to `pinned`, the address that was checked, whatever the name resolves to now:
 * a DNS answer that changes between the check and the connection cannot lead it elsewhere. TLS
 * still checks the certificate against the name of the URL. The body goes to the file `into` as
 * it arrives, hashed on the way: it is never held whole in memory.
 */
export const getPinned = (
  url: URL,
  pinned: ResolvedAddress,
  limit: number,
  timeout: number,
  into: string,
) =>
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
          resolve({ status, location, file: undefined, tooLarge: false })
          return
        }
        const hash = createHash('sha256')
        const file = createWriteStream(into)
        let total = 0
        response.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > limit) {
            response.destroy()
            file.destroy()
            resolve({ status, location, file: undefined, tooLarge: true })
            return
          }
          hash.update(chunk)
          file.write(chunk)
        })
        response.on('end', () =>
          file.end(() =>
            resolve({
              status,
              location,
              file: { sha256: hash.digest('hex'), size: total },
              tooLarge: false,
            }),
          ),
        )
        response.on('error', reject)
        file.on('error', reject)
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
 * The file is written to disk as it arrives; the caller keeps it (`keepFile`) or removes it.
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
    const reachesPrivate = addresses.some(isPrivateAddress)
    const [pinned] = addresses
    if (pinned === undefined) {
      return yield* refuse(`The host of \`${current}\` cannot be found.`)
    }
    if (reachesPrivate && !allowPrivate) {
      return yield* refuse(
        `The URL \`${current}\` leads to a private address: Grenier fetches only from the Internet.`,
      )
    }
    const into = yield* incomingPath()
    const answer = yield* Effect.tryPromise({
      try: () => getPinned(url, pinned, LIMIT, TIMEOUT, into),
      catch: () => new Refused({ message: `The URL \`${current}\` could not be fetched.` }),
    }).pipe(Effect.tapError(() => Effect.promise(() => rm(into, { force: true }))))
    if (answer.file === undefined) yield* Effect.promise(() => rm(into, { force: true }))
    if (answer.status >= 300 && answer.status < 400 && answer.location !== undefined) {
      current = new URL(answer.location, url).toString()
      continue
    }
    if (answer.tooLarge) return yield* refuse(`The file at \`${current}\` is larger than 200 MB.`)
    if (answer.file === undefined) {
      return yield* refuse(`The URL \`${current}\` answered ${answer.status}.`)
    }
    return { path: into, ...answer.file }
  }
  return yield* refuse(`The URL \`${address}\` redirects too many times.`)
})
