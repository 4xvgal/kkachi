---
"kkachi": patch
---

Fix `crypto.subtle` calls under strict DOM typings: `Uint8Array<ArrayBufferLike>`
is rejected by DOM `BufferSource` (TS 5.7+). Copy into ArrayBuffer-backed views
and add a DOM-lib typecheck guard so it cannot regress.
