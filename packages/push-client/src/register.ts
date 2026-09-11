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
 * POST with per-attempt timeout and retry.
 *
 * The NIP-98 header is rebuilt on every attempt because its signed `created_at`
 * must stay inside the server's freshness window; replaying a stale header
 * would 401. Only network/abort failures are retried — any HTTP response is
 * returned to the caller, since 429/503 are server decisions, not transport
 * errors.
 */
async function signedPost(
  url: string,
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
        method: 'POST',
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

export async function subscribe(
  baseUrl: string,
  signer: InboxSigner,
  push: PushMaterial,
  relays?: string[],
  opts?: RequestOptions,
): Promise<Response> {
  const url = join(baseUrl, '/push/subscribe')
  const body = JSON.stringify(buildSubscribeReq(signer.inboxPub, push, relays))
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
