import { createFileRoute } from '@tanstack/react-router'
import { health } from '../grenier.ts'

export const Route = createFileRoute('/health')({
  server: { handlers: { GET: () => health() } },
})
