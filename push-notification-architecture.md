# Zappi Push 알림 아키텍처 (최종 모델)

> 작성일: 2026-09 기준
> 목적: PWA가 닫혀 있어도 Nostr gift-wrap(kind:1059) 수신을 OS 알림으로 전달
> 전제: **relay는 적대적(hostile)** — 검열·주입 가능. **서버 push는 비권위(non-authoritative) wake hint.**

---

## 0. 설계 원칙

1. **클라이언트가 진실.** 자금 수령은 relay/push와 무관. 클라가 `giftwrap-cursor`로 앱 열 때 따라잡는다. 서버 push는 *깨우기 힌트*일 뿐, 누락돼도 손실 없음.
2. **서버는 눈머는(blind).** 실명 npub 저장 X, IP 로그 X, 내용 못 봄(이미 NIP-59/44 E2E).
3. **relay는 적대적.** per-user `#p` REQ 금지(유저 열거됨). 오직 firehose-kind:1059 **batch poll**.
4. **content-less + 집계 push.** payload `{v:1}`. window당 1건.
5. **실시간은 클라가 담당.** 서버는 앱이 frozen/killed된 차가운 상태의 fallback만.

---

## 1. 위협 모델

액터: relay / push service(FCM·APNs·Mozilla) / 서버 운영자 / 수동 관찰자 / 네트워크.

우선순위:
1. **서버 유출 = 신원+push capability 덤프** (L12/L13) — 최악
2. **relay가 유저 전원 열거** (L1) + **능동 조작** (L7)
3. push service 타이밍 (L9/L20) — FCM/APNs 자체는 못 이김
4. 서버 로그·가입 IP (L14/L15)

### 위협 → 대응

| # | 위협 | 대응 |
|---|---|---|
| L1 | relay가 `#p` REQ로 유저 전원 열거 | **firehose poll** — `#p` 안 보냄 |
| L2/L11/L17 | 서버 IP/위치 노출 | 엣지/Tor 뒤, 다중 relay. (완전 은닉 불가) |
| L3/L5 | `since`/churn으로 활동·성장 노출 | firehose + 랜덤 poll 시각 |
| L4 | REQ id에 식별자 | id 랜덤 |
| L6 | 유저별 연결 = 온라인 노출 | 일회성 poll (지속 연결 없음) |
| L7 | relay 주입/검열 | 서명검증 + dedup + rate limit + **전달은 비권위** |
| L8/L16/L22 | push endpoint = 기기 식별자 | epoch 회전, (선택) endpoint 재구독 |
| L9/L20 | push 타이밍 상관 | **batch 집계 + 지터** |
| L10 | VAPID `sub` | 익명 mailto/https |
| L12 | 레지스트리 평문 npub | record key = **opaque inboxPub(회전)**, npub 미보관. (선택) 저장 시 `HMAC(salt,inboxPub)` 난독화 |
| L13 | DB 유출 = push capability | 저장 최소화 + rate limit + 410 즉시 삭제 |
| L14/L15 | 가입 IP·로그 | IP 로그 금지, 최소보관 |
| L18/L19 | 네트워크/엣지 | 프록시 |

---

## 2. 최종 모델 개요

```
┌── 클라이언트 (신뢰: 신원·복호화 보유) ──────────────────────────┐
│  - nsec/seed 로컬. 서버에 절대 전송 X                            │
│  - inboxPub(epoch) = HKDF(seed, "zappi/notif/"+epoch)           │
│  - foreground/background-alive: NostrIncomingWatcher 직접 구독   │
│  - 앱 열림: cursor로 catch-up → 복호화 → 알림 갱신              │
└───────────────┬─────────────────────────────────────────────────┘
                │ 등록: NIP-98(inbox key 서명) + {filter:{kinds:[1059],'#p':[inboxPub]}, push}
                ▼
┌── Push Server (신뢰 X — blind) ─────────────────────────────────┐
│  저장: inboxPub → { pushMaterial, relays }  ← NIP-98 signer=key │
│        ※ npub 없음 · IP 로그 없음 · 내용 못 봄                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Poller: 60s ± jitter                                     │  │
│  │   querySync(union(relays), {kinds:[1059], since:cursor}) │  │
│  │   → 로컬 #p 매칭 → sig verify → seen dedup → 집계        │  │
│  │   → pushMaterial 복호화 → web-push 발송 (per target)      │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────────────┬─────────────────────────────────────────────────┘
                │ HTTPS POST + VAPID, payload {v:1}
                ▼
   FCM / APNs / Mozilla  →  SW 'push' → showNotification
                │ 탭
                ▼
   클라 복호화 → 같은 tag로 showNotification 교체 ("1000 sats 받음")
```

**핵심**: 서버는 어떤 유저가 어떤 이벤트를 받는지 **언제나 모름**(opaque inboxPub + 로컬 매칭). relay는 서버가 특정 유저를 본다는 사실 **모름**(firehose). 클라만 연결을 안다.

---

## 3. 신원 모델

- **결제 경로(주)**: sender가 `#p = inboxPub(epoch)`로 전송. sender는 `ReceiveRequest`(도메인)에 inboxPub를 실어 전달. epoch 회전(예: 월 1회) → relay/서버가 장기 linkage 불가.
- **비결제(DM 등)**: 실명 npub 경로. push 보장 안 함(약화) 또는 비활성. 결제 경로와 **분리**.
- **서버 저장**: `record[inboxPub] = { filter, pushMaterial }`. inboxPub은 opaque·회전이라 실명과 무관. DB가 유출돼도 npub 매핑 없음.
  - 선택 난독화: `record[HMAC(salt, inboxPub)]`로 저장하면 raw inboxPub도 미영속(poll/요청 시 일시적으로만 봄).
- **pushMaterial**: endpoint + keys. 필요 시 저장 암호화.

---

## 4. relay 상호작용 (hostile 대응의 핵심)

- **지속 구독 없음.** live sub는 relay에게 "알림 서버" 지문 + 상시 조작 창을 줌.
- **60초 ± 지터**마다 일회성 쿼리:
  ```
  pool.querySync(union(relays), { kinds:[1059], since: cursor })
  ```
  - `since`가 짧아 **poll당 다운로드량 작음** (자주 poll = 저용량).
  - cursor는 기존 `giftwrap-cursor` 도메인 재사용 (`giftwrapCursorKey`, lastFullSync−Ω).
- **다중 relay union** — 한 relay 검열/누락해도 커버.
- **로컬 `#p` 매칭** — 서버가 활성 inbox 토큰 집합을 메모리에 보유(opaque). relay엔 `#p` 미노출.
- **검증**: 모든 이벤트 `event.verify()`, seen-events dedup, `max_p_tags` 상한.
- **비용**: firehose-1059는 kind:1 firehose보다 훨씬 작음. 1분 주기면 poll당 window도 작음.

### hostile relay 잔여
- **주입**: 외부 서명키 랜덤이라 서버가 진위 판별 불가 → 스팸 push 가능. **전달을 비권위로 두고** rate limit + 집계로 완화. funds 무영향.
- **검열/누락**: push 안 옴 → 앱 열 때 커서가 복구. 손실 없음.

---

## 5. 서버 (Bun)

### 5.1 컴포넌트

`[pure]` = 순수 코어(I/O 0), `[shell]` = I/O 배선.

```
src/
  types.ts          [pure]  InboxPub(branded) · Event · Sub · PushMaterial
  core.ts           [pure]  buildFilter · matchInbox · dedup · aggregate · jitter · advanceCursor
  core.selfcheck.ts [test]  assert 기반 순수 코어 검증
  server.ts         [shell] HTTP (subscribe/unsubscribe/healthz)
  registry.ts       [shell] record[inboxPub] → {pushMaterial, relays}
  poller.ts         [shell] 60s±jitter firehose querySync + 코어 조합
  relay-client.ts   [shell] 다중 relay union (nostr-tools SimplePool)
  push-sender.ts    [shell] web-push (VAPID), 410 정리, rate limit
  config.ts
```
- 스택: Bun + `nostr-tools` + `web-push`. VAPID 키는 secret.
- 영속성: MVP in-memory → 이후 Redis/SQLite. **npub·IP는 어떤 경우에도 저장 X.**

### 5.2 API & 인증

API:
| Method | Path | Body |
|---|---|---|
| POST | `/push/subscribe` | NIP-98 + `{ filter:{kinds:[1059],'#p':[inboxPub]}, push:{endpoint,keys} }` |
| POST | `/push/unsubscribe` | NIP-98 (signer=inboxPub) |
| GET | `/healthz` | — |

인증: **NIP-98**(inbox key 서명) — 계정 없이 소유 증명. 서명자 = record key = filter `#p`값 (모두 같은 inboxPub).

### 5.3 설계 패턴 — Functional Core / Imperative Shell

배포는 하나(**모듈러 모노리스**), 로직은 순수 함수로 격리(**functional core**). **헥사고널 아님** — 도메인 얇고(레지스트리 lookup + dedup + 매칭 + 집계) 코드 대부분이 인프라 I/O(Nostr/web-push/HTTP). 포트=PJ 구현 1개면 추상화 부채. 구현 2개 되는 시점에 포트 추출.

```
shell:  fetch → [dedup] → [matchInbox] → [aggregate] → send
                 ↑core       ↑core         ↑core
        (I/O + 조합)   (관심사 1개씩, 순수, mock 불필요)
```

- **core** — I/O 0. 시계·랜덤·SDK 모름. 같은 입력=같은 출력. 함수 각자 관심사 하나. 서로 호출 OK, 금지되는 건 I/O/프레임워크 인지뿐.
- **shell** — 코어 함수를 *조합* + I/O. 로직 X, 배선만.

```ts
// core.ts — pure
export function matchInbox(active: Set<string>, ev: Event): string | null {
  for (const [k, v] of ev.tags) if (k === 'p' && active.has(v)) return v
  return null
}
export const aggregate = (hits: string[]) => [...new Set(hits)]           // target당 1건
export const jitter = (r: number, base = 60_000, spread = 15_000) =>
  base + (r * 2 - 1) * spread                                             // ±지터
export const advanceCursor = (prev: number, evs: Event[]) =>
  evs.reduce((m, e) => Math.max(m, e.created_at), prev)
```

```ts
// poller.ts — shell (얇음)
const events = await pool.querySync(state.relays, { kinds: [1059], since: state.cursor }) // firehose, #p 없음
const fresh  = dedup(state.seen, events.filter(verifyEvent))
const hits   = fresh.map(e => matchInbox(state.activeInbox, e)).filter(Boolean)
for (const inbox of aggregate(hits)) {
  const sub = state.registry.get(inbox)
  if (sub) await webpush.sendNotification(sub.push, JSON.stringify({ v: 1 }))  // content-less
}
state.cursor = advanceCursor(state.cursor, fresh)
setTimeout(() => tick(...), jitter(Math.random()))
```

`bun core.selfcheck.ts`로 순수 코어 검증 (프레임워크 X).

### 5.4 Invariant을 타입으로

위협 모델 = invariant. 레이어 대신 타입으로 강제 (make illegal states unrepresentable).

| invariant | 타입 강제 |
|---|---|
| npub 저장 금지 | 서버에 `Npub` 타입 정의 안 함. registry key = `InboxPub`(branded)만 |
| 내용 못 봄 | push payload = `{v:1}` literal. 다른 필드 컴파일 불가 |
| IP 로그 금지 | 리퀘스트 로거에 `req.ip` 미전달 (접근 자체 차단) |
| `#p` REQ 금지 | relay client는 firehose filter만 받는 시그니처 |

### 5.5 Bun Workspace 구조 (server + client SDK)

별도 repo 대신 **Bun workspace 모노레포**. 패키지 **둘**: `server`(Bun push 서버) + `client-sdk`(클라 프로토콜·등록). wire 계약(inboxPub 파생, filter, payload `{v:1}`)을 한 곳에서 관리 → 서버/클라 타입 드리프트 0.

```
zappi-push/                  (workspace root)
├── package.json             { "private": true, "workspaces": ["server", "packages/*"] }
├── server/                  Bun push 서버 (§5.1)
│   └── package.json         deps: nostr-tools, web-push, @zappi/push-client(workspace)
└── packages/
    └── push-client/         @zappi/push-client  = client SDK
        ├── src/protocol.ts  [pure]  InboxPub(branded) · Filter · payload {v:1}  ← server도 import
        ├── src/inbox-key.ts [pure]  HKDF(seed, "zappi/notif/"+epoch) → InboxPub
        └── src/register.ts  [io]    NIP-98 서명 + subscribe/unsubscribe fetch
```

- **`protocol.ts`는 순수** — server는 **type-only import**로 소비(런타임 I/O 미유입). §5.4 invariant 타입은 여기 한 곳에 정의.
- server → push-client 의존은 **프로토콜 한정**. SDK는 서버를 모름(역방향 의존 X).
- 배포: server = Bun 바이너리/Docker, SDK = npm publish(또는 PWA가 workspace로 직접 소비).
- 이점: 단일 `bun install`/lock, 원자적 프로토콜 변경, 두 패키지 독립 배포.

### 5.6 Contract 공유 (서버↔SDK 응집)

**contract = 서버↔클라가 주고받는 데이터의 약속된 모양.** 이 서비스의 contract: `subscribe` body(`{filter, push}`), `filter` shape, payload `{v:1}`, `InboxPub` 타입.

**공유 = 한 곳에 정의하고 양쪽이 import.** 각자 정의하면 drift.

```
❌ 안 공유 (drift — 컴파일러가 못 잡음)
client.ts: type Sub = { filter:{kinds:number[]}, push:{endpoint:string} }
server.ts: type Sub = { filters:{kind:number[]},  push:{endpoint,key:string} }

✅ 공유 (한 정의를 둘 다 import)
protocol.ts: export type SubscribeReq = { filter: Filter; push: PushMaterial }
client.ts:   import { SubscribeReq } from './protocol'          // 정의 X, 가져옴
server.ts:   import type { SubscribeReq } from '@zappi/push-client/protocol'
             // 한쪽 바꾸면 다른 쪽 컴파일 에러 → drift 0
```

- **공유 대상 (pure)**: types · schema 검증 · builders(`buildFilter`/`buildSubscribeReq`/`buildPushPayload`) · `PROTOCOL_VERSION`.
- **공유 금지 (shell)**: relay/webpush/HTTP(server), `fetch`/SW(client). shell 공유는 응집 아닌 결합.
- **응집은 core에서만 상승.** 목표: 양쪽이 *동일한 순수 함수* 재사용, 중복은 얇은 shell 어댑터에만.
- **원칙**: contract는 공유해라, 패키지는 쪼개지 마라.

**P1 배치** — 별도 `packages/protocol` **불필요**. `push-client/src/protocol.ts` [pure]에 두고 server가 **type-only import**. 순수 공유 로직이 얇음(타입·상수 위주), 3번째 패키지는 ceremony.

**승격 트리거** — 공유 순수 *로직*(schema 검증, builder, 파생)이 늘거나 `server → push-client` 의존이 어색해지면 그때 중립 `packages/protocol`로 분리.

---

## 6. 전달

- payload: **content-less** `{v:1}` (gift-wrap은 4KB 초과라 원래 못 실음, FCM/OS에 내용 노출 0).
- **집계**: window 내 도착분 → target당 1건("새 결제 도착" / "N건 도착").
- **지터**: push 시각 살짝 분산 → L20 cross-correlation 완화.
- **tag-replace**: 앱 열면 복호화 후 같은 `tag:'zappi-incoming'`으로 재호출 → OS가 교체.
  ```
  앱 lock 중: showNotification("새 결제 도착", {tag:'zappi-incoming', silent:true})
  앱 unlock 후: showNotification("1000 sats 받음", {tag:'zappi-incoming'})  // 교체
  ```
- 410/EndpointNotFound → 즉시 제거.

---

## 7. 클라이언트 통합

### 7.1 Service Worker
`generateSW` → **`injectManifest` + 커스텀 `src/sw.ts`** 전환 필수 (커스텀 `push`/`notificationclick`/`pushsubscriptionchange`).
```ts
self.addEventListener('push', e => e.waitUntil(
  self.registration.showNotification('새 결제 도착', { tag:'zappi-incoming', silent:true, data:{url:'/'} })))
self.addEventListener('notificationclick', e => { e.notification.close()
  e.waitUntil(self.clients.matchAll({type:'window'}).then(cs => cs[0] ? cs[0].focus() : self.clients.openWindow('/'))) })
self.addEventListener('pushsubscriptionchange', e => e.waitUntil(reRegister()))
```

### 7.2 포트/어댑터 (hexagonal)
```
core/ports/driven/push-subscription.port.ts    interface PushSubscriptionGateway
adapters/runtime/web-push.adapter.ts           pushManager + Notification 권한
```
composition에서 `ServiceRegistry` 노출. core 서비스는 Notification API 모름.

### 7.3 생명주기
- 등록: unlock 직후 (`bootstrap-lifecycle.ts` `activate()`), 권한은 설정 토글(user gesture)에서 요청. iOS는 **설치형 필수, 16.4+, `userVisibleOnly:true`**.
- foreground/background-alive: 기존 `NostrIncomingWatcher` 직접 구독 (onPause에서 안 멈춤, `bootstrap-lifecycle.ts:310`). 실시간.
- frozen/killed: 서버 60s poll이 커버.
- `incoming:received`(`domain-events.ts:206`) observer → `showNotification` tag-replace.
- epoch 회전 시 재등록.

### 7.4 파일 맵
| 구분 | 경로 |
|---|---|
| 서버 | `server/` (신규, §5.5) |
| SDK | `packages/push-client/` (신규, §5.5) |
| SW | `src/sw.ts` (신규) + `vite.config.ts` |
| 포트 | `src/core/ports/driven/push-subscription.port.ts` |
| 어댑터 | `src/adapters/runtime/web-push.adapter.ts` |
| 합성 | `src/composition/bootstrap-lifecycle.ts`, `notification.observer.ts` (신규) |
| UI | 설정 화면 알림 토글 |
| 설정 | VAPID public key env |

---

## 8. 플랫폼별 전달 사슬

프로토콜 동일, push service 제공자만 다름 (`endpoint` 도메인).

| 플랫폼 | push service | endpoint | OS wake | PWA 설치 |
|---|---|---|---|---|
| Android Chrome | FCM | `fcm.googleapis.com` | ✅ Play Services | 불필요 |
| iOS Safari | Apple | `web.push.apple.com` | ✅ APNs (16.4+) | **필수** |
| Desktop Chrome/Edge | FCM | `fcm.googleapis.com` | ❌ 브라우저 상주 | 불필요 |
| Desktop Firefox | Mozilla | `updates.push.services.mozilla.com` | ❌ 브라우저 상주 | 불필요 |
| macOS Safari | Apple | `web.push.apple.com` | ✅ APNs | 불필요 |

서버 코드는 동일: `webpush.sendNotification(sub, payload, vapid)`.

---

## 9. 파라미터

| 값 | 기본 | 이유 |
|---|---|---|
| poll 간격 | **60s** | 유저 허용 지연 |
| poll 지터 | **±15s** (0~20s 랜덤) | L20 상관 완화 |
| push 집계 | **window당 target당 1건** | 타이밍·개수 노출 최소 |
| relay 수 | **≥2 (union)** | 검열/누락 저항 |
| epoch 회전 | 월 1회 (정책) | 장기 linkage 차단 |
| max_p_tags | 10 (NNS 차용) | 스팸 이벤트 상한 |

---

## 10. 보안 체크리스트

- [ ] VAPID private key secret, 커밋 금지
- [ ] **npub·IP 저장/로그 금지**, record key는 opaque inboxPub(또는 그 HMAC)
- [ ] 서명검증 · seen-events dedup · max_p_tags
- [ ] rate limit (target당 burst/refill — NNS `default.toml:22` 차용)
- [ ] 410/404 즉시 구독 제거
- [ ] NIP-98 등록 인증
- [ ] relay SSRF 검증(설정이면): `wss://` + 사설 IP 차단
- [ ] `pushsubscriptionchange` 재등록 경로
- [ ] 가입 시 클라 IP 미로깅

> ⚠️ non-custodial 경계: nsec/seed 또는 파생 비밀을 서버/SW로 전송 금지.

---

## 11. 남는 위협 (정직하게)

- **FCM/APNs chokepoint** — 게이트키퍼가 적대자면 붕괴. 실명을 서버에 안 두는 이유. push service는 pseudonymous endpoint + 타이밍만.
- **push endpoint capability** — 서버가 push하려면 보유해야 함. 암호화 저장 + rate limit + epoch 회전으로 완화.
- **타이밍 상관(L20)** — relay↔push service collude 시 잔존. 60s+지터로 노이즈만.
- **firehose = 운영자가 타인의 gift-wrap 메타데이터 봄** — hostile relay 회피의 대가. operator 신뢰 필요, 최소보관.
- **주입 push 스팸** — 비권위 원칙으로 funds 무영향, UX만.

---

## 12. 단계별 롤아웃

**P1 — MVP**
- 범위: **단일 NIP-98 인증**(signer = inboxPub = filter `#p` = record key). token·HMAC·디커플링 없음.
- record key = inboxPub (실명 npub 미보관).
1. `injectManifest` + `sw.ts`
2. Bun 서버: in-memory registry + 60s poller + web-push
3. 클라 등록(권한+subscribe+POST), tag-replace
4. generic 알림 동작 확인 (Android/Desktop/iOS)

**P2 — 안정화**
- Redis 영속화, 다중 relay union, 서명검증/dedup/max_p_tags, rate limit, 410 정리

**P3 — 프라이버시**
- 회전 inbox key(모델 B) + `ReceiveRequest` 확장
- epoch별 push 재구독(endpoint 회전)
- (선택) hint envelope로 잠금 후 금액 표시 — 시드 공유 금지

---

## 13. 대안: mmalmi/nostr-notification-server

Rust + LMDB + Flatbuffers, Iris.to 백엔드. **firehose + 로컬매칭**이라 우리 hostile-relay 모델과 relay 전략은 일치. NIP-98/rate limit/410/dedup/FCM·APNs/webhook 다 구현. 필터가 임의라 **회전 inbox key가 코드 0줄로 동작**.
- 채택 시 얻는 것: auth·rate limit·영속화·멀티플랫폼·Docker.
- 비용: Rust ops, LMDB, 일반용 설계(지갑 도메인 무관).
- 판단: 범용+운영팀 Rust 가능 → fork. 지갑 전용 최소+TS 통일 → 자체 Bun + NNS 패턴 차용. **본 모델은 후자 기준.**

---

## 14. 미해결

- ~~서버 위치: 별도 repo vs monorepo `server/`~~ → **결정: Bun workspace 모노레포, `server` + `packages/push-client` (§5.5)**
- poll cursor 소유: 서버 전역 vs 토큰별
- 실명 npub(DM) 경로 push 여부
- lock/unlock 시 서버 구독 add/remove 정책
- epoch 회전 주기·endpoint 재구독 여부
- VAPID 키 회전 정책

---

## 15. 서비스 이름 — 결정: **Kkachi (까치)**

**결정: `Kkachi`(까치).** npm 미등록(FREE) — `kkachi`·`kkachi-push`·`kkachi-server`·`kkachi-sdk`·`kkachi-notify` 모두 registry 404.

**연관성 (프로그램 ↔ 까치):**

| 프로그램 | 까치 |
|---|---|
| push = wake hint (깨우기만) | 까치 울음 = 반가운 소식 알림. 소리만, 내용은 당사자 확인 |
| content-less `{v:1}` | "반가운 일 있음"만 전함. 내용 운반 X |
| 서버 blind (내용 못 봄) | 소식 전하는 새, 편지 안 읽음 |
| 비권위 (funds 무관) | 까치 울어도 길조 신호일 뿐. 수령은 클라가 결정 |
| 다중 relay union | 오작교 = 까치떼가 다리 놓음(여러 마리 = 여러 경로) |
| sender ↔ receiver | 견우·직녀 = 두 지점 연결 |

핵심 은유: 까치떼가 은하수에 다리(오작교)를 놓아 떨어진 둘을 잇는다 = 서버가 relay↔클라 사이 전달 경로를 놓아 알림을 전한다. 내용은 안 딛고(안 읽고) 건너가게만 함.

**까마귀 아님** (까마귀 → 로마자 `Kkamagwi`): 흉조(까치=길조), `까` 떼면 마귀(魔鬼)=악마, `kk` 발음·철자 난.

**회피:** `Iris`(Iris.to = Nostr 클라), `pigeon`(flypigeon·self-hosted push 충돌), `courier`(SaaS 충돌).

**패키지명:** `@zappi/kkachi`(SDK), `kkachi-server`, `kkachi-notify`.

