/**
 * Postgres Store contract test. Skipped unless POSTGRES_URL is set.
 *
 *   POSTGRES_URL=postgres://kkachi:kkachi@localhost:5432/kkachi bun test server/test/postgres-store.test.ts
 *
 * `bun run test:postgres` starts a container via docker compose and sets it.
 */

import { test } from 'bun:test'
import { createPostgresDriver } from '../src/postgres-driver.ts'
import { createSqlStore } from '../src/sql-store.ts'
import { runStoreContract } from './store.contract.ts'

const URL = process.env.POSTGRES_URL

if (URL) {
  runStoreContract('postgres', async () => {
    const driver = createPostgresDriver(URL)
    const store = await createSqlStore(driver)
    // Isolate tests sharing one database.
    await driver.run('DELETE FROM subscriptions')
    await driver.run('DELETE FROM seen_events')
    return store
  })
} else {
  test.skip('postgres store contract (set POSTGRES_URL to run)', () => {})
}
