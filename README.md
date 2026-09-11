# kkachi (까치)

Blind Web Push server for Nostr gift-wrap (kind:1059): wakes a client when a
gift-wrap for its inbox appears, even if the PWA is frozen or killed.

- **Blind** — stores only an opaque, rotating `inboxPub`; no npub, no content, no IP logs.
- **Hostile relays** — firehose poll only, never a per-user `#p` REQ; verify + dedup + `max_p_tags` + rate limits.
- **Content-less push** — always `{"v":1}`.
- **NIP-98 auth** — signer == filter `#p` == record key.
- **Non-authoritative** — a missed push loses nothing; the client catches up on open.

```
packages/push-client/   kkachi  — wire contract, inbox-key derivation, registration SDK
server/                 kkachi-server       — HTTP API + firehose poller + web-push
```

## Requirements

- [Bun](https://bun.sh) 1.3+
- Docker (optional, for containerized deploy and integration tests)

## Quick start (dev)

```bash
bun install
cp .env.example .env

# generate VAPID keys (run in server/ where web-push is installed)
cd server && bun -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
# put the two keys into .env as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
cd ..

bun run server            # http://localhost:8787  (Bun auto-loads .env)
```

Default persistence is in-memory. Set `DATABASE_URL` to `sqlite:./kkachi.db` or a
`postgres://...` URL to persist subscriptions and seen-event dedup.

All configuration lives in `.env` — see [`.env.example`](./.env.example) for the
full list (port, `PUBLIC_URL`, relays, polling window, rate limits, DB, VAPID).

## API

| Method | Path                | Body / auth                                             |
| ------ | ------------------- | ------------------------------------------------------- |
| POST   | `/push/subscribe`   | NIP-98 + `{ filter, push, relays? }`                    |
| POST   | `/push/unsubscribe` | NIP-98 (signer = inboxPub)                              |
| GET    | `/healthz`          | —                                                       |

## SDK usage

```ts
import { createInboxSigner, subscribe, unsubscribe } from 'kkachi/register'
import { deriveInboxPub } from 'kkachi/inbox-key'
import type { PushMaterial } from 'kkachi/protocol'

const epoch = '2026-09' // rotate monthly
const signer = await createInboxSigner(walletSeed, epoch) // secretKey stays on device
// hand signer.inboxPub to senders (they put it in the gift-wrap `#p`)

const push = (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })).toJSON() as PushMaterial
await subscribe('https://push.example', signer, push, ['wss://inbox.example'])
```

`subscribe`/`unsubscribe` retry network failures with per-attempt timeout and
re-sign NIP-98 each attempt. Receiving/decrypting is the client's job, not the SDK's.

## Deployment (Docker + Postgres)

```bash
cp .env.example .env
# set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (required)
# optionally set PUBLIC_URL=https://push.example.com behind a proxy/domain
docker compose up -d --build
```

This starts `postgres` + `server` (Postgres-backed). In-memory/SQLite are also
supported via `DATABASE_URL`. Put a TLS reverse proxy in front and set
`PUBLIC_URL` so NIP-98 `u` matches the public origin.

## Testing

```bash
bun run typecheck        # tsc --noEmit
bun test                 # unit tests (server + SDK); relay/postgres tests skip
bun run core:selfcheck   # framework-free pure-core asserts

bun run test:relay       # spins up `npx fonstr`, publishes kind:1059, asserts push
bun run test:postgres    # Postgres Store contract against a throwaway container
bun run test:docker      # docker compose up (postgres+server) + SDK end-to-end smoke
```

## PWA demo (local browser push)

A minimal browser app is in `examples/pwa/`. It derives an epoch inbox key,
subscribes to Web Push, and registers with the server via the SDK.

```bash
# terminal 1: server, allowing the demo origin
CORS_ORIGIN=http://localhost:5173 bun run server

# terminal 2: bundle + serve the demo
bun run pwa               # http://localhost:5173

# optional, to see pushes actually land: run a relay too
npx fonstr 4444           # and set RELAYS=ws://localhost:4444/relay in .env
```

Open http://localhost:5173 → "Enable notifications" → then **"Send test event
to me"** publishes a kind:1059 gift-wrap to this device's inbox, the poller
matches it, and a notification should appear. `localhost` is a secure context,
so Web Push works without TLS. The demo is a TypeScript workspace package
(`examples/pwa`) but is excluded from `tsc`.

**Setting the relay.** The publish relay defaults to the first `RELAYS` entry
(or `PWA_RELAY`), and can be changed at runtime in the page's **Relay** field
(persisted in `localStorage`). The server must watch the same relay:
- public `wss://` relay → the page passes it to `subscribe`, so the server polls
  it per-subscriber (click "Enable notifications" after changing);
- local/private relay → it must be in the server's `RELAYS` env (the SSRF guard
  rejects private relays from the client).

```bash
# fast polling so you don't wait 60s (relay URL comes from RELAYS)
POLL_BASE_MS=5000 RELAYS=ws://localhost:4444/relay CORS_ORIGIN=http://localhost:5173 bun run server
npx fonstr 4444
bun run pwa
```

Prefer the CLI? `bun run examples/pwa/send.ts <inboxPub>` does the same publish.

## License

[MIT](./LICENSE)
