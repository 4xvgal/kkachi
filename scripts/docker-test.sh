#!/usr/bin/env bash
# Build + run the kkachi server with Postgres via docker compose, then exercise
# the SDK registration path against it end to end (production-like).
#
#   bun run test:docker
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
export PORT
export HOST_PORT="${HOST_PORT:-$PORT}"
export POSTGRES_USER="${POSTGRES_USER:-kkachi}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-kkachi}"
export POSTGRES_DB="${POSTGRES_DB:-kkachi}"

echo "[docker-test] generating throwaway VAPID keys"
VAPID_JSON="$(cd server && bun -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))")"
export VAPID_PUBLIC_KEY="$(printf '%s' "$VAPID_JSON" | bun -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).publicKey))")"
export VAPID_PRIVATE_KEY="$(printf '%s' "$VAPID_JSON" | bun -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).privateKey))")"

cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "[docker-test] docker compose up (postgres + server)"
docker compose up -d --build

for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "[docker-test] running SDK smoke test"
KKACHI_URL="http://localhost:$PORT" bun run server/scripts/smoke.ts
echo "[docker-test] ok"
