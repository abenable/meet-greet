#!/bin/sh
set -e

# Migrations run on start by default.
#
# `prisma migrate deploy` takes a Postgres advisory lock, so if you ever run
# more than one replica they serialise rather than corrupt each other — the
# extra containers just wait for the first to finish. Set RUN_MIGRATIONS=0 to
# skip this and run migrations as a separate deploy step instead:
#
#   docker compose run --rm web ./entrypoint.sh migrate
#
# `prisma generate` is NOT run here — the client is generated at image build
# time, so it no longer costs anything on every container start.

if [ "$1" = "migrate" ]; then
  echo "Deploying migrations..."
  exec bunx prisma migrate deploy
fi

if [ "$RUN_MIGRATIONS" != "0" ]; then
  echo "Deploying migrations..."
  bunx prisma migrate deploy
fi

echo "Starting server..."
exec bun run server.prod.ts
