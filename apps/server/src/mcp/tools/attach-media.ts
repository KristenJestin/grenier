import { attachMedia } from '../../core/media/index.ts'
import { Schema } from 'effect'
import { defineTool, Reference } from '../tool.ts'

export const attachMediaTool = defineTool({
  name: 'attach_media',
  description:
    'Attaches an image, a video, a sound, a PDF or a copy of a page to an entry, from base64 or from a URL. The file is kept even if its source disappears.',
  input: Schema.Struct({
    entry: Reference,
    data: Schema.optionalKey(Schema.String).annotate({
      description: 'The file in base64, 20 MB at most. Give `data` or `url`.',
    }),
    url: Schema.optionalKey(Schema.String).annotate({
      description: 'An http or https address the server fetches, 200 MB at most.',
    }),
    alt: Schema.optionalKey(Schema.String).annotate({ description: 'What the file shows.' }),
    mime: Schema.optionalKey(Schema.String).annotate({
      description: 'The type you believe it has; the server reads the real one from the content.',
    }),
  }),
  right: 'write',
  run: (input) => attachMedia(input),
})
