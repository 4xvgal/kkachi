---
"kkachi": minor
"kkachi-server": minor
---

User-custom push message (v2): `subscribe` accepts `{ message }` (plaintext or a `hashLabel(salt, text)` token) and the server forwards it verbatim in the push payload (`{ v: 2, m }`). SDK `subscribe` 4th argument is now an options object (`{ relays?, message?, timeoutMs?, retries?, signal? }`). Adds `hashLabel` and `decodePushPayload` to the shared protocol.