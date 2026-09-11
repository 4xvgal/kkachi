# syntax=docker/dockerfile:1
FROM oven/bun:1.3

WORKDIR /app

# Install workspace deps first for layer caching.
COPY package.json bun.lock ./
COPY packages/push-client/package.json packages/push-client/package.json
COPY server/package.json server/package.json
RUN bun install --frozen-lockfile

# Full source (overwrites the placeholder package.json copies).
COPY . .

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Non-custodial, blind server: no npub, no IP logging. See architecture §5.
CMD ["bun", "run", "server/src/server.ts"]
