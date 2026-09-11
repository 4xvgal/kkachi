/**
 * Verify a relay actually persists + serves back events (write/read round-trip).
 *
 *   bun run relay:check wss://relay.example
 *
 * Some relays reply OK to writes but never return the event (filtered, replica
 * lag, or read policy). kkachi needs read-after-write, so check first.
 */

import { finalizeEvent, generateSecretKey, getPublicKey, SimplePool } from 'nostr-tools'

const relay = process.argv[2] ?? process.env.RELAY_URL
if (!relay) {
  console.error('usage: bun run relay:check <wss://relay>')
  process.exit(1)
}

const pool = new SimplePool()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

try {
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  const now = Math.floor(Date.now() / 1000)
  const event = finalizeEvent(
    { kind: 1, created_at: now, tags: [], content: `kkachi relay-check ${now}` },
    sk,
  )

  const results = await Promise.allSettled(pool.publish([relay], event))
  const published = results.some((r) => r.status === 'fulfilled')
  await wait(2500)

  const recall = await pool.querySync([relay], { authors: [pk], limit: 5 })
  const found = recall.some((e) => e.id === event.id)

  console.log(`relay:    ${relay}`)
  console.log(`publish:  ${published ? 'accepted' : 'failed'}`)
  console.log(`recall:   ${found ? 'ok' : 'NOT FOUND'} (${recall.length} by author)`)
  if (!published || !found) process.exitCode = 1
} finally {
  pool.close([])
}
