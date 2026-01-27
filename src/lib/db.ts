import { SQL } from "bun";

/**
 * Bun.sql client for performance-critical queries
 * Uses same Neon connection as Parse but with Bun's native driver (~1.86x faster)
 *
 * Use this for:
 * - Complex aggregations (stats, analytics)
 * - Bulk operations
 * - Performance-critical queries
 * - Custom reporting
 *
 * Use Parse for:
 * - Authentication
 * - Schema management & CLPs
 * - Standard CRUD via cloud functions
 *
 * @see https://neon.com/docs/guides/bun
 */
export const db = new SQL(process.env.DATABASE_URL!);

/**
 * Helper for Parse table names
 * Parse uses quoted table names, and internal tables are prefixed with underscore
 */
export const tables = {
	Concert: '"Concert"',
	Artist: '"Artist"',
	Venue: '"Venue"',
	ConcertPhoto: '"ConcertPhoto"',
	User: '"_User"',
	Session: '"_Session"',
	Role: '"_Role"',
} as const;

/**
 * Convert Parse object ID to pointer format used in database
 * Parse stores pointers as "ClassName$objectId"
 */
export function toPointer(className: string, objectId: string): string {
	return `${className}$${objectId}`;
}

/**
 * Extract objectId from a Parse pointer string
 */
export function fromPointer(pointer: string): string {
	const parts = pointer.split("$");
	return parts[parts.length - 1] ?? pointer;
}
