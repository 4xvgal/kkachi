/**
 * Shared Store contract suite. Run it against every adapter so operators can
 * trust that swapping SQLite <-> Postgres <-> memory preserves behavior.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import type { InboxPub } from 'kkachi/protocol'
import type { Store, StoredSub } from '../src/store.ts'

const INBOX_A = ('a'.repeat(64)) as InboxPub
const INBOX_B = ('b'.repeat(64)) as InboxPub

function sub(inboxPub: InboxPub, over: Partial<StoredSub> = {}): StoredSub {
  return {
    inboxPub,
    filter: { kinds: [1059], '#p': [inboxPub] },
    push: { endpoint: 'https://push.example/x', keys: { p256dh: 'BP', auth: 'AU' } },
    createdAt: 100,
    ...over,
  }
}

export function runStoreContract(name: string, makeStore: () => Promise<Store>): void {
  describe(`Store contract: ${name}`, () => {
    let store: Store

    beforeEach(async () => {
      store = await makeStore()
    })

    test('upsert + get round-trips, including relays', async () => {
      await store.upsertSub(sub(INBOX_A, { relays: ['wss://inbox.example'] }))
      const got = await store.getSub(INBOX_A)
      expect(got?.inboxPub).toBe(INBOX_A)
      expect(got?.relays).toEqual(['wss://inbox.example'])
      expect(got?.push.endpoint).toBe('https://push.example/x')
      expect(got?.createdAt).toBe(100)
    })

    test('relays omitted stays omitted', async () => {
      await store.upsertSub(sub(INBOX_A))
      expect((await store.getSub(INBOX_A))?.relays).toBeUndefined()
    })

    test('upsert overwrites', async () => {
      await store.upsertSub(sub(INBOX_A, { createdAt: 1 }))
      await store.upsertSub(sub(INBOX_A, { createdAt: 2 }))
      expect((await store.getSub(INBOX_A))?.createdAt).toBe(2)
    })

    test('delete reports existence', async () => {
      await store.upsertSub(sub(INBOX_A))
      expect(await store.deleteSub(INBOX_A)).toBe(true)
      expect(await store.deleteSub(INBOX_A)).toBe(false)
      expect(await store.getSub(INBOX_A)).toBeUndefined()
    })

    test('list and count', async () => {
      await store.upsertSub(sub(INBOX_A))
      await store.upsertSub(sub(INBOX_B))
      expect((await store.listSubs()).map((s) => s.inboxPub).sort()).toEqual([INBOX_A, INBOX_B].sort())
      expect(await store.countSubs()).toBe(2)
    })

    test('filterUnseen then markSeen dedups', async () => {
      expect([...(await store.filterUnseen(['e1', 'e2']))].sort()).toEqual(['e1', 'e2'])
      await store.markSeen([{ id: 'e1', seenAt: 100 }])
      expect([...(await store.filterUnseen(['e1', 'e2']))]).toEqual(['e2'])
      // idempotent
      await store.markSeen([{ id: 'e1', seenAt: 100 }])
      expect([...(await store.filterUnseen(['e1']))]).toEqual([])
    })

    test('pruneSeen drops ids observed before cutoff', async () => {
      await store.markSeen([
        { id: 'old', seenAt: 10 },
        { id: 'new', seenAt: 90 },
      ])
      await store.pruneSeen(50)
      expect([...(await store.filterUnseen(['old', 'new']))]).toEqual(['old'])
    })

    test('close is safe', async () => {
      await store.close()
      store = await makeStore()
    })
  })
}
