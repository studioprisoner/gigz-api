import { sql } from "bun";

// Test connection using Bun's native SQL
console.log("Testing Bun native SQL connection to Neon...");

try {
	const result =
		await sql`SELECT NOW() as current_time, version() as pg_version`;
	console.log("✅ Connection successful!");
	console.log("Current time:", result[0].current_time);
	console.log("PostgreSQL version:", result[0].pg_version);

	// Test creating a simple table
	await sql`CREATE TABLE IF NOT EXISTS test_connection (id SERIAL PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW())`;
	console.log("✅ Table creation works");

	// Clean up
	await sql`DROP TABLE IF EXISTS test_connection`;
	console.log("✅ Cleanup successful");

	await sql.close();
	process.exit(0);
} catch (error) {
	console.error("❌ Connection failed:", error);
	process.exit(1);
}
