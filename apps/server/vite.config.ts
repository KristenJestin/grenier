import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  plugins: [tanstackStart()],
  server: { port: Number(process.env['PORT'] ?? 3000) },
})
