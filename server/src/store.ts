/**
 * [shell] Persistence port (contract). Operators pick an adapter via
 * DATABASE_URL: in-memory (default), SQLite (`sqlite:./kkachi.db` or a path),
 * or Postgres (`postgres://...`). All adapters satisfy the same Store contract.
 *
 * Stored data is blind: opaque inboxPub only, never npub, never IP.
 */

import type { Filter, InboxPub, PushMaterial } from 'kkachi/protocol'

export type StoredSub = {
  inboxPub: InboxPub
  filter: Filter
  push: PushMaterial
  /** Inbox relays to watch for this subscriber (NIP-17 kind:10050). */
  relays?: string[]
  createdAt: number
}

export interface Store {
  upsertSub(sub: StoredSub): Promise<void>
  getSub(inboxPub: InboxPub): Promise<StoredSub | undefined>
  deleteSub(inboxPub: InboxPub): Promise<boolean>
  listSubs(): Promise<StoredSub[]>
  countSubs(): Promise<number>
  /** Subset of `ids` not yet recorded as seen. */
  filterUnseen(ids: string[]): Promise<Set<string>>
  /**
   * Record seen event ids with the *server observation time* (not the event's
   * forged/randomized created_at), so a hostile relay cannot defeat retention.
   */
  markSeen(entries: Array<{ id: string; seenAt: number }>): Promise<void>
  /** Drop seen ids observed before `before` (window retention, server time). */
  pruneSeen(before: number): Promise<void>
  close(): Promise<void>
}

export function createMemoryStore(): Store {
  const subs = new Map<InboxPub, StoredSub>()
  const seen = new Map<string, number>()
  return {
    async upsertSub(sub) {
      subs.set(sub.inboxPub, sub)
    },
    async getSub(inboxPub) {
      return subs.get(inboxPub)
    },
    async deleteSub(inboxPub) {
      return subs.delete(inboxPub)
    },
    async listSubs() {
      return [...subs.values()]
    },
    async countSubs() {
      return subs.size
    },
    async filterUnseen(ids) {
      const out = new Set<string>()
      for (const id of ids) if (!seen.has(id)) out.add(id)
      return out
    },
    async markSeen(entries) {
      for (const entry of entries) seen.set(entry.id, entry.seenAt)
    },
    async pruneSeen(before) {
      for (const [id, seenAt] of seen) if (seenAt < before) seen.delete(id)
    },
    async close() {},
  }
}

export async function createStore(databaseUrl?: string): Promise<Store> {
  if (!databaseUrl) return createMemoryStore()

  if (/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    const [{ createPostgresDriver }, { createSqlStore }] = await Promise.all([
      import('./postgres-driver.ts'),
      import('./sql-store.ts'),
    ])
    return createSqlStore(createPostgresDriver(databaseUrl))
  }

  const { createSqliteDriver } = await import('./sqlite-driver.ts')
  const { createSqlStore } = await import('./sql-store.ts')
  const path = databaseUrl.startsWith('sqlite:') ? databaseUrl.slice('sqlite:'.length) : databaseUrl
  return createSqlStore(createSqliteDriver(path))
}
