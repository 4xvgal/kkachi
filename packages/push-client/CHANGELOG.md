# kkachi

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
