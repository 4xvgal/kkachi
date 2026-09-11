# kkachi

Client SDK for [kkachi](https://github.com/4xvgal/kkachi) — a blind Web Push
server for Nostr gift-wrap (kind:1059) notifications.

- Derive a per-epoch inbox key (HKDF → secp256k1) that never leaves the device.
- Register/unregister with the push server via NIP-98 (with timeout + retry).
- Shared wire contract (`protocol.ts`) so the server and SDK never drift.

> Ships TypeScript source (bundler/Bun consumers). Receiving/decrypting is the
> client's responsibility, not this SDK's.

## Install

```bash
bun add kkachi
# npm i kkachi
```

## Usage

```ts
import { createInboxSigner, subscribe, unsubscribe } from 'kkachi/register'
import { deriveInboxPub } from 'kkachi/inbox-key'
import type { PushMaterial } from 'kkachi/protocol'

const signer = await createInboxSigner(walletSeed, '2026-09') // rotate monthly
const inboxPub = signer.inboxPub // hand to senders (gift-wrap `#p`)

const push = subscription.toJSON() as PushMaterial
await subscribe('https://push.example', signer, push, ['wss://inbox.example'])
await unsubscribe('https://push.example', signer)
```

Subpaths: `kkachi/protocol`, `/inbox-key`, `/register`.

## License

MIT
