import { createFileRoute } from '@tanstack/react-router'
import { handleAuth } from '../../../grenier.ts'

/** Better Auth's endpoints. There is no sign-up: the owner and the keys come from the CLI. */
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleAuth(request),
      POST: ({ request }) => handleAuth(request),
    },
  },
})
