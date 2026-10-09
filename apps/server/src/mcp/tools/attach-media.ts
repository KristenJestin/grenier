import { attachMedia, describeMedia } from '../../core/media/index.ts'
import { Refused } from '../../core/refused.ts'
import { Effect, Schema } from 'effect'
import { defineTool, Reference, refuseExtra } from '../tool.ts'

export const attachMediaTool = defineTool({
  name: 'attach_media',
  description:
    'Attaches an image (SVG included), a video, a sound, a PDF or a copy of a page to an entry: from base64, from a URL, or from an inbox `item` you took (its file is not sent again). The file is kept even if its source disappears; the same file attached twice to an entry is one medium. To change the description of a medium already attached, give its `media` id and the new `alt`, and nothing else: the description is searched with the entry.',
  input: Schema.Struct({
    entry: Schema.optionalKey(Reference).annotate({
      description: 'The slug or id of the entry to attach the file to.',
    }),
    data: Schema.optionalKey(Schema.String).annotate({
      description: 'The file in base64, 20 MB at most. Give `data`, `url` or `item` with `entry`.',
    }),
    url: Schema.optionalKey(Schema.String).annotate({
      description: 'An http or https address the server fetches, 200 MB at most.',
    }),
    item: Schema.optionalKey(Schema.String).annotate({
      description: 'The id of an inbox item you took, or just processed: its file is attached.',
    }),
    alt: Schema.optionalKey(Schema.String).annotate({
      description: 'What the file shows, in words: it is searched with the entry.',
    }),
    mime: Schema.optionalKey(Schema.String).annotate({
      description: 'The type you believe it has; the server reads the real one from the content.',
    }),
    media: Schema.optionalKey(Schema.String).annotate({
      description:
        'The id of a medium already attached: give it with `alt` to change its description.',
    }),
  }),
  right: 'write',
  hints: { destructive: true, idempotent: true, openWorld: true },
  run: ({ media, entry, ...file }) =>
    Effect.gen(function* () {
      if (media !== undefined) {
        const { alt, ...others } = file
        yield* refuseExtra('Describing a medium', { entry, ...others })
        if (alt === undefined) {
          return yield* new Refused({ message: 'Describing a medium needs its `alt`.' })
        }
        return yield* describeMedia(media, alt)
      }
      if (entry === undefined) {
        return yield* new Refused({
          message: 'Give the `entry` to attach the file to, or the `media` to describe.',
        })
      }
      return yield* attachMedia({ entry, ...file })
    }),
})
