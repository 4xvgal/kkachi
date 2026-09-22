import { describe, expect, test } from 'bun:test'
import {
  asInboxPub,
  GIFT_WRAP_KIND,
  type InboxPub,
  type NostrEvent,
  type PushMaterial,
} from 'kkachi/protocol'
import { createMemoryStore, type Store } from '../src/store.ts'
import { createPoller } from '../src/poller.ts'
import { createRateLimiter } from '../src/rate-limit.ts'
import { PushGoneError, type PushSender } from '../src/push-sender.ts'
import type { FirehoseFilter, RelayClient } from '../src/relay-client.ts'
import type { Config } from '../src/config.ts'

const INBOX_A = ('a'.repeat(64)) as InboxPub
const INBOX_B = ('b'.repeat(64)) as InboxPub
const INBOX_C = ('c'.repeat(64)) as InboxPub
const NOW_MS = 1_700_000_000_000
const NOW_SEC = Math.floor(NOW_MS / 1000)

const PUSH: PushMaterial = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'BP', auth: 'AU' },
}

function config(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    relays: ['ws://relay.default'],
    vapid: { publicKey: 'p', privateKey: 's', subject: 'mailto:x@y' },
    corsOrigins: [],
    pollBaseMs: 60_000,
    pollSpreadMs: 15_000,
    pollLookbackSec: 2 * 24 * 60 * 60,
    pollLimit: 500,
    pollMaxPages: 10,
    pollMaxEvents: 5000,
    relayTimeoutMs: 10_000,
    maxPTags: 10,
    authMaxSkewSec: 60,
    pushRateBurst: 5,
    pushRateRefillPerMin: 5,
    apiRateBurst: 10,
    apiRateRefillPerMin: 10,
    maxSubs: 10_000,
    ...over,
  }
}

function ev(id: string, p: string, over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id,
    pubkey: 'sender',
    created_at: NOW_SEC,
    kind: GIFT_WRAP_KIND,
    tags: [['p', p]],
    content: '',
    sig: 'sig',
    ...over,
  }
}

/** Relay double: honors since/until/limit so pagination is exercised. */
function fakeRelay(events: NostrEvent[]): {
  relays: string[][]
  filters: FirehoseFilter[]
  client: RelayClient
} {
  const filters: FirehoseFilter[] = []
  const relays: string[][] = []
  return {
    filters,
    relays,
    client: {
      async querySync(relayList, filter) {
        relays.push(relayList)
        filters.push(filter)
        const since = filter.since
        const until = filter.until ?? Number.POSITIVE_INFINITY
        const limit = filter.limit ?? Number.POSITIVE_INFINITY
        return events
          .filter((e) => e.created_at >= since && e.created_at <= until)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, limit)
      },
    },
  }
}

async function setup(opts: {
  events?: NostrEvent[]
  subs?: Array<{ inbox: InboxPub; relays?: string[] }>
  cfg?: Partial<Config>
  sender?: PushSender
}): Promise<{
  store: Store
  poller: ReturnType<typeof createPoller>
  calls: Array<{ push: PushMaterial; payload: string }>
  filters: FirehoseFilter[]
  relaySets: string[][]
  removals: string[]
}> {
  const store = createMemoryStore()
  const calls: Array<{ push: PushMaterial; payload: string }> = []
  const removals: string[] = []
  const relay = fakeRelay(opts.events ?? [])
  const sender: PushSender =
    opts.sender ??
    (async (push, payload) => {
      calls.push({ push, payload })
    })
  const poller = createPoller({
    store,
    relayClient: relay.client,
    sender,
    config: config(opts.cfg),
    now: () => NOW_MS,
    random: () => 0.5,
    onGone: (e) => removals.push(e),
  })
  for (const s of opts.subs ?? []) {
    await store.upsertSub({
      inboxPub: s.inbox,
      filter: { kinds: [GIFT_WRAP_KIND], '#p': [s.inbox] },
      push: PUSH,
      relays: s.relays,
      createdAt: 0,
    })
  }
  return { store, poller, calls, filters: relay.filters, relaySets: relay.relays, removals }
}

describe('poller.tick (fixed lookback window)', () => {
  test('does nothing without subscribers', async () => {
    const { poller, filters } = await setup({ events: [ev('1', INBOX_A)] })
    const res = await poller.tick()
    expect(res).toEqual({ scanned: 0, fresh: 0, targets: 0, pushed: 0, rateLimited: 0 })
    expect(filters).toHaveLength(0)
  })

  test('pushes once per matched target, content-less', async () => {
    const { store, poller, calls, filters } = await setup({
      subs: [{ inbox: INBOX_A }, { inbox: INBOX_B }],
      events: [ev('1', INBOX_A), ev('2', INBOX_A), ev('3', INBOX_B), ev('4', INBOX_C)],
    })
    await store.listSubs()
    const res = await poller.tick()
    expect(res.pushed).toBe(2)
    expect(res.targets).toBe(2)
    expect(calls.every((c) => c.payload === JSON.stringify({ v: 1 }))).toBe(true)
    expect(filters[0]!.kinds).toEqual([GIFT_WRAP_KIND])
    expect(filters[0]!.since).toBe(NOW_SEC - 2 * 24 * 60 * 60)
    expect(filters[0]!.until).toBe(NOW_SEC)
    expect(filters[0]!.limit).toBe(500)
    expect(Object.keys(filters[0]!)).not.toContain('#p')
  })

  test('dedups seen events across ticks (no re-push)', async () => {
    const { store, poller, calls } = await setup({
      subs: [{ inbox: INBOX_A }],
      events: [ev('1', INBOX_A)],
    })
    await store.listSubs()
    await poller.tick()
    const second = await poller.tick()
    expect(calls).toHaveLength(1)
    expect(second.fresh).toBe(0)
    expect(second.scanned).toBe(1)
  })

  test('retention uses observation time, not forged created_at', async () => {
    const store = createMemoryStore()
    await store.upsertSub({
      inboxPub: INBOX_A,
      filter: { kinds: [GIFT_WRAP_KIND], '#p': [INBOX_A] },
      push: PUSH,
      createdAt: 0,
    })
    // Hostile relay ignores `since` and keeps returning an ancient event.
    const ancient = ev('ancient', INBOX_A, { created_at: 1 })
    const relay: RelayClient = {
      async querySync() {
        return [ancient]
      },
    }
    const calls: string[] = []
    const poller = createPoller({
      store,
      relayClient: relay,
      sender: async (_push, payload) => {
        calls.push(payload)
      },
      config: config(),
      now: () => NOW_MS,
      random: () => 0.5,
    })

    await poller.tick()
    await poller.tick()
    // seen_at is the observation time, so prune (now - lookback) keeps it.
    expect(calls).toHaveLength(1)
  })

  const ignoreCases: Array<{ name: string; event: NostrEvent; scanned?: number }> = [
    {
      name: 'events older than the window',
      event: ev('old', INBOX_A, { created_at: NOW_SEC - 3 * 24 * 60 * 60 }),
      scanned: 0,
    },
    {
      name: 'future-dated events (until clamp)',
      event: ev('future', INBOX_A, { created_at: NOW_SEC + 1000 }),
    },
    { name: 'non gift-wrap kinds', event: ev('n', INBOX_A, { kind: 1 }) },
    {
      name: 'events over max p tags',
      event: ev('spam', INBOX_A, { tags: Array.from({ length: 11 }, () => ['p', INBOX_A]) }),
    },
  ]

  test('ignores out-of-scope events (old/future/wrong kind/over max p tags)', async () => {
    for (const c of ignoreCases) {
      const { store, poller, calls } = await setup({ subs: [{ inbox: INBOX_A }], events: [c.event] })
      await store.listSubs()
      const res = await poller.tick()
      expect(calls, c.name).toHaveLength(0)
      if (c.scanned !== undefined) expect(res.scanned).toBe(c.scanned)
    }
  })

  const relayCases: Array<{
    name: string
    subs: Array<{ inbox: InboxPub; relays?: string[] }>
    cfg: Partial<Config>
    expected: string[]
  }> = [
    {
      name: 'queries the union of per-subscriber relays',
      subs: [
        { inbox: INBOX_A, relays: ['wss://a.example'] },
        { inbox: INBOX_B, relays: ['wss://b.example'] },
      ],
      cfg: {},
      expected: ['wss://a.example', 'wss://b.example'],
    },
    {
      name: 'falls back to global relays when subscriber has none',
      subs: [{ inbox: INBOX_A }],
      cfg: { relays: ['ws://global.example'] },
      expected: ['ws://global.example'],
    },
    {
      name: 'drops private/loopback client relays, falls back to global',
      subs: [{ inbox: INBOX_A, relays: ['ws://127.0.0.1/relay', 'ws://10.0.0.1/relay'] }],
      cfg: { relays: ['wss://global.example'] },
      expected: ['wss://global.example'],
    },
    {
      name: 'keeps only allowed client relays',
      subs: [{ inbox: INBOX_A, relays: ['ws://127.0.0.1/relay', 'wss://ok.example'] }],
      cfg: { relays: ['wss://global.example'] },
      expected: ['wss://ok.example'],
    },
    {
      name: 'global relays are operator-trusted (local relay allowed)',
      subs: [{ inbox: INBOX_A }],
      cfg: { relays: ['ws://localhost:4444/relay'] },
      expected: ['ws://localhost:4444/relay'],
    },
  ]

  test('selects relays: per-subscriber union, else global fallback', async () => {
    for (const c of relayCases) {
      const { store, poller, relaySets } = await setup({
        subs: c.subs,
        cfg: c.cfg,
        events: [ev('1', INBOX_A)],
      })
      await store.listSubs()
      await poller.tick()
      expect([...relaySets[0]!].sort(), c.name).toEqual([...c.expected].sort())
    }
  })

  test('drops subscription on gone (410/404)', async () => {
    const { store, poller, removals } = await setup({
      subs: [{ inbox: INBOX_A }],
      events: [ev('1', INBOX_A)],
      sender: async () => {
        throw new PushGoneError(PUSH.endpoint)
      },
    })
    await store.listSubs()
    await poller.tick()
    expect(await store.countSubs()).toBe(0)
    expect(removals).toEqual([PUSH.endpoint])
  })
  test('caps outbound pushes per target (relay-injection defense)', async () => {
    const store = createMemoryStore()
    await store.upsertSub({
      inboxPub: INBOX_A,
      filter: { kinds: [GIFT_WRAP_KIND], '#p': [INBOX_A] },
      push: PUSH,
      createdAt: 0,
    })
    let n = 0
    const relay: RelayClient = {
      async querySync() {
        n += 1
        return [ev(`e${n}`, INBOX_A, { created_at: NOW_SEC })]
      },
    }
    const calls: string[] = []
    const poller = createPoller({
      store,
      relayClient: relay,
      sender: async (_push, payload) => {
        calls.push(payload)
      },
      config: config(),
      now: () => NOW_MS,
      random: () => 0.5,
      pushLimiter: createRateLimiter({ capacity: 1, refillPerSec: 0 }, () => NOW_MS),
    })

    const first = await poller.tick()
    const second = await poller.tick()
    const third = await poller.tick()

    expect(first.pushed).toBe(1)
    expect(first.rateLimited).toBe(0)
    expect(second.pushed).toBe(0)
    expect(second.rateLimited).toBe(1)
    expect(third.rateLimited).toBe(1)
    expect(calls).toHaveLength(1)
  })
})

describe('store-backed active inbox', () => {
  test('opaque keys only', async () => {
    const store = createMemoryStore()
    await store.upsertSub({
      inboxPub: asInboxPub(INBOX_A),
      filter: { kinds: [GIFT_WRAP_KIND], '#p': [INBOX_A] },
      push: PUSH,
      createdAt: 0,
    })
    expect((await store.listSubs()).map((s) => s.inboxPub)).toEqual([INBOX_A])
  })
})
