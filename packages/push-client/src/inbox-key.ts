/**
 * [pure] Per-epoch inbox key derivation.
 *
 * inboxSecret = HKDF-SHA256(seed, info = `kkachi/notif/${epoch}`)
 * inboxPub    = x-only pubkey of inboxSecret  (the NIP-98 signer, the filter
 *               `#p` value, and the server record key are all this one value)
 *
 * The seed (and any derived secret) never leaves the client.
 */

import { getPublicKey } from 'nostr-tools'
import { asInboxPub, hashLabel, type InboxPub } from './protocol.ts'

const HKDF_SALT = 'kkachi/inbox'
const INFO_PREFIX = 'kkachi/notif/'
const LABEL_SALT_INFO = 'kkachi/label-salt'
const encoder = new TextEncoder()

export async function deriveInboxSecret(seed: Uint8Array, epoch: string): Promise<Uint8Array> {
  if (seed.length === 0) throw new TypeError('seed must not be empty')
  if (epoch.length === 0) throw new TypeError('epoch must not be empty')
  // `new Uint8Array(...)` yields an ArrayBuffer-backed view, which the strict
  // DOM `BufferSource` type accepts (a bare Uint8Array is ArrayBufferLike).
  const key = await crypto.subtle.importKey('raw', new Uint8Array(seed), 'HKDF', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(INFO_PREFIX + epoch),
    },
    key,
    256,
  )
  return new Uint8Array(bits)
}

export async function deriveInboxPub(seed: Uint8Array, epoch: string): Promise<InboxPub> {
  const secret = await deriveInboxSecret(seed, epoch)
  return asInboxPub(getPublicKey(secret))
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Per-user label salt: HKDF-SHA256(seed) with a fixed info (no epoch). Unlike
 * the inbox key this is never sent anywhere, so there is no linkage to rotate
 * (rotating would only break resolution of already-issued pushes). Deterministic
 * per seed, so every device sharing the seed derives the same salt and resolves
 * the same tokens by recomputation — no map sync needed across the user's
 * devices. The derived salt never leaves the client (page scope only, never SW).
 */
export async function deriveLabelSalt(seed: Uint8Array): Promise<string> {
  if (seed.length === 0) throw new TypeError('seed must not be empty')
  const key = await crypto.subtle.importKey('raw', new Uint8Array(seed), 'HKDF', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(LABEL_SALT_INFO),
    },
    key,
    256,
  )
  return toBase64Url(new Uint8Array(bits))
}

/**
 * One-call label token for scheme: salt from seed, then hashLabel.
 * `labelToken(seed, "입출금")` — same token on every device sharing the seed.
 */
export async function labelToken(seed: Uint8Array, text: string): Promise<string> {
  return hashLabel(await deriveLabelSalt(seed), text)
}
