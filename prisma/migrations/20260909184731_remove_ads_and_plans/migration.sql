-- AlterTable
ALTER TABLE "User" DROP COLUMN "subscriptionExpiresAt",
DROP COLUMN "subscriptionTier";

-- DropTable
DROP TABLE "AdView";

-- DropTable
DROP TABLE "DailySwipeLimit";
