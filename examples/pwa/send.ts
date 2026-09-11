/**
 * Publish a kind:1059 gift-wrap addressed to a demo inbox so the server wakes it.
 *
 *   bun run examples/pwa/send.ts <inboxPub> [relayUrl]
 *
 * Copy the `inboxPub:` value printed by the PWA demo. Run the relay too
 * (`npx fonstr 4444`). For a fast demo set POLL_BASE_MS=5000 on the server.
 */

import { finalizeEvent, generateSecretKey, SimplePool } from 'nostr-tools'

const [inboxPub, relay = 'ws://localhost:4444/relay'] = process.argv.slice(2)
if (!inboxPub) {
  console.error('usage: bun run examples/pwa/send.ts <inboxPub> [relayUrl]')
  process.exit(1)
}

const event = finalizeEvent(
  {
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', inboxPub]],
    content: '',
  },
  generateSecretKey(),
)

const pool = new SimplePool()
try {
  const results = await Promise.allSettled(pool.publish([relay], event))
  const ok = results.some((r) => r.status === 'fulfilled')
  console.log(`${ok ? 'published' : 'FAILED'} ${event.id} via ${relay}`)
  if (!ok) process.exitCode = 1
} finally {
  pool.close([])
}
