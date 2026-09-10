-- Audit remediation: referential integrity, uniqueness, and indexes for the
-- queries that actually run in production.
--
-- ⚠️  DESTRUCTIVE STEP: section 1 deletes rows that reference users which no
-- longer exist. Those rows are already unreachable through the app (every read
-- path joins them back to User and drops the misses), but they cannot be kept
-- once the foreign keys below exist. Take a backup before running this.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Purge orphans so the foreign keys in section 3 can be created
-- ─────────────────────────────────────────────────────────────────────────────

DELETE FROM "Profile"              WHERE "userId"     NOT IN (SELECT "id" FROM "User");
DELETE FROM "EventAttendee"        WHERE "userId"     NOT IN (SELECT "id" FROM "User");
DELETE FROM "EventSwipe"           WHERE "swiperId"   NOT IN (SELECT "id" FROM "User")
                                      OR "swipedId"   NOT IN (SELECT "id" FROM "User");
-- EventMessage first: it cascades from EventMatch, but its own senderId FK
-- must also resolve.
DELETE FROM "EventMessage"         WHERE "senderId"   NOT IN (SELECT "id" FROM "User");
DELETE FROM "EventMessage"         WHERE "matchId"    IN (
  SELECT "id" FROM "EventMatch"
  WHERE "user1Id" NOT IN (SELECT "id" FROM "User")
     OR "user2Id" NOT IN (SELECT "id" FROM "User")
);
DELETE FROM "EventMatch"           WHERE "user1Id"    NOT IN (SELECT "id" FROM "User")
                                      OR "user2Id"    NOT IN (SELECT "id" FROM "User");
DELETE FROM "Notification"         WHERE "userId"     NOT IN (SELECT "id" FROM "User");
DELETE FROM "Report"               WHERE "reporterId" NOT IN (SELECT "id" FROM "User")
                                      OR "reportedId" NOT IN (SELECT "id" FROM "User");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Collapse duplicates that the new unique constraints would reject
-- ─────────────────────────────────────────────────────────────────────────────

-- Duplicate reports from the same reporter against the same target: keep the
-- oldest, drop the rest. This is also what makes the shadow-ban threshold
-- meaningful again (2 reports must now mean 2 distinct reporters).
DELETE FROM "Report" a
USING "Report" b
WHERE a."reporterId" = b."reporterId"
  AND a."reportedId" = b."reportedId"
  AND a."eventId" IS NOT DISTINCT FROM b."eventId"
  AND (a."createdAt", a."id") > (b."createdAt", b."id");

-- Duplicate matches for the same pair (possible before the partial unique
-- indexes below existed): keep the oldest and re-point its messages.
WITH ranked AS (
  SELECT "id",
         FIRST_VALUE("id") OVER (
           PARTITION BY "eventId", "user1Id", "user2Id"
           ORDER BY "createdAt", "id"
         ) AS keep_id
  FROM "EventMatch"
)
UPDATE "EventMessage" m
SET "matchId" = r.keep_id
FROM ranked r
WHERE m."matchId" = r."id" AND r."id" <> r.keep_id;

DELETE FROM "EventMatch" a
USING "EventMatch" b
WHERE a."user1Id" = b."user1Id"
  AND a."user2Id" = b."user2Id"
  AND a."eventId" IS NOT DISTINCT FROM b."eventId"
  AND (a."createdAt", a."id") > (b."createdAt", b."id");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. New columns
-- ─────────────────────────────────────────────────────────────────────────────

-- Streaks get their own column; the presence heartbeat owns lastActiveDate and
-- was silently clobbering the value the streak calculation read.
ALTER TABLE "User" ADD COLUMN "lastStreakDate" TIMESTAMP(3);
UPDATE "User" SET "lastStreakDate" = "lastActiveDate" WHERE "lastActiveDate" IS NOT NULL;

-- Failed-attempt counter so a 6-digit OTP cannot be brute-forced.
ALTER TABLE "Verification" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- Photo verification becomes a review queue. verifiedAt is now written only by
-- an admin action; previously any user could POST any image and grant
-- themselves the badge.
ALTER TABLE "Profile"
  ADD COLUMN "verificationPhoto" TEXT,
  ADD COLUMN "verificationSubmittedAt" TIMESTAMP(3),
  ADD COLUMN "verificationStatus" TEXT;

-- Existing badges were self-granted and are not trustworthy. Clear them and
-- let people re-submit through the reviewed flow.
UPDATE "Profile" SET "verifiedAt" = NULL WHERE "verifiedAt" IS NOT NULL;

CREATE INDEX "Profile_verificationStatus_verificationSubmittedAt_idx"
  ON "Profile" ("verificationStatus", "verificationSubmittedAt");

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Drop the dead Todo model
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS "Todo";

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Foreign keys to User
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Profile"       ADD CONSTRAINT "Profile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventAttendee" ADD CONSTRAINT "EventAttendee_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventSwipe"    ADD CONSTRAINT "EventSwipe_swiperId_fkey"
  FOREIGN KEY ("swiperId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventSwipe"    ADD CONSTRAINT "EventSwipe_swipedId_fkey"
  FOREIGN KEY ("swipedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventMatch"    ADD CONSTRAINT "EventMatch_user1Id_fkey"
  FOREIGN KEY ("user1Id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventMatch"    ADD CONSTRAINT "EventMatch_user2Id_fkey"
  FOREIGN KEY ("user2Id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventMessage"  ADD CONSTRAINT "EventMessage_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification"  ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Report"        ADD CONSTRAINT "Report_reporterId_fkey"
  FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Report"        ADD CONSTRAINT "Report_reportedId_fkey"
  FOREIGN KEY ("reportedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Uniqueness
-- ─────────────────────────────────────────────────────────────────────────────

-- One report per (reporter, target, event). NULL eventId is distinct in a
-- normal unique index, so global reports need a partial index of their own.
CREATE UNIQUE INDEX "Report_reporterId_reportedId_eventId_key"
  ON "Report" ("reporterId", "reportedId", "eventId");
CREATE UNIQUE INDEX "Report_global_reporter_reported_key"
  ON "Report" ("reporterId", "reportedId") WHERE "eventId" IS NULL;

-- One match per pair, event-scoped and global. Callers always sort the two ids
-- before writing, so (user1Id, user2Id) is canonical.
CREATE UNIQUE INDEX "EventMatch_event_pair_key"
  ON "EventMatch" ("eventId", "user1Id", "user2Id") WHERE "eventId" IS NOT NULL;
CREATE UNIQUE INDEX "EventMatch_global_pair_key"
  ON "EventMatch" ("user1Id", "user2Id") WHERE "eventId" IS NULL;

-- Same NULL-distinct fix for global message requests.
CREATE UNIQUE INDEX "EventMessageRequest_global_sender_receiver_key"
  ON "EventMessageRequest" ("senderId", "receiverId") WHERE "eventId" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Indexes for the hot paths
-- ─────────────────────────────────────────────────────────────────────────────

-- getMatches / getConversations filter `OR [user1Id, user2Id]` with no eventId,
-- so the old (eventId, userNId) indexes could never be used. Replace them.
DROP INDEX IF EXISTS "EventMatch_eventId_user1Id_idx";
DROP INDEX IF EXISTS "EventMatch_eventId_user2Id_idx";
CREATE INDEX "EventMatch_user1Id_createdAt_idx" ON "EventMatch" ("user1Id", "createdAt");
CREATE INDEX "EventMatch_user2Id_createdAt_idx" ON "EventMatch" ("user2Id", "createdAt");
CREATE INDEX "EventMatch_eventId_idx"           ON "EventMatch" ("eventId");

-- EventOrganizerMessage had no indexes at all despite being scanned by both
-- sender and receiver on every chat-list load.
CREATE INDEX "EventOrganizerMessage_senderId_createdAt_idx"
  ON "EventOrganizerMessage" ("senderId", "createdAt");
CREATE INDEX "EventOrganizerMessage_receiverId_createdAt_idx"
  ON "EventOrganizerMessage" ("receiverId", "createdAt");
CREATE INDEX "EventOrganizerMessage_receiverId_readAt_idx"
  ON "EventOrganizerMessage" ("receiverId", "readAt");
CREATE INDEX "EventOrganizerMessage_eventId_senderId_receiverId_createdAt_idx"
  ON "EventOrganizerMessage" ("eventId", "senderId", "receiverId", "createdAt");

-- Report had no indexes; the auto-moderation groupBy runs on every deck build.
CREATE INDEX "Report_reportedId_status_createdAt_idx" ON "Report" ("reportedId", "status", "createdAt");
CREATE INDEX "Report_status_createdAt_idx"            ON "Report" ("status", "createdAt");
CREATE INDEX "Report_reporterId_createdAt_idx"        ON "Report" ("reporterId", "createdAt");

-- Unread-count groupBy over messages.
CREATE INDEX "EventMessage_matchId_readAt_senderId_idx"
  ON "EventMessage" ("matchId", "readAt", "senderId");

-- Discovery pool paging.
CREATE INDEX "Profile_discoveryMode_boostedUntil_idx" ON "Profile" ("discoveryMode", "boostedUntil");

-- Swipe-history exclusion and incoming-like lookups.
CREATE INDEX "EventSwipe_swiperId_eventId_idx"  ON "EventSwipe" ("swiperId", "eventId");
CREATE INDEX "EventSwipe_swipedId_direction_idx" ON "EventSwipe" ("swipedId", "direction");

-- Attendee lookups by user, and the 30-day "social butterfly" count.
CREATE INDEX "EventAttendee_userId_leftAt_idx"   ON "EventAttendee" ("userId", "leftAt");
CREATE INDEX "EventAttendee_userId_joinedAt_idx" ON "EventAttendee" ("userId", "joinedAt");

-- Waitlist promotion and "my waitlisted events".
CREATE INDEX "EventWaitlist_userId_idx"          ON "EventWaitlist" ("userId");
CREATE INDEX "EventWaitlist_eventId_joinedAt_idx" ON "EventWaitlist" ("eventId", "joinedAt");

-- Message requests by either side.
CREATE INDEX "EventMessageRequest_receiverId_status_createdAt_idx"
  ON "EventMessageRequest" ("receiverId", "status", "createdAt");
CREATE INDEX "EventMessageRequest_senderId_status_createdAt_idx"
  ON "EventMessageRequest" ("senderId", "status", "createdAt");

-- Session cleanup on disable/reset deletes by userId.
CREATE INDEX "Session_userId_idx" ON "Session" ("userId");

-- OTP lookup/cleanup by identifier.
CREATE INDEX "Verification_identifier_idx" ON "Verification" ("identifier");
