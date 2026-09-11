---
"kkachi": patch
---

Add multi-origin CORS (`CORS_ORIGIN` allowlist) and optional TLS (`TLS_CERT`/`TLS_KEY`)
for local HTTPS. Accept client-provided relays at registration and SSRF-filter them at
poll time. Add NIP-11 relay policy (max_limit clamp, skip auth/payment relays) with
per-relay isolated queries, plus a PWA demo relay setting and VAPID mismatch handling.
