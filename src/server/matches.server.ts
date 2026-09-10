import { Prisma, type EventMatch } from '@prisma/client'
import { prisma } from '#/db'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getR2KeyFromUrl, r2Client, R2_BUCKET_NAME } from '#/lib/r2'

/**
 * Server-only helpers shared by swipes.ts, requests.ts and admin.ts.
 *
 * These live in a `.server.ts` module rather than alongside the server
 * functions that use them: a plain exported function in a module that route
 * components import cannot be stripped by the RPC bridge, so it drags the
 * whole module — and therefore Prisma — into the client bundle.
 */

/**
 * Create the match for a pair, or return the existing one.
 *
 * Two people liking each other at the same moment used to produce two match
 * rows and two sets of "It's a Match!" notifications, because this was a
 * findFirst followed by an unguarded create. Partial unique indexes now make
 * the duplicate impossible at the database level (one for event-scoped
 * matches, one for global ones, since a NULL eventId is distinct in a plain
 * unique index); catching P2002 turns the loser of the race into a read.
 */
export async function findOrCreateMatch(
  eventId: string | null,
  userA: string,
  userB: string,
): Promise<{ match: EventMatch; created: boolean }> {
  // Callers always store the pair in sorted order, which makes the unique
  // index canonical regardless of who swiped first.
  const [user1Id, user2Id] = [userA, userB].sort() as [string, string]

  const existing = await prisma.eventMatch.findFirst({
    where: { eventId, user1Id, user2Id },
  })
  if (existing) return { match: existing, created: false }

  const event = eventId
    ? await prisma.event.findUnique({ where: { id: eventId }, select: { mysteryMode: true } })
    : null

  try {
    const match = await prisma.eventMatch.create({
      data: {
        eventId,
        user1Id,
        user2Id,
        messagesUnlockedAt: event?.mysteryMode ? null : new Date(),
      },
    })
    return { match, created: true }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await prisma.eventMatch.findFirst({
        where: { eventId, user1Id, user2Id },
      })
      if (raced) return { match: raced, created: false }
    }
    throw err
  }
}

/**
 * Remove the R2 objects backing voice messages in the given matches. Call this
 * *before* deleting the matches, while the rows are still readable.
 *
 * NO CALLER YET — deliberately. Nothing in the app deletes a match: event
 * deletion sets EventMatch.eventId to NULL rather than cascading (see the
 * global-discovery migration), so conversations and their audio survive. Wire
 * this into account deletion, or any future match cleanup, before adding one —
 * those are the paths that would otherwise orphan the objects in R2.
 */
export async function deleteVoiceFilesForMatches(matchIds: string[]) {
  if (matchIds.length === 0) return

  const voiceMessages = await prisma.eventMessage.findMany({
    where: { matchId: { in: matchIds }, type: 'voice', audioUrl: { not: null } },
    select: { audioUrl: true },
  })

  // Concurrent rather than one blocking round trip per file.
  await Promise.allSettled(
    voiceMessages.map(async (msg) => {
      const key = msg.audioUrl ? getR2KeyFromUrl(msg.audioUrl) : null
      if (!key) return
      try {
        await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
      } catch (err) {
        console.warn('[R2 Cleanup] Failed to delete voice file:', err)
      }
    }),
  )
}
