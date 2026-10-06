import { readFileOf } from '../../core/media/files.ts'
import { Effect, Option, Schema } from 'effect'
import { McpSchema } from 'effect/ai'
import sharp from 'sharp'

/** What `inbox_take` answers, as far as its content needs it. */
export const InboxTaken = Schema.Struct({
  item: Schema.Struct({
    sha256: Schema.NullOr(Schema.String),
    mime: Schema.NullOr(Schema.String),
  }),
})

/** The longest side of an image shown to an agent: enough to read it, small in its context. */
const LONGEST = 1568

/**
 * The content of an answer of `inbox_take`: the item as JSON and, for an image file, the image
 * itself, reduced, for the agent to see. Any other file is given by its address only.
 */
export const takenContent = Effect.fn('takenContent')(function* (answer: Schema.JsonObject) {
  const text = { type: 'text' as const, text: JSON.stringify(answer) }
  const decoded = Schema.decodeUnknownOption(InboxTaken)(answer)
  const sha256 = Option.getOrUndefined(decoded)?.item.sha256 ?? null
  const mime = Option.getOrUndefined(decoded)?.item.mime ?? null
  if (sha256 === null || mime === null || !mime.startsWith('image/')) {
    return new McpSchema.CallToolResult({ content: [text] })
  }
  const bytes = yield* readFileOf(sha256)
  // An image the library cannot read is given by its address only, like any other file.
  const reduced = yield* Effect.tryPromise(() =>
    sharp(bytes)
      .resize({ width: LONGEST, height: LONGEST, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer(),
  ).pipe(Effect.option)
  return new McpSchema.CallToolResult({
    content: Option.match(reduced, {
      onNone: () => [text],
      onSome: (image) => [
        text,
        { type: 'image' as const, data: new Uint8Array(image), mimeType: 'image/png' },
      ],
    }),
  })
})
