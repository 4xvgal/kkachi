/**
 * [io] Client-side registration: derive the epoch inbox key, build a NIP-98
 * Authorization header, and POST subscribe/unsubscribe with timeout + retry.
 *
 * The caller owns the seed. `secretKey` here is the derived inbox secret, not
 * the user's real nsec.
 */

import { finalizeEvent } from 'nostr-tools'
import { deriveInboxPub, deriveInboxSecret } from './inbox-key.ts'
import {
  buildSubscribeReq,
  HTTP_AUTH_KIND,
  sha256Hex,
  type InboxPub,
  type PushMaterial,
  type PushMessage,
} from './protocol.ts'

export { sha256Hex } from './protocol.ts'

const encoder = new TextEncoder()
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRIES = 3

export type InboxSigner = {
  inboxPub: InboxPub
  secretKey: Uint8Array
}

export type RequestOptions = {
  /** Per-attempt timeout. Default 10s. */
  timeoutMs?: number
  /** Total attempts, 1 = no retry. Default 3. */
  retries?: number
  /** Caller abort signal, combined with the timeout. */
  signal?: AbortSignal
}

export type SubscribeOptions = RequestOptions & {
  /** Inbox relays to watch (NIP-17 kind:10050). Defaults to the server's global set. */
  relays?: string[]
  /**
   * Push message registered with this subscription. Opaque to the server:
   * pass plaintext, or a `hashLabel(salt, text)` token for obfuscation.
   */
  message?: PushMessage
  /** Event kinds to notify on. Server ALLOWED_KINDS whitelist applies. Default [1059]. */
  kinds?: number[]
}

export async function createInboxSigner(seed: Uint8Array, epoch: string): Promise<InboxSigner> {
  const [secretKey, inboxPub] = await Promise.all([
    deriveInboxSecret(seed, epoch),
    deriveInboxPub(seed, epoch),
  ])
  return { inboxPub, secretKey }
}

function base64(input: string): string {
  const bytes = encoder.encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** Build a NIP-98 `Authorization: Nostr <base64(event)>` header value. */
export async function nip98Header(
  signer: InboxSigner,
  url: string,
  method: string,
  body?: string,
): Promise<string> {
  const tags: string[][] = [
    ['u', url],
    ['method', method.toUpperCase()],
  ]
  if (body !== undefined) tags.push(['payload', await sha256Hex(body)])
  const event = finalizeEvent(
    { kind: HTTP_AUTH_KIND, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    signer.secretKey,
  )
  return `Nostr ${base64(JSON.stringify(event))}`
}

function join(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requestSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return external ? AbortSignal.any([timeout, external]) : timeout
}

/**
 * Request with per-attempt timeout and retry.
 *
 * The NIP-98 header is rebuilt on every attempt (via the `sign` closure)
 * because its signed `created_at` must stay inside the server's freshness
 * window; replaying a stale header would 401. Only network/abort failures are
 * retried — any HTTP response is returned to the caller, since 429/503 are
 * server decisions, not transport errors.
 */
async function signedRequest(
  url: string,
  method: string,
  body: string | undefined,
  sign: () => Promise<string>,
  opts: RequestOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, opts.retries ?? DEFAULT_RETRIES)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await delay(Math.min(300 * 2 ** (attempt - 1), 3000))
    try {
      const authorization = await sign()
      const headers: Record<string, string> = { authorization }
      if (body !== undefined) headers['content-type'] = 'application/json'
      return await fetch(url, {
        method,
        headers,
        body,
        signal: requestSignal(timeoutMs, opts.signal),
      })
    } catch (err) {
      lastError = err
    }
  }

  throw lastError ?? new Error('kkachi: request failed')
}

async function signedPost(
  url: string,
  body: string | undefined,
  sign: () => Promise<string>,
  opts: RequestOptions = {},
): Promise<Response> {
  return signedRequest(url, 'POST', body, sign, opts)
}

export async function subscribe(
  baseUrl: string,
  signer: InboxSigner,
  push: PushMaterial,
  opts?: SubscribeOptions,
): Promise<Response> {
  const url = join(baseUrl, '/push/subscribe')
  const body = JSON.stringify(
    buildSubscribeReq(signer.inboxPub, push, {
      relays: opts?.relays,
      message: opts?.message,
      kinds: opts?.kinds,
    }),
  )
  return signedPost(url, body, () => nip98Header(signer, url, 'POST', body), opts)
}

export async function unsubscribe(
  baseUrl: string,
  signer: InboxSigner,
  opts?: RequestOptions,
): Promise<Response> {
  const url = join(baseUrl, '/push/unsubscribe')
  return signedPost(url, undefined, () => nip98Header(signer, url, 'POST'), opts)
}

/**
 * Fetch the signer's current subscription (filter, push, relays, message).
 * 404 when none. NIP-98 GET auth. For multi-device reconciliation: a device
 * that lost its local copy can restore the same subscription.
 */
export async function getSubscription(
  baseUrl: string,
  signer: InboxSigner,
  opts?: RequestOptions,
): Promise<Response> {
  const url = join(baseUrl, '/push/subscription')
  return signedRequest(url, 'GET', undefined, () => nip98Header(signer, url, 'GET'), opts)
}
