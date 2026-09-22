import { describe, expect, test } from 'bun:test'
import {
  buildFilter,
  buildPushPayload,
  buildSubscribeReq,
  decodePushPayload,
  GIFT_WRAP_KIND,
  hashLabel,
  isAllowedRelayUrl,
  isInboxPub,
  isPushMaterial,
  isPushMessage,
  isSubscribeReq,
  PROTOCOL_VERSION,
  resolveLabel,
  sha256Hex,
  type InboxPub,
} from '../src/protocol.ts'

const INBOX = ('a'.repeat(64)) as InboxPub
const PUSH = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'BP', auth: 'AU' },
}

describe('protocol builders', () => {
  test('buildFilter pins kinds and single inbox', () => {
    expect(buildFilter(INBOX)).toEqual({ kinds: [GIFT_WRAP_KIND], '#p': [INBOX] })
    expect(buildFilter(INBOX, [1, 7])).toEqual({ kinds: [1, 7], '#p': [INBOX] })
  })

  test('buildFilter rejects malformed kinds', () => {
    const bad = [[], [0], [-1], [1.5], [NaN], [1, 1]]
    for (const b of bad) {
      // eslint-disable-next-line no-cond-assign
      let threw = false
      try {
        buildFilter(INBOX, b)
      } catch {
        threw = true
      }
      expect(threw, String(b)).toBe(true)
    }
  })

  test('buildPushPayload carries the registered message or stays content-less', () => {
    expect(buildPushPayload()).toEqual({ v: PROTOCOL_VERSION })
    expect(Object.keys(buildPushPayload())).toEqual(['v'])
    expect(buildPushPayload('nip17')).toEqual({ v: PROTOCOL_VERSION, m: 'nip17' })
  })

  test('decodePushPayload parses v2 pushes and degrades on garbage', () => {
    expect(decodePushPayload(JSON.stringify({ v: PROTOCOL_VERSION, m: 'aB3x' }))).toEqual({
      v: PROTOCOL_VERSION,
      m: 'aB3x',
    })
    expect(decodePushPayload(JSON.stringify({ v: PROTOCOL_VERSION }))).toEqual({
      v: PROTOCOL_VERSION,
    })
    expect(decodePushPayload('not json')).toEqual({ v: PROTOCOL_VERSION })
    // raw bytes (what a SW push event delivers)
    const bytes = new TextEncoder().encode(JSON.stringify({ v: PROTOCOL_VERSION, m: 'x' })).buffer
    expect(decodePushPayload(bytes)).toEqual({ v: PROTOCOL_VERSION, m: 'x' })
  })

  test('hashLabel is deterministic per salt and opaque across salts', async () => {
    const a = await hashLabel('app-salt', '입출금')
    const b = await hashLabel('app-salt', '입출금')
    const c = await hashLabel('app-salt', '메시지')
    const d = await hashLabel('other-salt', '입출금')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
    expect(a).not.toContain('입출금')
    expect(a.length).toBeLessThanOrEqual(32)
  })

  test('resolveLabel recomputes candidates and returns the match', async () => {
    const salt = 'per-user-salt'
    const candidates = ['입출금', '메시지', 'p2p-체결'] as const
    const token = await hashLabel(salt, '메시지')
    expect(await resolveLabel(salt, token, candidates)).toBe('메시지')
    expect(await resolveLabel(salt, 'zzzzzz', candidates)).toBeUndefined()
  })

  test('buildSubscribeReq composes filter + push, optional relays/message/kinds', () => {
    const plain = buildSubscribeReq(INBOX, PUSH)
    expect(plain.filter['#p']).toEqual([INBOX])
    expect(plain.push).toEqual(PUSH)
    expect(plain.relays).toBeUndefined()
    expect(plain.message).toBeUndefined()
    expect(
      buildSubscribeReq(INBOX, PUSH, { relays: ['wss://inbox.example'] }).relays,
    ).toEqual(['wss://inbox.example'])
    expect(buildSubscribeReq(INBOX, PUSH, { message: '입출금' }).message).toBe('입출금')
    expect(buildSubscribeReq(INBOX, PUSH, { kinds: [1, 7] }).filter.kinds).toEqual([1, 7])
  })

  test('length cap is bytes, not chars (multibyte safe)', () => {
    expect(isPushMessage('x'.repeat(128))).toBe(true)
    expect(isPushMessage('x'.repeat(129))).toBe(false)
    expect(isPushMessage('한'.repeat(64))).toBe(false) // 3 bytes each
    expect(isPushMessage('')).toBe(false)
  })
})

describe('relay url guard (SSRF)', () => {
  const table: Array<[boolean, unknown[]]> = [
    [
      true,
      ['wss://inbox.example', 'ws://relay.nostr.band', 'wss://172.15.0.1/relay', 'wss://172.32.0.1/relay'],
    ],
    [false, ['https://inbox.example', 'file:///etc/passwd', 'not a url', 42, undefined]],
    [
      false,
      [
        'ws://localhost/relay',
        'ws://127.0.0.1/relay',
        'ws://0.0.0.0/relay',
        'ws://10.0.0.5/relay',
        'ws://192.168.1.9/relay',
        'ws://172.16.0.1/relay',
        'ws://172.31.255.255/relay',
        'ws://169.254.169.254/relay',
        'ws://[::1]/relay',
        'ws://foo.internal/relay',
      ],
    ],
  ]

  test('allows public ws(s) and rejects private/non-ws', () => {
    for (const [expected, urls] of table) {
      for (const url of urls) expect(isAllowedRelayUrl(url)).toBe(expected)
    }
  })
})

describe('inbox pub guard', () => {
  const table: Array<[unknown, boolean]> = [
    [INBOX, true],
    ['0123456789abcdef'.repeat(4), true],
    ['A'.repeat(64), false],
    ['a'.repeat(63), false],
    ['g'.repeat(64), false],
    [123, false],
    [undefined, false],
  ]

  test('accepts 64 lowercase hex, rejects malformed', () => {
    for (const [value, expected] of table) expect(isInboxPub(value)).toBe(expected)
  })
})

describe('subscribe validation', () => {
  const valid = buildSubscribeReq(INBOX, PUSH)
  const table: Array<[unknown, boolean]> = [
    [valid, true],
    [{ ...valid, filter: { kinds: [1, 7], '#p': [INBOX] } }, true],
    [{ ...valid, filter: { kinds: [], '#p': [INBOX] } }, false],
    [{ ...valid, filter: { kinds: [1, 1], '#p': [INBOX] } }, false],
    [{ ...valid, filter: { kinds: [1.5], '#p': [INBOX] } }, false],
    [{ filter: { kinds: [GIFT_WRAP_KIND], '#p': [INBOX, INBOX] }, push: PUSH }, false],
    [{ filter: valid.filter, push: { endpoint: 'x', keys: {} } }, false],
    // local/private relays are accepted at registration (SSRF is checked server-side)
    [{ ...valid, relays: ['ws://127.0.0.1/relay'] }, true],
    [{ ...valid, relays: ['https://not-a-relay'] }, false],
    [{ ...valid, relays: [] }, false],
    [{ ...valid, relays: Array.from({ length: 11 }, () => 'wss://r.example') }, false],
    [{ ...valid, message: '입출금' }, true],
    [{ ...valid, message: 'x'.repeat(129) }, false],
    [{ ...valid, message: '' }, false],
    [{ ...valid, message: 42 }, false],
  ]

  test('accepts well-formed, rejects malformed/unsafe', () => {
    for (const [value, expected] of table) expect(isSubscribeReq(value)).toBe(expected)
    expect(isPushMaterial({ endpoint: '', keys: { p256dh: 'a', auth: 'b' } })).toBe(false)
    expect(isPushMaterial(null)).toBe(false)
  })
})

describe('sha256Hex (shared sign/verify helper)', () => {
  test('known vectors', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})
