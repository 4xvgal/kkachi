import { describe, expect, test } from 'bun:test'
import { finalizeEvent, verifyEvent } from 'nostr-tools'
import { createInboxSigner, nip98Header, sha256Hex, subscribe } from '../src/register.ts'
import { deriveInboxPub, deriveInboxSecret, deriveLabelSalt, labelToken } from '../src/inbox-key.ts'
import { HTTP_AUTH_KIND, isInboxPub, type PushMaterial } from '../src/protocol.ts'

const seed = new Uint8Array(32).map((_, i) => i + 1)
const PUSH: PushMaterial = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'BP', auth: 'AU' },
}

describe('inbox key derivation', () => {
  test('deterministic per seed+epoch', async () => {
    const a = await deriveInboxPub(seed, '2026-09')
    const b = await deriveInboxPub(seed, '2026-09')
    expect(a).toBe(b)
    expect(isInboxPub(a)).toBe(true)
  })

  // Model B contract: HKDF output is a secp256k1 secret; inboxPub is its x-only
  // pubkey. This pinned vector is the cross-implementation check for Zappi —
  // derive the same seed+epoch there and it MUST match, or pushes never land.
  test('golden vector (seed=0x01..0x20, epoch=2026-09)', async () => {
    expect(String(await deriveInboxPub(seed, '2026-09'))).toBe(
      '6f9369dd4d556f1f5dee90c24d2cdcc64c0e95f45b9a7cfe243953af52162a1c',
    )
  })

  test('rotates across epochs', async () => {
    const a = await deriveInboxPub(seed, '2026-09')
    const b = await deriveInboxPub(seed, '2026-10')
    expect(a).not.toBe(b)
  })

  test('different seeds diverge', async () => {
    const other = new Uint8Array(32).fill(7)
    expect(await deriveInboxPub(seed, '2026-09')).not.toBe(await deriveInboxPub(other, '2026-09'))
  })

  test('deriveLabelSalt: same seed derives the same salt; a different seed derives a different one', async () => {
    const other = new Uint8Array(32).fill(7)
    expect(await deriveLabelSalt(seed)).toBe(await deriveLabelSalt(seed))
    expect(await deriveLabelSalt(seed)).not.toBe(await deriveLabelSalt(other))
    expect(await deriveLabelSalt(seed)).not.toContain('=')
  })

  test('labelToken: deterministically derived per seed+text, unique per user, and opaque on the wire', async () => {
    const other = new Uint8Array(32).fill(7)
    const a = await labelToken(seed, '입출금')
    expect(await labelToken(seed, '입출금')).toBe(a)
    expect(await labelToken(seed, '메시지')).not.toBe(a)
    expect(await labelToken(other, '입출금')).not.toBe(a)
    expect(a).not.toContain('입출금')
  })

  test('pubkey matches signed inbox secret', async () => {
    const sk = await deriveInboxSecret(seed, '2026-09')
    const pub = await deriveInboxPub(seed, '2026-09')
    const event = finalizeEvent(
      { kind: 1, created_at: 0, tags: [], content: 'x' },
      sk,
    )
    expect(event.pubkey).toBe(pub)
    expect(verifyEvent(event)).toBe(true)
  })

  test('empty seed/epoch rejected', async () => {
    await expect(deriveInboxSecret(new Uint8Array(0), 'e')).rejects.toThrow()
    await expect(deriveInboxSecret(seed, '')).rejects.toThrow()
  })
})

describe('nip98 header', () => {
  test('signs url/method/payload and verifies', async () => {
    const signer = await createInboxSigner(seed, '2026-09')
    const body = JSON.stringify({ hello: 'world' })
    const header = await nip98Header(signer, 'https://srv/push/subscribe', 'POST', body)
    expect(header.startsWith('Nostr ')).toBe(true)

    const event = JSON.parse(atob(header.slice('Nostr '.length)))
    expect(event.kind).toBe(HTTP_AUTH_KIND)
    expect(event.pubkey).toBe(signer.inboxPub)
    expect(verifyEvent(event)).toBe(true)
    expect(event.tags).toContainEqual(['u', 'https://srv/push/subscribe'])
    expect(event.tags).toContainEqual(['method', 'POST'])
    expect(event.tags).toContainEqual(['payload', await sha256Hex(body)])
  })

  test('omits payload tag when no body', async () => {
    const signer = await createInboxSigner(seed, '2026-09')
    const header = await nip98Header(signer, 'https://srv/push/unsubscribe', 'POST')
    const event = JSON.parse(atob(header.slice('Nostr '.length)))
    expect(event.tags.find((t: string[]) => t[0] === 'payload')).toBeUndefined()
  })
})

describe('subscribe retry/timeout', () => {
  function stubFetch(impl: typeof fetch): () => void {
    const original = globalThis.fetch
    globalThis.fetch = impl
    return () => {
      globalThis.fetch = original
    }
  }

  test('retries network failures, re-signing each attempt, then succeeds', async () => {
    const signer = await createInboxSigner(seed, '2026-09')
    const auths: string[] = []
    let calls = 0
    const restore = stubFetch((async (_url: string, init: RequestInit) => {
      calls += 1
      auths.push((init.headers as Record<string, string>).authorization ?? '')
      if (calls < 3) throw new TypeError('network down')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch)

    try {
      const res = await subscribe('https://srv', signer, PUSH, {
        retries: 3,
        timeoutMs: 1000,
      })
      expect(res.status).toBe(200)
      expect(calls).toBe(3)
      expect(auths.every((a) => a.startsWith('Nostr '))).toBe(true)
    } finally {
      restore()
    }
  })

  test('throws after exhausting retries', async () => {
    const signer = await createInboxSigner(seed, '2026-09')
    let calls = 0
    const restore = stubFetch((async () => {
      calls += 1
      throw new TypeError('down')
    }) as unknown as typeof fetch)

    try {
      await expect(
        subscribe('https://srv', signer, PUSH, { retries: 2, timeoutMs: 1000 }),
      ).rejects.toThrow()
      expect(calls).toBe(2)
    } finally {
      restore()
    }
  })
})
