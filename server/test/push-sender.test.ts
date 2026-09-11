/**
 * Web-push delivery verification.
 *
 * Hop A (real crypto): use web-push's own request builder with real VAPID keys
 * and a real subscription keypair, and assert it produces a VAPID-signed,
 * aes128gcm-encrypted request for the payload.
 *
 * Hop B (HTTP mapping): inject a fake send to assert 404/410 -> PushGoneError
 * and pass-through of other errors.
 */

import { describe, expect, test } from 'bun:test'
import webpush from 'web-push'
import type { PushMaterial } from 'kkachi/protocol'
import { createWebPushSender, PushGoneError, type WebPushSend } from '../src/push-sender.ts'

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function subscription(endpoint = 'https://fcm.googleapis.com/fcm/send/abc'): Promise<PushMaterial> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  return {
    endpoint,
    keys: { p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) },
  }
}

describe('web-push request builder (real crypto)', () => {
  test('VAPID-signed, aes128gcm-encrypted, content differs per payload', async () => {
    const vapid = webpush.generateVAPIDKeys()
    const sub = await subscription()
    const details = {
      vapidDetails: { ...vapid, subject: 'mailto:test@example.com' },
      TTL: 60,
    }

    const req = webpush.generateRequestDetails(sub, JSON.stringify({ v: 1 }), details)
    expect(req.method).toBe('POST')
    expect(req.endpoint).toBe(sub.endpoint)
    expect(req.headers.Authorization).toMatch(/^vapid /i)
    expect(req.headers['Content-Encoding']).toBe('aes128gcm')
    expect(req.headers.TTL).toBeDefined()
    expect(req.body.byteLength).toBeGreaterThan(0)

    // encryption must actually depend on the payload
    const other = webpush.generateRequestDetails(sub, JSON.stringify({ v: 2, x: 1 }), details)
    expect(Buffer.from(req.body).equals(Buffer.from(other.body))).toBe(false)
  })
})

describe('createWebPushSender (HTTP mapping)', () => {
  const vapid = webpush.generateVAPIDKeys()
  const config = { ...vapid, subject: 'mailto:test@example.com' }

  test('passes TTL/urgency and the payload through', async () => {
    const calls: Array<{ payload: string; options: Record<string, unknown> }> = []
    const send: WebPushSend = async (_sub, payload, options) => {
      calls.push({ payload, options })
    }
    const sender = createWebPushSender(config, send)
    const sub = await subscription()
    await sender(sub, JSON.stringify({ v: 1 }))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload).toBe('{"v":1}')
    expect(calls[0]!.options.TTL).toBe(60)
    expect(calls[0]!.options.urgency).toBe('normal')
  })

  test.each([404, 410])('maps %i to PushGoneError', async (status) => {
    const send: WebPushSend = async () => {
      throw Object.assign(new Error('gone'), { statusCode: status })
    }
    const sender = createWebPushSender(config, send)
    await expect(sender(await subscription(), '{"v":1}')).rejects.toBeInstanceOf(PushGoneError)
  })

  test('other statuses propagate', async () => {
    const send: WebPushSend = async () => {
      throw Object.assign(new Error('boom'), { statusCode: 500 })
    }
    const sender = createWebPushSender(config, send)
    await expect(sender(await subscription(), '{"v":1}')).rejects.toThrow('boom')
  })
})
