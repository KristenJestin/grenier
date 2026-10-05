import { createFileRoute } from '@tanstack/react-router'
import { handleMedia } from '../../grenier.ts'

/** A file attached to an entry, by its hash, for a valid key. */
export const Route = createFileRoute('/media/$hash')({
  server: {
    handlers: { GET: ({ request, params }) => handleMedia(request, params.hash) },
  },
})
