/**
 * [shell] SQL-backed Store. One implementation, two drivers (SQLite/Postgres).
 * Statements use `?` placeholders; the Postgres driver rewrites them.
 */

import type { InboxPub } from 'kkachi/protocol'
import type { Store, StoredSub } from './store.ts'
import type { SqlDriver } from './sql-driver.ts'

type SubRow = {
  inbox_pub: string
  filter: string
  push: string
  relays: string | null
  created_at: number | string
}

function rowToSub(row: SubRow): StoredSub {
  const sub: StoredSub = {
    inboxPub: row.inbox_pub as InboxPub,
    filter: JSON.parse(row.filter),
    push: JSON.parse(row.push),
    createdAt: Number(row.created_at),
  }
  if (row.relays) sub.relays = JSON.parse(row.relays)
  return sub
}

export async function createSqlStore(driver: SqlDriver): Promise<Store> {
  await driver.run(
    `CREATE TABLE IF NOT EXISTS subscriptions (
       inbox_pub TEXT PRIMARY KEY,
       filter TEXT NOT NULL,
       push TEXT NOT NULL,
       relays TEXT,
       created_at BIGINT NOT NULL
     )`,
  )
  await driver.run(
    `CREATE TABLE IF NOT EXISTS seen_events (
       id TEXT PRIMARY KEY,
       seen_at BIGINT NOT NULL
     )`,
  )
  // Best-effort migration from the earlier event-time column.
  try {
    await driver.run(`ALTER TABLE seen_events RENAME COLUMN created_at TO seen_at`)
  } catch {
    // fresh table, or already migrated
  }
  await driver.run(`CREATE INDEX IF NOT EXISTS seen_events_seen_at ON seen_events (seen_at)`)

  return {
    async upsertSub(sub) {
      await driver.run(
        `INSERT INTO subscriptions (inbox_pub, filter, push, relays, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (inbox_pub) DO UPDATE SET
           filter = excluded.filter,
           push = excluded.push,
           relays = excluded.relays,
           created_at = excluded.created_at`,
        [
          sub.inboxPub,
          JSON.stringify(sub.filter),
          JSON.stringify(sub.push),
          sub.relays ? JSON.stringify(sub.relays) : null,
          sub.createdAt,
        ],
      )
    },

    async getSub(inboxPub) {
      const row = await driver.get<SubRow>(`SELECT * FROM subscriptions WHERE inbox_pub = ?`, [
        inboxPub,
      ])
      return row ? rowToSub(row) : undefined
    },

    async deleteSub(inboxPub) {
      const row = await driver.get<SubRow>(
        `SELECT inbox_pub FROM subscriptions WHERE inbox_pub = ?`,
        [inboxPub],
      )
      if (!row) return false
      await driver.run(`DELETE FROM subscriptions WHERE inbox_pub = ?`, [inboxPub])
      return true
    },

    async listSubs() {
      const rows = await driver.all<SubRow>(`SELECT * FROM subscriptions`)
      return rows.map(rowToSub)
    },

    async countSubs() {
      const row = await driver.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM subscriptions`)
      return row ? Number(row.n) : 0
    },

    async filterUnseen(ids) {
      const out = new Set<string>()
      if (ids.length === 0) return out
      const placeholders = ids.map(() => '?').join(', ')
      const rows = await driver.all<{ id: string }>(
        `SELECT id FROM seen_events WHERE id IN (${placeholders})`,
        ids,
      )
      const found = new Set(rows.map((r) => r.id))
      for (const id of ids) if (!found.has(id)) out.add(id)
      return out
    },

    async markSeen(entries) {
      for (const entry of entries) {
        await driver.run(
          `INSERT INTO seen_events (id, seen_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING`,
          [entry.id, entry.seenAt],
        )
      }
    },

    async pruneSeen(before) {
      await driver.run(`DELETE FROM seen_events WHERE seen_at < ?`, [before])
    },

    async close() {
      await driver.close()
    },
  }
}
