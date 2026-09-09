-- DropForeignKey
ALTER TABLE "EventMatch" DROP CONSTRAINT "EventMatch_eventId_fkey";

-- DropForeignKey
ALTER TABLE "EventSwipe" DROP CONSTRAINT "EventSwipe_eventId_fkey";

-- AlterTable
ALTER TABLE "EventMatch" ALTER COLUMN "eventId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "EventMessageRequest" ALTER COLUMN "eventId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "EventSwipe" ALTER COLUMN "eventId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "discoveryMode" TEXT NOT NULL DEFAULT 'global';

-- AddForeignKey
ALTER TABLE "EventSwipe" ADD CONSTRAINT "EventSwipe_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMatch" ADD CONSTRAINT "EventMatch_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Enforce one global swipe per (swiper, swiped) pair; the existing compound
-- unique index on (eventId, swiperId, swipedId) doesn't dedupe NULL eventId rows.
CREATE UNIQUE INDEX "EventSwipe_global_swiper_swiped_key" ON "EventSwipe" ("swiperId", "swipedId") WHERE "eventId" IS NULL;
