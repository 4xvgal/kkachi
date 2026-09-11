/**
 * Relay round-trip integration test.
 *
 * Skipped unless RELAY_URL is set. `server/scripts/relay-test.ts` starts a
 * local fonstr relay and sets it, so this file stays a no-op in `bun test`.
 */

import { test, expect } from 'bun:test'
import { finalizeEvent, generateSecretKey, SimplePool } from 'nostr-tools'
import { GIFT_WRAP_KIND, type InboxPub, type PushMaterial } from 'kkachi/protocol'
import { deriveInboxPub } from 'kkachi/inbox-key'
import { createMemoryStore } from '../src/store.ts'
import { createRelayClient } from '../src/relay-client.ts'
import { createPoller } from '../src/poller.ts'
import type { Config } from '../src/config.ts'

const RELAY_URL = process.env.RELAY_URL
const run = RELAY_URL ? test : test.skip

const PUSH: PushMaterial = {
  endpoint: 'https://push.example/relay-test',
  keys: { p256dh: 'BP', auth: 'AU' },
}

function relayConfig(): Config {
  return {
    port: 0,
    relays: [RELAY_URL!],
    vapid: { publicKey: 'p', privateKey: 's', subject: 'mailto:x@y' },
    pollBaseMs: 60_000,
    pollSpreadMs: 0,
    pollLookbackSec: 2 * 24 * 60 * 60 + 3600,
    pollLimit: 500,
    pollMaxPages: 10,
    relayTimeoutMs: 10_000,
    maxPTags: 10,
    authMaxSkewSec: 60,
    pushRateBurst: 5,
    pushRateRefillPerMin: 5,
    apiRateBurst: 10,
    apiRateRefillPerMin: 10,
    maxSubs: 10_000,
  }
}

async function publishGiftWrap(inbox: InboxPub, kind = GIFT_WRAP_KIND): Promise<string> {
  const event = finalizeEvent(
    {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', inbox]],
      content: '',
    },
    generateSecretKey(),
  )
  const pool = new SimplePool()
  try {
    const results = await Promise.allSettled(pool.publish([RELAY_URL!], event))
    const ok = results.some((r) => r.status === 'fulfilled')
    if (!ok) {
      const reasons = results
        .map((r) => (r.status === 'rejected' ? String(r.reason) : String(r.value)))
        .join('; ')
      throw new Error(`relay rejected event: ${reasons}`)
    }
  } finally {
    pool.close([])
  }
  await new Promise((r) => setTimeout(r, 300))
  return event.id
}

run('poller delivers a push for a gift-wrap addressed to an active inbox', async () => {
  const seed = new Uint8Array(32).map((_, i) => (i * 5 + 2) % 256)
  const inbox = await deriveInboxPub(seed, '2026-09')

  const store = createMemoryStore()
  await store.upsertSub({
    inboxPub: inbox,
    filter: { kinds: [GIFT_WRAP_KIND], '#p': [inbox] },
    push: PUSH,
    createdAt: 0,
  })

  const payloads: string[] = []
  const poller = createPoller({
    store,
    relayClient: createRelayClient(),
    sender: async (_push, payload) => {
      payloads.push(payload)
    },
    config: relayConfig(),
  })

  await publishGiftWrap(inbox)
  const res = await poller.tick()

  expect(res.pushed).toBe(1)
  expect(payloads).toEqual([JSON.stringify({ v: 1 })])
})

run('poller ignores a gift-wrap addressed to a non-active inbox', async () => {
  const seed = new Uint8Array(32).map((_, i) => (i * 11 + 7) % 256)
  const active = await deriveInboxPub(seed, '2026-09')
  const other = await deriveInboxPub(seed, '2026-99')

  const store = createMemoryStore()
  await store.upsertSub({
    inboxPub: active,
    filter: { kinds: [GIFT_WRAP_KIND], '#p': [active] },
    push: PUSH,
    createdAt: 0,
  })

  const payloads: string[] = []
  const poller = createPoller({
    store,
    relayClient: createRelayClient(),
    sender: async (_push, payload) => {
      payloads.push(payload)
    },
    config: relayConfig(),
  })

  await publishGiftWrap(other)
  const res = await poller.tick()

  expect(res.pushed).toBe(0)
  expect(payloads).toEqual([])
})
