import { readFileOf } from '../../core/media/files.ts'
import { Effect, Option, Schema } from 'effect'
import { McpSchema } from 'effect/ai'
import sharp from 'sharp'

/** A file an answer of `inbox_take` holds, as far as its content needs it. */
const Held = Schema.Struct({
  sha256: Schema.NullOr(Schema.String),
  mime: Schema.NullOr(Schema.String),
})

/** What `inbox_take` and `inbox_peek` answer: one item, or several. */
export const InboxTaken = Schema.Union([
  Schema.Struct({ item: Held }),
  Schema.Struct({ items: Schema.Array(Held) }),
])

/** The longest side of an image shown to an agent: enough to read it, small in its context. */
const LONGEST = 1568

/** An image file, reduced, for the agent to see; none for any other file, or one sharp cannot read. */
const imageOf = Effect.fn('imageOf')(function* ({ sha256, mime }: typeof Held.Type) {
  if (sha256 === null || mime === null || !mime.startsWith('image/')) return []
  const bytes = yield* readFileOf(sha256)
  const reduced = yield* Effect.tryPromise(() =>
    sharp(bytes)
      .resize({ width: LONGEST, height: LONGEST, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer(),
  ).pipe(Effect.option)
  return Option.match(reduced, {
    onNone: () => [],
    onSome: (image) => [
      { type: 'image' as const, data: new Uint8Array(image), mimeType: 'image/png' },
    ],
  })
})

/**
 * The content of an answer of `inbox_take` or `inbox_peek`: the items as JSON and, for one item
 * that is an image, the image itself, reduced, for the agent to see. Any other file, and the
 * images of several items taken at once, are given by their address only.
 */
export const takenContent = Effect.fn('takenContent')(function* (answer: Schema.JsonObject) {
  const text = { type: 'text' as const, text: JSON.stringify(answer) }
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(InboxTaken)(answer))
  // One item only: several images at once would go past what an agent can read in one answer;
  // each is fetched at its `media_url`, or seen with `inbox_peek`.
  const held = decoded !== undefined && 'item' in decoded ? [decoded.item] : []
  const images = yield* Effect.forEach(held, imageOf)
  return new McpSchema.CallToolResult({ content: [text, ...images.flat()] })
})
