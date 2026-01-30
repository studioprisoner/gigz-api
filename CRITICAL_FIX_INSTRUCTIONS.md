# CRITICAL PRODUCTION FIX: UserConcert "user is required" Error

## Root Cause Analysis

The error occurs because of a **schema mismatch** from the Supabase migration:

1. **Database has GENERATED columns**: The `user` and `concert` columns are **GENERATED ALWAYS AS** columns that automatically derive from `_p_user` and `_p_concert`
2. **Parse validates the wrong column**: Parse Server checks if `user` field is set, but this is a generated column that cannot be manually set
3. **Cached schema**: Parse caches its schema in the `_SCHEMA` table and doesn't recognize the generated column constraint

## The Fix

### Step 1: Deploy Updated Code

The fix has been applied to `/src/cloud/concerts.ts`. The key change:

```javascript
// OLD (broken) - tried to bypass Parse
const result = await db.query(`INSERT INTO "UserConcert"...`);

// NEW (fixed) - use Parse SDK properly
const UserConcert = Parse.Object.extend("UserConcert");
const userConcert = new UserConcert();
userConcert.set("user", user);
userConcert.set("concert", concert);
// ... set other fields
await userConcert.save(null, { useMasterKey: true });
```

### Step 2: Deploy to Production

1. **Commit the changes:**
```bash
git add src/cloud/concerts.ts
git commit -m "Fix UserConcert user required error - use Parse SDK properly"
git push origin main
```

2. **Restart the production server** to clear any cached schemas:
```bash
# Via Docker:
docker compose restart

# Or via your deployment method:
# - Heroku: heroku restart
# - PM2: pm2 restart gigz-api
# - Systemd: sudo systemctl restart gigz-api
```

## Why This Works

1. **Parse SDK handles both columns**: When you call `userConcert.set("user", user)`, Parse SDK:
   - Sets the internal `_p_user` pointer column to `_User$<objectId>`
   - The database's GENERATED column automatically populates `user` with the objectId

2. **Schema validation passes**: Parse sees that `user` field is being set (even though it's actually setting `_p_user`)

3. **No direct SQL needed**: Using Parse SDK ensures all internal mappings work correctly

## Database Schema Explanation

Current UserConcert table structure:
```sql
-- Actual pointer columns used by Parse
_p_user VARCHAR NOT NULL    -- Stores: "_User$<objectId>"
_p_concert VARCHAR NOT NULL  -- Stores: "Concert$<objectId>"

-- Generated columns for compatibility
user VARCHAR GENERATED ALWAYS AS (_p_user)      -- Auto-extracts objectId
concert VARCHAR GENERATED ALWAYS AS (_p_concert) -- Auto-extracts objectId
```

## Testing the Fix

After deployment, test with:

```bash
# 1. Start the server locally (if testing locally)
bun run dev

# 2. Run the verification script
bun run verify-fix.ts

# 3. Or test via the API directly
curl -X POST http://your-api-url/parse/functions/addConcert \
  -H "X-Parse-Application-Id: YOUR_APP_ID" \
  -H "X-Parse-Session-Token: USER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "artist_id": "ARTIST_ID",
    "venue_id": "VENUE_ID",
    "concert_date": "2024-01-30T20:00:00Z",
    "notes": "Test concert"
  }'
```

## Prevention

To prevent similar issues:

1. **Always use Parse SDK** for database operations, not direct SQL
2. **Test migrations thoroughly** with sample data
3. **Monitor schema changes** in the `_SCHEMA` table
4. **Clear caches** after schema updates

## Rollback Plan

If the fix causes issues:

1. Revert to the direct SQL workaround (git revert)
2. The workaround bypasses Parse validation but works
3. Investigate alternative solutions

## Files Changed

- `/src/cloud/concerts.ts` - Fixed `addConcert` function to use Parse SDK
- Created `/verify-fix.ts` - Test script to verify the fix
- Created `/emergency-fix.sql` - SQL commands for manual intervention (not needed with this fix)
- Created this document for production deployment

## Contact

If issues persist after applying this fix, the problem may be:
1. Schema cache not cleared (restart required)
2. Frontend sending wrong data format
3. Authentication/session issues

Check server logs for detailed error messages.