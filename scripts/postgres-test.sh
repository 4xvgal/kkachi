#!/usr/bin/env bash
# Spin up a throwaway Postgres and run the gated Postgres Store contract test.
#
#   bun run test:postgres
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${NAME:-kkachi-pg-test}"
PORT="${PGPORT:-55432}"
URL="postgres://kkachi:kkachi@localhost:$PORT/kkachi"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
echo "[pg-test] starting postgres on :$PORT"
docker run -d --name "$NAME" \
  -e POSTGRES_USER=kkachi -e POSTGRES_PASSWORD=kkachi -e POSTGRES_DB=kkachi \
  -p "$PORT:5432" postgres:16-alpine >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U kkachi -d kkachi >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "[pg-test] running Store contract against postgres"
POSTGRES_URL="$URL" bun test server/test/postgres-store.test.ts
echo "[pg-test] ok"
