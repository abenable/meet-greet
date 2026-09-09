import { createFileRoute } from '@tanstack/react-router'
import { prisma } from '#/db'

async function handleHealthCheck() {
  try {
    await prisma.$queryRaw`SELECT 1`
    return Response.json(
      { status: 'ok', db: 'ok', timestamp: new Date().toISOString() },
      { status: 200 },
    )
  } catch (error: any) {
    console.error('[Health Check] DB check failed', error)
    return Response.json(
      { status: 'error', db: 'unreachable', timestamp: new Date().toISOString() },
      { status: 503 },
    )
  }
}

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: handleHealthCheck,
    },
  },
})
