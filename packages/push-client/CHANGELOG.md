# kkachi

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
