import { describeMedia } from '@grenier/core/media'
import { Schema } from 'effect'
import { defineTool } from '../tool.ts'

export const describeMediaTool = defineTool({
  name: 'describe_media',
  description: 'Describes a medium in words; the description is searched.',
  input: Schema.Struct({
    media: Schema.String.annotate({ description: 'The id of the medium.' }),
    alt: Schema.String.annotate({
      description: 'What the medium shows, in words: it is searched with the entry.',
    }),
  }),
  right: 'write',
  run: ({ media, alt }) => describeMedia(media, alt),
})
