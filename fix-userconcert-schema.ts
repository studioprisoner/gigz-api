#!/usr/bin/env bun
/**
 * CRITICAL FIX: Resolve UserConcert schema issues
 *
 * This script fixes the duplicate pointer column issue that's causing
 * "user is required" errors in production.
 *
 * The problem: After migration from Supabase, we have duplicate columns:
 * - Old columns: user, concert (varchar)
 * - New columns: _p_user, _p_concert (Parse pointers)
 *
 * Parse validates against the OLD columns which remain NULL.
 */

import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

async function fixUserConcertSchema() {
	const pool = new Pool({
		connectionString: process.env.DATABASE_URL,
		ssl: { rejectUnauthorized: false }
	});

	try {
		console.log("🔧 Starting UserConcert schema fix...\n");

		// Step 1: Check current state
		console.log("1️⃣ Checking current database state...");
		const checkColumns = await pool.query(`
			SELECT column_name, is_nullable, data_type
			FROM information_schema.columns
			WHERE table_name = 'UserConcert'
			AND column_name IN ('user', 'concert', '_p_user', '_p_concert')
			ORDER BY column_name;
		`);

		console.log("Current columns:");
		checkColumns.rows.forEach(col => {
			console.log(`  - ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
		});

		// Step 2: Populate old columns from new columns where needed
		console.log("\n2️⃣ Syncing pointer columns...");
		const syncResult = await pool.query(`
			UPDATE "UserConcert"
			SET
				"user" = SPLIT_PART("_p_user", '$', 2),
				"concert" = SPLIT_PART("_p_concert", '$', 2)
			WHERE
				"user" IS NULL
				AND "_p_user" IS NOT NULL
			RETURNING "objectId";
		`);

		console.log(`  ✅ Synced ${syncResult.rowCount} rows`);

		// Step 3: Check and update Parse _SCHEMA table
		console.log("\n3️⃣ Checking Parse _SCHEMA table...");
		const schemaCheck = await pool.query(`
			SELECT schema->'fields'->'user'->>'required' as user_required
			FROM "_SCHEMA"
			WHERE "className" = 'UserConcert';
		`);

		if (schemaCheck.rows[0]?.user_required === 'false') {
			console.log("  ⚠️ Schema has user as optional, updating to required...");
			await pool.query(`
				UPDATE "_SCHEMA"
				SET schema = jsonb_set(
					schema::jsonb,
					'{fields,user,required}',
					'true'
				)
				WHERE "className" = 'UserConcert';
			`);
			console.log("  ✅ Updated schema to mark user as required");
		} else {
			console.log("  ✅ Schema already has user as required");
		}

		// Step 4: Verify all UserConcert records have proper data
		console.log("\n4️⃣ Verifying data integrity...");
		const invalidRecords = await pool.query(`
			SELECT COUNT(*) as count
			FROM "UserConcert"
			WHERE "user" IS NULL OR "concert" IS NULL
			   OR "_p_user" IS NULL OR "_p_concert" IS NULL;
		`);

		if (invalidRecords.rows[0].count > 0) {
			console.log(`  ⚠️ Found ${invalidRecords.rows[0].count} records with missing data`);

			// Try to fix them
			const fixResult = await pool.query(`
				DELETE FROM "UserConcert"
				WHERE ("user" IS NULL AND "_p_user" IS NULL)
				   OR ("concert" IS NULL AND "_p_concert" IS NULL)
				RETURNING "objectId";
			`);

			if (fixResult.rowCount > 0) {
				console.log(`  🗑️ Deleted ${fixResult.rowCount} invalid records`);
			}
		} else {
			console.log("  ✅ All UserConcert records have valid pointers");
		}

		// Step 5: Final verification
		console.log("\n5️⃣ Final verification...");
		const stats = await pool.query(`
			SELECT
				COUNT(*) as total_records,
				COUNT(CASE WHEN "user" IS NOT NULL THEN 1 END) as with_user,
				COUNT(CASE WHEN "_p_user" IS NOT NULL THEN 1 END) as with_p_user,
				COUNT(CASE WHEN "concert" IS NOT NULL THEN 1 END) as with_concert,
				COUNT(CASE WHEN "_p_concert" IS NOT NULL THEN 1 END) as with_p_concert
			FROM "UserConcert";
		`);

		const s = stats.rows[0];
		console.log(`  Total records: ${s.total_records}`);
		console.log(`  Records with 'user': ${s.with_user}`);
		console.log(`  Records with '_p_user': ${s.with_p_user}`);
		console.log(`  Records with 'concert': ${s.with_concert}`);
		console.log(`  Records with '_p_concert': ${s.with_p_concert}`);

		console.log("\n✅ Schema fix complete!");
		console.log("\n⚠️ IMPORTANT: You must restart the Parse Server for schema changes to take effect!");
		console.log("Run: docker compose restart (or however you restart your server)");

	} catch (error) {
		console.error("❌ Error fixing schema:", error);
		throw error;
	} finally {
		await pool.end();
	}
}

// Run the fix
fixUserConcertSchema().catch(console.error);