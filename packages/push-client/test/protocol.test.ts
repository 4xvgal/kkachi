import { describe, expect, test } from 'bun:test'
import {
  buildFilter,
  buildPushPayload,
  buildSubscribeReq,
  GIFT_WRAP_KIND,
  isAllowedRelayUrl,
  isInboxPub,
  isPushMaterial,
  isSubscribeReq,
  PROTOCOL_VERSION,
  sha256Hex,
  type InboxPub,
} from '../src/protocol.ts'

const INBOX = ('a'.repeat(64)) as InboxPub
const PUSH = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'BP', auth: 'AU' },
}

describe('protocol builders', () => {
  test('buildFilter pins kind and single inbox', () => {
    expect(buildFilter(INBOX)).toEqual({ kinds: [GIFT_WRAP_KIND], '#p': [INBOX] })
  })

  test('buildPushPayload is content-less {v:1}', () => {
    expect(buildPushPayload()).toEqual({ v: PROTOCOL_VERSION })
    expect(Object.keys(buildPushPayload())).toEqual(['v'])
  })

  test('buildSubscribeReq composes filter + push, optional relays', () => {
    const plain = buildSubscribeReq(INBOX, PUSH)
    expect(plain.filter['#p']).toEqual([INBOX])
    expect(plain.push).toEqual(PUSH)
    expect(plain.relays).toBeUndefined()
    expect(buildSubscribeReq(INBOX, PUSH, ['wss://inbox.example']).relays).toEqual([
      'wss://inbox.example',
    ])
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
    [{ ...valid, filter: { kinds: [1], '#p': [INBOX] } }, false],
    [{ filter: { kinds: [GIFT_WRAP_KIND], '#p': [INBOX, INBOX] }, push: PUSH }, false],
    [{ filter: valid.filter, push: { endpoint: 'x', keys: {} } }, false],
    [{ ...valid, relays: ['ws://127.0.0.1/relay'] }, false],
    [{ ...valid, relays: [] }, false],
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
