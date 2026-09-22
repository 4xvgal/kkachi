# kkachi

## 0.1.0

### Minor Changes

- e042f0b: feat: multi-kind subscriptions with ALLOWED_KINDS whitelist, kind-array filter, /push/kinds and /push/subscription endpoints, SDK kinds option, PWA demos
- e194940: User-custom push message (v2): `subscribe` accepts `{ message }` (plaintext or a `hashLabel(salt, text)` token) and the server forwards it verbatim in the push payload (`{ v: 2, m }`). SDK `subscribe` 4th argument is now an options object (`{ relays?, message?, timeoutMs?, retries?, signal? }`). Adds `hashLabel` and `decodePushPayload` to the shared protocol.

### Patch Changes

- 9e5d8c0: feat:relay-pagianation-policy

## 0.1.0-rc.1

### Minor Changes

- e042f0b: feat: multi-kind subscriptions with ALLOWED_KINDS whitelist, kind-array filter, /push/kinds and /push/subscription endpoints, SDK kinds option, PWA demos
- e194940: User-custom push message (v2): `subscribe` accepts `{ message }` (plaintext or a `hashLabel(salt, text)` token) and the server forwards it verbatim in the push payload (`{ v: 2, m }`). SDK `subscribe` 4th argument is now an options object (`{ relays?, message?, timeoutMs?, retries?, signal? }`). Adds `hashLabel` and `decodePushPayload` to the shared protocol.

## 0.0.4-rc.0

### Patch Changes

- 9e5d8c0: feat:relay-pagianation-policy

## 0.0.3

### Patch Changes

- 5c60b8d: Fix `crypto.subtle` calls under strict DOM typings: `Uint8Array<ArrayBufferLike>`
  is rejected by DOM `BufferSource` (TS 5.7+). Copy into ArrayBuffer-backed views
  and add a DOM-lib typecheck guard so it cannot regress.
- 2f2c7c6: Add multi-origin CORS (`CORS_ORIGIN` allowlist) and optional TLS (`TLS_CERT`/`TLS_KEY`)
  for local HTTPS. Accept client-provided relays at registration and SSRF-filter them at
  poll time. Add NIP-11 relay policy (max_limit clamp, skip auth/payment relays) with
  per-relay isolated queries, plus a PWA demo relay setting and VAPID mismatch handling.

## 0.0.3-rc.1

### Patch Changes

- Add multi-origin CORS (`CORS_ORIGIN` allowlist) and optional TLS (`TLS_CERT`/`TLS_KEY`)
  for local HTTPS. Accept client-provided relays at registration and SSRF-filter them at
  poll time. Add NIP-11 relay policy (max_limit clamp, skip auth/payment relays) with
  per-relay isolated queries, plus a PWA demo relay setting and VAPID mismatch handling.

## 0.0.3-rc.0

### Patch Changes

- Fix `crypto.subtle` calls under strict DOM typings: `Uint8Array<ArrayBufferLike>`
  is rejected by DOM `BufferSource` (TS 5.7+). Copy into ArrayBuffer-backed views
  and add a DOM-lib typecheck guard so it cannot regress.

## 0.0.2

### Patch Changes

- Add browser CORS support (`CORS_ORIGIN`), a local PWA demo (`examples/pwa`),
  real web-push delivery tests, and safe polling jitter when `POLL_BASE_MS` is
  shorter than the poll spread.
