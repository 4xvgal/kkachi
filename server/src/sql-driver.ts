/**
 * [shell] Minimal SQL driver contract. SQLite and Postgres adapters implement
 * it; the shared SQL store is written once against this. Statements use `?`
 * placeholders; each driver maps them to its own syntax.
 */

export interface SqlDriver {
  run(sql: string, params?: unknown[]): Promise<void>
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>
  close(): Promise<void>
}
