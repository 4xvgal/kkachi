/**
 * Kkachi wire contract — shared by server and SDK.
 *
 * [pure] No I/O, no runtime dependencies. The server consumes these types
 * with `import type` so no SDK runtime code leaks into the poller/server.
 */

export const PROTOCOL_VERSION = 1 as const

/** NIP-59 gift-wrap event kind. The only kind the poller ever reads. */
export const GIFT_WRAP_KIND = 1059 as const

/** NIP-98 HTTP auth event kind. */
export const HTTP_AUTH_KIND = 27235 as const

/**
 * Opaque, rotating inbox identifier. It is the x-only Nostr public key of a
 * per-epoch key derived from the user's seed. It is NOT the user's real npub.
 * The server stores this and never learns the identity behind it.
 */
export type InboxPub = string & { readonly __inboxPub: unique symbol }

export const INBOX_PUB_HEX_LENGTH = 64

const HEX64 = /^[0-9a-f]{64}$/

export function isInboxPub(value: unknown): value is InboxPub {
  return typeof value === 'string' && HEX64.test(value)
}

export function asInboxPub(value: string): InboxPub {
  if (!isInboxPub(value)) {
    throw new TypeError(`invalid inboxPub: expected 64 lowercase hex chars`)
  }
  return value
}

/** Minimal Nostr event shape. Structurally compatible with nostr-tools `Event`. */
export type NostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

/** Client registration filter. Always exactly one kind and one inbox. */
export type Filter = {
  kinds: [typeof GIFT_WRAP_KIND]
  '#p': [InboxPub]
}

/** Web Push subscription material (RFC 8291). */
export type PushKeys = {
  p256dh: string
  auth: string
}

export type PushMaterial = {
  endpoint: string
  keys: PushKeys
}

/** POST /push/subscribe body. `relays` are the inbox relays to watch (NIP-17 kind:10050). */
export type SubscribeReq = {
  filter: Filter
  push: PushMaterial
  relays?: string[]
}

/**
 * SSRF guard for operator/next-user supplied relay URLs. Only public ws(s)://
 * endpoints. Blocks loopback, private, link-local and cluster-local names.
 */
export function isAllowedRelayUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host.length === 0) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host === '0.0.0.0' || host === '::' || host === '::1') return false
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false
  if (/^169\.254\./.test(host)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return false
  if (host.endsWith('.local') || host.endsWith('.internal')) return false
  return true
}

/** Content-less push payload. The only payload the server can ever build. */
export type PushPayload = { v: typeof PROTOCOL_VERSION }

export function buildFilter(inboxPub: InboxPub): Filter {
  return { kinds: [GIFT_WRAP_KIND], '#p': [inboxPub] }
}

export function buildSubscribeReq(
  inboxPub: InboxPub,
  push: PushMaterial,
  relays?: string[],
): SubscribeReq {
  const req: SubscribeReq = { filter: buildFilter(inboxPub), push }
  if (relays && relays.length > 0) req.relays = relays
  return req
}

export function buildPushPayload(): PushPayload {
  return { v: PROTOCOL_VERSION }
}

const encoder = new TextEncoder()

/**
 * SHA-256 hex. Shared by SDK (NIP-98 signing) and server (NIP-98 verification)
 * so the payload hash can never drift between them. Pure/deterministic.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  let out = ''
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0')
  return out
}

export function isPushMaterial(value: unknown): value is PushMaterial {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.endpoint !== 'string' || v.endpoint.length === 0) return false
  const keys = v.keys
  if (typeof keys !== 'object' || keys === null) return false
  const k = keys as Record<string, unknown>
  return typeof k.p256dh === 'string' && typeof k.auth === 'string'
}

export function isSubscribeReq(value: unknown): value is SubscribeReq {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const filter = v.filter
  if (typeof filter !== 'object' || filter === null) return false
  const f = filter as Record<string, unknown>
  const kinds = f.kinds
  const p = f['#p']
  const kindsOk = Array.isArray(kinds) && kinds.length === 1 && kinds[0] === GIFT_WRAP_KIND
  const pOk = Array.isArray(p) && p.length === 1 && isInboxPub(p[0])
  if (!kindsOk || !pOk || !isPushMaterial(v.push)) return false
  if (v.relays !== undefined) {
    if (!Array.isArray(v.relays) || v.relays.length === 0) return false
    if (!v.relays.every((r) => isAllowedRelayUrl(r))) return false
  }
  return true
}
