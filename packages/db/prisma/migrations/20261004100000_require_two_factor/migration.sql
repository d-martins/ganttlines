-- CreateEnum
CREATE TYPE "TwoFactorRequirement" AS ENUM ('off', 'admins', 'everyone');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "viaSso" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "requireTwoFactor" "TwoFactorRequirement" NOT NULL DEFAULT 'off';
