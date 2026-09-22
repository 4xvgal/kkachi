/**
 * Kkachi wire contract — shared by server and SDK.
 *
 * [pure] No I/O, no runtime dependencies. The server consumes these types
 * with `import type` so no SDK runtime code leaks into the poller/server.
 */

export const PROTOCOL_VERSION = 2 as const

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

/**
 * Client-registered push message. Opaque to the server: the client may register
 * plaintext or an obfuscated/hashed form of its own choosing; the server stores
 * and forwards it verbatim without interpreting it.
 */
export type PushMessage = string

/** Max encoded byte length of a registered push message (push size / abuse gate). */
export const MAX_PUSH_MESSAGE_BYTES = 128

export function isPushMessage(value: unknown): value is PushMessage {
  if (typeof value !== 'string' || value.length === 0) return false
  return new TextEncoder().encode(value).byteLength <= MAX_PUSH_MESSAGE_BYTES
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
  /** Client-registered push message; forwarded verbatim on match. */
  message?: PushMessage
}

/** Max relays a single subscriber may register. */
export const MAX_RELAYS_PER_SUB = 10

/** Wire-shape check for a relay URL (scheme only). SSRF filtering is server-side. */
export function isRelayUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const protocol = new URL(value).protocol
    return protocol === 'ws:' || protocol === 'wss:'
  } catch {
    return false
  }
}

/**
 * SSRF guard enforced where the server actually connects (polling), not at
 * registration. Only public ws(s):// endpoints. Blocks loopback, private,
 * link-local and cluster-local names.
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

/**
 * Push payload. The server carries the subscriber's registered message (`m`)
 * verbatim; absent `m` degenerates to the content-less v1 behavior. No other
 * content fields are representable.
 */
export type PushPayload = { v: typeof PROTOCOL_VERSION; m?: PushMessage }

export function buildFilter(inboxPub: InboxPub): Filter {
  return { kinds: [GIFT_WRAP_KIND], '#p': [inboxPub] }
}

export function buildSubscribeReq(
  inboxPub: InboxPub,
  push: PushMaterial,
  opts?: { relays?: string[]; message?: PushMessage },
): SubscribeReq {
  const req: SubscribeReq = { filter: buildFilter(inboxPub), push }
  if (opts?.relays && opts.relays.length > 0) req.relays = opts.relays
  if (opts?.message !== undefined) req.message = opts.message
  return req
}

export function buildPushPayload(message?: PushMessage): PushPayload {
  return message === undefined ? { v: PROTOCOL_VERSION } : { v: PROTOCOL_VERSION, m: message }
}

/**
 * Service-worker side: parse a received push payload (string or raw bytes, as
 * delivered by the push event) into a PushPayload. Malformed/legacy payloads
 * degrade to `{ v: PROTOCOL_VERSION }` so a receiver always has a shape to
 * render.
 */
export function decodePushPayload(data: string | ArrayBuffer): PushPayload {
  const text =
    typeof data === 'string' ? data : new TextDecoder().decode(new Uint8Array(data))
  try {
    const parsed = JSON.parse(text) as { v?: unknown; m?: unknown }
    const m = typeof parsed.m === 'string' && isPushMessage(parsed.m) ? parsed.m : undefined
    // `v` from the wire is informational only; the receiver renders `m`.
    return m === undefined ? { v: PROTOCOL_VERSION } : { v: PROTOCOL_VERSION, m }
  } catch {
    return { v: PROTOCOL_VERSION }
  }
}

const encoder = new TextEncoder()

/**
 * SHA-256 hex. Shared by SDK (NIP-98 signing) and server (NIP-98 verification)
 * so the payload hash can never drift between them. Pure/deterministic.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view: strict DOM `BufferSource`
  // rejects Uint8Array<ArrayBufferLike> (could be SharedArrayBuffer).
  const bytes = new Uint8Array(typeof data === 'string' ? encoder.encode(data) : data)
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
  if (v.message !== undefined && !isPushMessage(v.message)) return false
  if (v.relays !== undefined) {
    if (!Array.isArray(v.relays) || v.relays.length === 0) return false
    if (v.relays.length > MAX_RELAYS_PER_SUB) return false
    if (!v.relays.every((r) => isRelayUrl(r))) return false
  }
  return true
}

/**
 * Deterministic label obfuscation: `base64url(sha256(salt ‖ text))[:16B]`.
 * Client responsibility — the server accepts the result as an opaque
 * `PushMessage` and never sees `text`. `salt` must be an app-wide constant so
 * every device of the app derives the same token.
 */
export async function hashLabel(salt: string, text: string): Promise<string> {
  const bytes = new Uint8Array(encoder.encode(`${salt}\u0000${text}`))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  let binary = ''
  for (const b of new Uint8Array(digest).slice(0, 16)) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Receiver-side resolution (B scheme): recompute the token for every candidate
 * and return the first match. Candidates are the app's finite known labels
 * (categories); plaintext never travels — only the matched candidate comes back.
 */
export async function resolveLabel(
  salt: string,
  token: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  const tokens = await Promise.all(candidates.map((c) => hashLabel(salt, c)))
  const index = tokens.indexOf(token)
  return index === -1 ? undefined : candidates[index]
}
