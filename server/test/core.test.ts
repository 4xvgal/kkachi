import { describe, expect, test } from 'bun:test'
import { GIFT_WRAP_KIND, HTTP_AUTH_KIND, type InboxPub, type NostrEvent } from 'kkachi/protocol'
import {
  aggregate,
  checkNip98,
  consumeToken,
  isGiftWrap,
  jitter,
  matchInbox,
  nextPage,
  pTags,
  withinMaxPTags,
  type Nip98Claim,
} from '../src/core.ts'

function ev(partial: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'id',
    pubkey: 'pk',
    created_at: 1,
    kind: GIFT_WRAP_KIND,
    tags: [],
    content: '',
    sig: 'sig',
    ...partial,
  }
}

describe('pure core', () => {
  test('matchInbox returns first active p tag, else null', () => {
    const A = ('a'.repeat(64)) as InboxPub
    const B = ('b'.repeat(64)) as InboxPub
    const C = ('c'.repeat(64)) as InboxPub
    const active = new Set<InboxPub>([A, B])
    const table: Array<[string[][], InboxPub | null]> = [
      [[['p', C], ['p', B]], B],
      [[['p', C]], null],
      [[['e', A]], null],
      [[], null],
    ]
    for (const [tags, expected] of table) expect(matchInbox(active, ev({ tags }))).toBe(expected)
    // local-only sanity: the p tag is the opaque inbox, not identity
    expect(pTags(ev({ tags: [['p', B]] }))).toEqual([B])
  })

  test('aggregate keeps one per target, preserves order', () => {
    expect(aggregate(['a', 'a', 'b', 'a'])).toEqual(['a', 'b'])
    expect(aggregate([])).toEqual([])
  })

  test('jitter is bounded by base +/- spread', () => {
    for (const [r, expected] of [
      [0, 45_000],
      [0.5, 60_000],
      [1, 75_000],
    ] as Array<[number, number]>) {
      expect(jitter(r, 60_000, 15_000)).toBe(expected)
    }
  })

  test('withinMaxPTags caps p tags, ignores others', () => {
    const table: Array<[string[][], number, boolean]> = [
      [[['p', 'a'], ['p', 'b']], 2, true],
      [[['p', 'a'], ['p', 'b'], ['p', 'c']], 2, false],
      [[['e', 'a'], ['p', 'b']], 1, true],
    ]
    for (const [tags, max, expected] of table) {
      expect(withinMaxPTags(ev({ tags }), max)).toBe(expected)
    }
  })

  test('isGiftWrap only accepts kind 1059', () => {
    expect(isGiftWrap(ev())).toBe(true)
    expect(isGiftWrap(ev({ kind: 1 }))).toBe(false)
  })

  test('nextPage decides when to stop paging', () => {
    const mk = (created: number[]) => created.map((c, i) => ev({ id: `e${i}`, created_at: c }))
    // empty / exhausted (fewer than limit)
    expect(nextPage({ batch: [], effectiveLimit: 5, since: 0, until: 100 })).toEqual({ done: true })
    expect(nextPage({ batch: mk([10, 9]), effectiveLimit: 5, since: 0, until: 100 })).toEqual({
      done: true,
    })
    // full page, oldest above since -> continue from oldest-1
    expect(nextPage({ batch: mk([50, 40]), effectiveLimit: 2, since: 0, until: 100 })).toEqual({
      done: false,
      until: 39,
    })
    // oldest === until is the legitimate next page -> continue
    expect(nextPage({ batch: mk([50, 40]), effectiveLimit: 2, since: 0, until: 40 })).toEqual({
      done: false,
      until: 39,
    })
    // reached window floor
    expect(nextPage({ batch: mk([50, 5]), effectiveLimit: 2, since: 10, until: 100 })).toEqual({
      done: true,
    })
    // no progress: relay returned events newer than `until` (ignored the cursor)
    expect(nextPage({ batch: mk([100, 100]), effectiveLimit: 2, since: 0, until: 99 })).toEqual({
      done: true,
    })
  })
})

describe('consumeToken', () => {
  const policy = { capacity: 2, refillPerSec: 1 }

  test('bursts to capacity, denies, then refills (capped)', () => {
    let b = consumeToken(undefined, policy, 0)
    expect(b.allowed).toBe(true)
    b = consumeToken(b.bucket, policy, 0)
    expect(b.allowed).toBe(true)
    b = consumeToken(b.bucket, policy, 0)
    expect(b.allowed).toBe(false)
    expect(b.bucket.tokens).toBe(0)
    expect(consumeToken(b.bucket, policy, 1000).allowed).toBe(true)
    expect(consumeToken(undefined, policy, 10_000).bucket.tokens).toBe(policy.capacity - 1)
  })
})

describe('checkNip98', () => {
  const auth = ev({
    kind: HTTP_AUTH_KIND,
    created_at: 1000,
    tags: [['u', 'https://x/p'], ['method', 'POST'], ['payload', 'abc']],
  })
  const base: Nip98Claim = { url: 'https://x/p', method: 'POST', payloadHash: 'abc' }

  test('accepts valid claim, rejects wrong url/hash/stale/kind', () => {
    const table: Array<[NostrEvent, Nip98Claim, number, boolean]> = [
      [auth, base, 1000, true],
      [auth, { ...base, url: 'https://y/p' }, 1000, false],
      [auth, { ...base, payloadHash: 'zzz' }, 1000, false],
      [auth, base, 2000, false],
      [ev({ kind: 1 }), { url: 'https://x/p', method: 'GET' }, 1, false],
    ]
    for (const [event, claim, now, ok] of table) {
      expect(checkNip98(event, claim, now).ok).toBe(ok)
    }
  })
})
