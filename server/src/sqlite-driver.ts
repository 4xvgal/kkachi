/**
 * [shell] SQLite driver over Bun's built-in `bun:sqlite`. No dependency.
 */

import { Database } from 'bun:sqlite'
import type { SqlDriver } from './sql-driver.ts'

export function createSqliteDriver(path: string): SqlDriver {
  const db = new Database(path)
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;')
  }
  return {
    async run(sql, params = []) {
      db.run(sql, params as never[])
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.query(sql).all(...(params as never[])) as T[]
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return (db.query(sql).get(...(params as never[])) as T | null) ?? undefined
    },
    async close() {
      db.close()
    },
  }
}
