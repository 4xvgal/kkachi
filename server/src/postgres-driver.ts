/**
 * [shell] Postgres driver over Bun's built-in `Bun.SQL`. No dependency.
 * Rewrites `?` placeholders to Postgres `$1, $2, ...`.
 */

import { SQL } from 'bun'
import type { SqlDriver } from './sql-driver.ts'

function toPositional(sql: string): string {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

export function createPostgresDriver(url: string): SqlDriver {
  const db = new SQL(url)
  return {
    async run(sql, params = []) {
      await db.unsafe(toPositional(sql), params as never[])
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return (await db.unsafe(toPositional(sql), params as never[])) as T[]
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const rows = (await db.unsafe(toPositional(sql), params as never[])) as T[]
      return rows[0]
    },
    async close() {
      await db.close()
    },
  }
}
