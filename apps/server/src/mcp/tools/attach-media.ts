import { attachMedia } from '../../core/media/index.ts'
import { Schema } from 'effect'
import { defineTool, Reference } from '../tool.ts'

export const attachMediaTool = defineTool({
  name: 'attach_media',
  description:
    'Attaches an image (SVG included), a video, a sound, a PDF or a copy of a page to an entry: from base64, from a URL, or from an inbox `item` you took (its file is not sent again). The file is kept even if its source disappears; the same file attached twice to an entry is one medium.',
  input: Schema.Struct({
    entry: Reference,
    data: Schema.optionalKey(Schema.String).annotate({
      description: 'The file in base64, 20 MB at most. Give `data`, `url` or `item`.',
    }),
    url: Schema.optionalKey(Schema.String).annotate({
      description: 'An http or https address the server fetches, 200 MB at most.',
    }),
    item: Schema.optionalKey(Schema.String).annotate({
      description: 'The id of an inbox item you took, or just processed: its file is attached.',
    }),
    alt: Schema.optionalKey(Schema.String).annotate({ description: 'What the file shows.' }),
    mime: Schema.optionalKey(Schema.String).annotate({
      description: 'The type you believe it has; the server reads the real one from the content.',
    }),
  }),
  right: 'write',
  run: (input) => attachMedia(input),
})
