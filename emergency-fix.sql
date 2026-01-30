-- EMERGENCY FIX for UserConcert schema issue
-- This adds the missing columns that Parse Server expects

-- Add the missing 'user' and 'concert' columns if they don't exist
ALTER TABLE "UserConcert"
ADD COLUMN IF NOT EXISTS "user" VARCHAR;

ALTER TABLE "UserConcert"
ADD COLUMN IF NOT EXISTS "concert" VARCHAR;

-- Populate them with the objectIds from the pointer columns
UPDATE "UserConcert"
SET
  "user" = SPLIT_PART("_p_user", '$', 2),
  "concert" = SPLIT_PART("_p_concert", '$', 2)
WHERE "user" IS NULL AND "_p_user" IS NOT NULL;

-- Verify the fix
SELECT
  COUNT(*) as total,
  COUNT("user") as with_user,
  COUNT("_p_user") as with_p_user
FROM "UserConcert";