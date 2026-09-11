import { describe, expect, test } from 'bun:test'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import {
  assertFirehose,
  clampLimit,
  createRelayClient,
  type FirehoseFilter,
} from '../src/relay-client.ts'
import type { RelayInfoCache, RelayPolicy } from '../src/relay-info.ts'

function signed(createdAt = 1) {
  return finalizeEvent(
    { kind: 1059, created_at: createdAt, tags: [], content: '' },
    generateSecretKey(),
  )
}

function stubInfo(map: Record<string, Partial<RelayPolicy>> = {}): RelayInfoCache {
  return {
    async policyFor(url) {
      return { url, authRequired: false, paymentRequired: false, ...map[url] }
    },
    clear() {},
  }
}

function fakePool(handler: (relay: string, filter: FirehoseFilter, opts: unknown) => unknown) {
  const calls: Array<{ relay: string; filter: FirehoseFilter; opts: unknown }> = []
  const pool = {
    querySync: async (relays: string[], filter: FirehoseFilter, opts: unknown) => {
      const relay = relays[0]!
      calls.push({ relay, filter, opts })
      return handler(relay, filter, opts)
    },
    close: () => {},
  }
  return { pool, calls }
}

describe('firehose guard (L1: no user enumeration)', () => {
  test('accepts kinds+since, refuses any #p', () => {
    expect(() => assertFirehose({ kinds: [1059], since: 0 })).not.toThrow()
    const leaky = { kinds: [1059], since: 0, '#p': ['a'.repeat(64)] } as unknown as FirehoseFilter
    expect(() => assertFirehose(leaky)).toThrow(/#p/)
    expect(() => assertFirehose({ kinds: [], since: 0 })).toThrow()
  })

  test('refuses #p without touching the pool', async () => {
    let called = false
    const { pool } = fakePool(() => {
      called = true
      return []
    })
    const client = createRelayClient(pool as never)
    const leaky = { kinds: [1059], since: 0, '#p': ['a'.repeat(64)] } as unknown as FirehoseFilter
    await expect(client.querySync(['ws://r'], leaky)).rejects.toThrow(/#p/)
    expect(called).toBe(false)
  })
})

describe('clampLimit', () => {
  test('clamps to relay max_limit', () => {
    expect(clampLimit(500, 300)).toBe(300)
    expect(clampLimit(100, 300)).toBe(100)
    expect(clampLimit(undefined, 300)).toBe(300)
    expect(clampLimit(500, undefined)).toBe(500)
    expect(clampLimit(undefined, undefined)).toBeUndefined()
  })
})

describe('per-relay query', () => {
  test('applies per-relay max_limit and maxWait', async () => {
    const event = signed()
    const { pool, calls } = fakePool(() => [event])
    const client = createRelayClient(pool as never, {
      timeoutMs: 1234,
      relayInfo: stubInfo({ 'wss://limited': { maxLimit: 300 } }),
    })
    const events = await client.querySync(['wss://limited'], {
      kinds: [1059],
      since: 0,
      limit: 500,
    })
    expect(events.map((e) => e.id)).toEqual([event.id])
    expect(calls[0]!.filter.limit).toBe(300)
    expect(calls[0]!.opts).toEqual({ maxWait: 1234 })
  })

  test('skips relays that require auth/payment', async () => {
    const { pool, calls } = fakePool(() => [signed()])
    const client = createRelayClient(pool as never, {
      relayInfo: stubInfo({
        'wss://auth': { authRequired: true },
        'wss://pay': { paymentRequired: true },
      }),
    })
    const events = await client.querySync(['wss://auth', 'wss://pay'], {
      kinds: [1059],
      since: 0,
    })
    expect(events).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('isolates a failing relay from the rest', async () => {
    const event = signed()
    const { pool } = fakePool((relay) => {
      if (relay === 'wss://bad') throw new Error('boom')
      return [event]
    })
    const errors: string[] = []
    const client = createRelayClient(pool as never, {
      relayInfo: stubInfo(),
      onRelayError: (relay) => errors.push(relay),
    })
    const events = await client.querySync(['wss://bad', 'wss://good'], {
      kinds: [1059],
      since: 0,
    })
    expect(events.map((e) => e.id)).toEqual([event.id])
    expect(errors).toEqual(['wss://bad'])
  })

  test('dedups the same event across relays', async () => {
    const event = signed()
    const { pool } = fakePool(() => [event])
    const client = createRelayClient(pool as never, { relayInfo: stubInfo() })
    const events = await client.querySync(['wss://a', 'wss://b'], { kinds: [1059], since: 0 })
    expect(events).toHaveLength(1)
  })
})
