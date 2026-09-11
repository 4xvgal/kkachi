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
import { asInboxPub, type InboxPub } from './protocol.ts'

const HKDF_SALT = 'kkachi/inbox'
const INFO_PREFIX = 'kkachi/notif/'
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
