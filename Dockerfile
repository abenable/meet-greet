# Stage 1: Build
FROM oven/bun:1 AS builder

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and build
COPY . .
RUN bun run db:generate
RUN bun run build

# Stage 2: Production dependencies only
#
# The runner used to copy the builder's entire node_modules, which shipped
# vite, typescript, vitest and jsdom into the runtime image. Resolve a
# production-only tree here instead.
#
# Note the `prisma` CLI is a production dependency, not a dev one: entrypoint.sh
# runs `prisma migrate deploy` on start, so the binary has to exist in this
# tree — `--production` would otherwise drop it.
FROM oven/bun:1 AS deps

WORKDIR /app
COPY package.json bun.lock ./
# --production alone is not enough: vitest is an optional peer of better-auth
# and typescript an optional peer of @prisma/client, so both reappear in the
# tree even with devDependencies dropped. The app runs from the bundle in
# dist/, so no peer is needed at runtime.
RUN bun install --frozen-lockfile --production --omit=optional --omit=peer
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
# Generate the client once, at build time. The entrypoint used to re-run this
# on every container start.
RUN bunx prisma generate

# Stage 3: Runtime
FROM oven/bun:1-slim AS runner

WORKDIR /app

# OpenSSL for Prisma; ca-certificates for outbound TLS (R2, Mailtrap, push).
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=bun:bun /app/dist ./dist
COPY --from=deps    --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
COPY --from=builder --chown=bun:bun /app/prisma ./prisma
COPY --from=builder --chown=bun:bun /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=bun:bun /app/server.prod.ts ./server.prod.ts
COPY --from=builder --chown=bun:bun /app/src ./src
COPY --chown=bun:bun entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000

# Drop root. The image previously ran the server as uid 0.
USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
