import { describe, expect, test } from 'bun:test'
import { createRelayInfoCache } from '../src/relay-info.ts'

describe('relay info cache (NIP-11)', () => {
  test('parses limitation and caches within ttl', async () => {
    let calls = 0
    const cache = createRelayInfoCache({
      fetchInfo: async () => {
        calls += 1
        return { limitation: { max_limit: 300, auth_required: false, payment_required: false } }
      },
      now: () => 1000,
      ttlMs: 1000,
    })
    expect(await cache.policyFor('wss://r')).toMatchObject({ maxLimit: 300, authRequired: false })
    await cache.policyFor('wss://r')
    expect(calls).toBe(1)
  })

  test('marks auth/payment required relays', async () => {
    const cache = createRelayInfoCache({
      fetchInfo: async () => ({ limitation: { auth_required: true, payment_required: true } }),
    })
    expect(await cache.policyFor('wss://r')).toMatchObject({
      authRequired: true,
      paymentRequired: true,
    })
  })

  test('fetch failure → permissive default, still cached', async () => {
    let calls = 0
    const cache = createRelayInfoCache({
      fetchInfo: async () => {
        calls += 1
        throw new Error('no NIP-11')
      },
      now: () => 0,
      ttlMs: 1000,
    })
    expect(await cache.policyFor('ws://localhost:4444/relay')).toMatchObject({
      authRequired: false,
      paymentRequired: false,
    })
    await cache.policyFor('ws://localhost:4444/relay')
    expect(calls).toBe(1)
  })

  test('ttl expiry refetches', async () => {
    let t = 0
    let calls = 0
    const cache = createRelayInfoCache({
      fetchInfo: async () => {
        calls += 1
        return {}
      },
      now: () => t,
      ttlMs: 100,
    })
    await cache.policyFor('wss://r')
    t = 200
    await cache.policyFor('wss://r')
    expect(calls).toBe(2)
  })
})
