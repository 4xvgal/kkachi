/**
 * PWA demo dev server.
 *
 *   bun run pwa
 *
 * Bundles app.ts + sw.ts with Bun, writes config.js from env, and serves the
 * demo on PWA_PORT (default 5173). The kkachi server is a different origin, so
 * start it with CORS_ORIGIN set to this origin, e.g.:
 *
 *   CORS_ORIGIN=http://localhost:5173 bun run server
 */

import { join } from 'node:path'

const dir = import.meta.dir
const dist = join(dir, 'dist')
const port = Number(process.env.PWA_PORT ?? 5173)
const serverUrl = process.env.KKACHI_URL ?? 'http://localhost:8787'
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? ''
const relayUrl =
  process.env.PWA_RELAY ?? process.env.RELAYS?.split(',')[0]?.trim() ?? 'ws://localhost:4444/relay'

if (!vapidPublicKey) {
  console.warn('[pwa] VAPID_PUBLIC_KEY is empty — push subscribe will fail (set it in .env)')
}

const build = await Bun.build({
  entrypoints: [join(dir, 'app.ts'), join(dir, 'sw.ts')],
  outdir: dist,
  target: 'browser',
  sourcemap: 'inline',
})
if (!build.success) {
  for (const message of build.logs) console.error(message)
  process.exit(1)
}

await Bun.write(
  join(dist, 'config.js'),
  `window.KKACHI_CONFIG = ${JSON.stringify({ serverUrl, vapidPublicKey, relayUrl })};\n`,
)

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const rel = path === '/' ? '/index.html' : path
    const fromDist = rel !== '/index.html'
    const file = Bun.file(join(fromDist ? dist : dir, rel))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = rel.slice(rel.lastIndexOf('.'))
    return new Response(file, {
      headers: { 'content-type': contentTypes[ext] ?? 'application/octet-stream' },
    })
  },
})

console.log(`[pwa] http://localhost:${port}`)
console.log(`[pwa] server = ${serverUrl}`)
console.log(`[pwa] relay  = ${relayUrl}`)
console.log(`[pwa] start the server with: CORS_ORIGIN=http://localhost:${port} bun run server`)
