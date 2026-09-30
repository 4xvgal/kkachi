---
"kkachi-server": minor
---

Backdated gift-wrap delivery via batched watch polls

NIP-17/59 senders randomize gift-wrap `created_at` up to 2 days into the
past. The previous kind-wise firehose polling missed those events: on busy
relays they sit past the created_at pagination tail (nos.lol holds ~20k+
kind:1059 inside the 2-day window), and some relays (snort.social) skip
deep `since` scans entirely and only serve the newest ~500 events.

Polling now issues batched NIP-01 `#p` watch REQs (100 inboxPub per filter,
one REQ per relay per batch) with the same fixed lookback window and
observation-time dedup. Per-inbox volume is tiny, so 2-day-old events stay
reachable. Measured on nos.lol and relay.snort.social: the previously missed
backdated event is returned by the `#p` query.

- Default lookback window widened to 2 days + 6 hours
  (`POLL_LOOKBACK_SEC=190800`) to tolerate relay backfill delay beyond the
  NIP-59 upper bound.
- Inbound relay traffic drops dramatically (no full-kind scans); at 100
  subscribers it is ~1 REQ per tick per relay.
- Trade-off accepted: the watched batch list is visible to relays (L1). Epoch
  inbox keys rotate monthly to contain the exposure. Existing firehose-only
  guard tests were updated to the batched-watch contract.