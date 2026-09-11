/**
 * [shell] Environment configuration. Loaded once at process start.
 */

import { DEFAULT_AUTH_MAX_SKEW_SEC } from './core.ts'

export type VapidConfig = {
  publicKey: string
  privateKey: string
  subject: string
}

export type TlsConfig = {
  /** PEM file paths. Enables HTTPS (needed when the PWA dev server is HTTPS: mixed content). */
  certFile: string
  keyFile: string
}

export type Config = {
  port: number
  /** Public origin used to canonicalize NIP-98 `u` when behind a proxy. */
  publicUrl?: string
  /** Allowed browser CORS origins (comma-separated `CORS_ORIGIN`). `*` allows any. */
  corsOrigins: string[]
  /** Optional TLS for local HTTPS dev. */
  tls?: TlsConfig
  relays: string[]
  vapid: VapidConfig
  /** Persistence: undefined = in-memory, `sqlite:...` = SQLite, `postgres://` = Postgres. */
  databaseUrl?: string
  pollBaseMs: number
  pollSpreadMs: number
  /**
   * Lookback window per poll. NIP-59/17 randomize gift-wrap created_at up to 2
   * days into the past, so created_at cannot be used as an incrementing cursor.
   * Every poll rescans this window and dedups by event id.
   */
  pollLookbackSec: number
  pollLimit: number
  pollMaxPages: number
  /** Per-relay query timeout (ms). Bounds a hung relay. */
  relayTimeoutMs: number
  maxPTags: number
  authMaxSkewSec: number
  /** Outbound push token bucket, per target (inboxPub). Relay-injection defense. */
  pushRateBurst: number
  pushRateRefillPerMin: number
  /** Inbound API token bucket, per signer (inboxPub). Server self-protection. */
  apiRateBurst: number
  apiRateRefillPerMin: number
  /** Hard cap on stored subscriptions (registry memory DoS guard). */
  maxSubs: number
}

const TWO_DAYS_SEC = 2 * 24 * 60 * 60

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY ?? '',
    privateKey: env.VAPID_PRIVATE_KEY ?? '',
    subject: env.VAPID_SUBJECT ?? 'mailto:admin@localhost',
  }
  const relays = splitList(env.RELAYS)
  const pollBaseMs = Number(env.POLL_BASE_MS ?? 60_000)
  // spread must not exceed base, or jitter goes negative (setTimeout clamps to
  // 1ms -> tight polling loop).
  const pollSpreadMs = Math.min(Number(env.POLL_SPREAD_MS ?? 15_000), pollBaseMs)
  return {
    port: Number(env.PORT ?? 8787),
    publicUrl: env.PUBLIC_URL,
    corsOrigins: splitList(env.CORS_ORIGIN),
    tls:
      env.TLS_CERT && env.TLS_KEY
        ? { certFile: env.TLS_CERT, keyFile: env.TLS_KEY }
        : undefined,
    relays: relays.length > 0 ? relays : ['ws://localhost:4444/relay'],
    vapid,
    databaseUrl: env.DATABASE_URL,
    pollBaseMs,
    pollSpreadMs,
    pollLookbackSec: Number(env.POLL_LOOKBACK_SEC ?? TWO_DAYS_SEC + 3600),
    pollLimit: Number(env.POLL_LIMIT ?? 500),
    pollMaxPages: Number(env.POLL_MAX_PAGES ?? 10),
    relayTimeoutMs: Number(env.RELAY_TIMEOUT_MS ?? 10_000),
    maxPTags: Number(env.MAX_P_TAGS ?? 10),
    authMaxSkewSec: Number(env.AUTH_MAX_SKEW_SEC ?? DEFAULT_AUTH_MAX_SKEW_SEC),
    pushRateBurst: Number(env.PUSH_RATE_BURST ?? 5),
    pushRateRefillPerMin: Number(env.PUSH_RATE_REFILL_PER_MIN ?? 5),
    apiRateBurst: Number(env.API_RATE_BURST ?? 10),
    apiRateRefillPerMin: Number(env.API_RATE_REFILL_PER_MIN ?? 10),
    maxSubs: Number(env.MAX_SUBS ?? 10_000),
  }
}
