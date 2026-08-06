import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// API routes served by apps/plane's Hono app; proxied here so `pnpm dev` can hit them against
// `wrangler dev` without CORS. Independent of wrangler.jsonc's `run_worker_first` (that list is
// inverted — everything but built assets — because it decides Worker-vs-ASSETS inside the
// deployed Worker; this one is dev-only routing between two separate local servers).
const API_PATHS = ['/servers', '/plans', '/enrolments', '/daemon', '/doc', '/health']
const PLANE_URL = process.env.PLANE_URL ?? 'http://localhost:8787'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    viteReact(),
  ],
  server: {
    // Deliberately obscure port: 3000/5173/8080 are contested on a machine where many
    // agents run dev servers at once. Vite bumps to the next port if even this is taken.
    port: 47811,
    proxy: Object.fromEntries(API_PATHS.map((path) => [path, { target: PLANE_URL, ws: true }])),
  },
})

export default config
