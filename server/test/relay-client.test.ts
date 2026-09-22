import { describe, expect, test } from 'bun:test'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import {
  assertFirehose,
  createRelayClient,
  type FirehoseFilter,
  type RelayStat,
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

const until = 1_000_000
const filter: FirehoseFilter = { kinds: [1059], since: 0, until }

describe('firehose guard (L1: no user enumeration)', () => {
  test('accepts kinds+since; refuses #p and empty kinds', () => {
    expect(() => assertFirehose({ kinds: [1059], since: 0 })).not.toThrow()
    expect(() => assertFirehose({ kinds: [], since: 0 })).toThrow()
    const leaky = { kinds: [1059], since: 0, '#p': ['a'.repeat(64)] } as unknown as FirehoseFilter
    expect(() => assertFirehose(leaky)).toThrow(/#p/)
  })

  test('refuses #p without touching the pool', async () => {
    let called = false
    const { pool } = fakePool(() => {
      called = true
      return []
    })
    const client = createRelayClient(pool as never)
    const leaky = { ...filter, '#p': ['a'.repeat(64)] } as unknown as FirehoseFilter
    await expect(client.querySync(['ws://r'], leaky)).rejects.toThrow(/#p/)
    expect(called).toBe(false)
  })
})

describe('per-relay query + policy', () => {
  test('clamps limit to max_limit and passes maxWait', async () => {
    const event = signed(999_000)
    const { pool, calls } = fakePool(() => [event])
    const client = createRelayClient(pool as never, {
      timeoutMs: 1234,
      relayInfo: stubInfo({ 'wss://limited': { maxLimit: 300 } }),
    })
    const events = await client.querySync(['wss://limited'], { ...filter, limit: 500 })
    expect(events.map((e) => e.id)).toEqual([event.id])
    expect(calls[0]!.filter.limit).toBe(300)
    expect(calls[0]!.opts).toEqual({ maxWait: 1234 })
  })

  test('skips relays that require auth/payment', async () => {
    const { pool, calls } = fakePool(() => [signed()])
    const client = createRelayClient(pool as never, {
      relayInfo: stubInfo({ 'wss://auth': { authRequired: true }, 'wss://pay': { paymentRequired: true } }),
    })
    expect(await client.querySync(['wss://auth', 'wss://pay'], filter)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('paginates with until and reports stats', async () => {
    const a = signed(100)
    const b = signed(99)
    const c = signed(98)
    const pages = [[a, b], [c]]
    let i = 0
    const { pool, calls } = fakePool(() => pages[i++] ?? [])
    const stats: RelayStat[] = []
    const client = createRelayClient(pool as never, {
      relayInfo: stubInfo(),
      onRelayStat: (s) => stats.push(s),
    })
    const events = await client.querySync(['wss://r'], { ...filter, limit: 2 })
    expect(events.map((e) => e.id).sort()).toEqual([a.id, b.id, c.id].sort())
    expect(calls.map((c) => c.filter.until)).toEqual([until, 98]) // oldest(99) - 1
    expect(stats[0]).toMatchObject({ pages: 2, events: 3, done: true })
  })

  test('enforces maxPages and maxEvents budgets', async () => {
    const pages = () => {
      let n = 0
      return fakePool(() => [signed(100 - n++)])
    }
    const a = pages()
    const byPages = createRelayClient(a.pool as never, {
      relayInfo: stubInfo(),
      maxPages: 3,
    })
    expect(await byPages.querySync(['wss://r'], { ...filter, limit: 1 })).toHaveLength(3)
    expect(a.calls).toHaveLength(3)

    const b = pages()
    const byEvents = createRelayClient(b.pool as never, {
      relayInfo: stubInfo(),
      maxEvents: 2,
      maxPages: 10,
    })
    expect(await byEvents.querySync(['wss://r'], { ...filter, limit: 1 })).toHaveLength(2)
    expect(b.calls).toHaveLength(2)
  })

  test('isolates a failing relay and dedups across relays', async () => {
    const event = signed(999_000)
    const { pool } = fakePool((relay) => {
      if (relay === 'wss://bad') throw new Error('boom')
      return [event]
    })
    const errors: string[] = []
    const client = createRelayClient(pool as never, {
      relayInfo: stubInfo(),
      onRelayError: (relay) => errors.push(relay),
    })
    const events = await client.querySync(['wss://bad', 'wss://good'], filter)
    expect(events.map((e) => e.id)).toEqual([event.id])
    expect(errors).toEqual(['wss://bad'])
  })
})
