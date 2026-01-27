import { db, toPointer } from "../lib/db";
import type {
	ProfileVisibility,
	TopArtist,
	TopCity,
	TopVenue,
	YearlyCount,
} from "../lib/db.types";
import { checkHasActiveKey, checkIsFollower } from "./privacy";

interface AddConcertParams {
	artist_id: string;
	venue_id: string;
	concert_date: string; // ISO date string
	notes?: string;
	setlist?: string[];
	setlist_id?: string;
	setlist_unavailable?: boolean;
}

interface GetUserConcertsParams {
	user_id?: string; // If not provided, uses current user
	limit?: number;
	skip?: number;
	start_date?: string;
	end_date?: string;
	artist_id?: string;
	venue_id?: string;
}

interface UpdateConcertParams {
	concert_id: string;
	notes?: string;
	setlist?: string[];
	setlist_id?: string;
	setlist_unavailable?: boolean;
}

/**
 * Add a new concert
 */
Parse.Cloud.define(
	"addConcert",
	async (request: Parse.Cloud.FunctionRequest<AddConcertParams>) => {
		const {
			artist_id,
			venue_id,
			concert_date,
			notes,
			setlist,
			setlist_id,
			setlist_unavailable,
		} = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!artist_id || !venue_id || !concert_date) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Artist, venue, and concert date are required",
			);
		}

		// Validate artist exists
		const artistQuery = new Parse.Query("Artist");
		const artist = await artistQuery.get(artist_id);
		if (!artist) {
			throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, "Artist not found");
		}

		// Validate venue exists
		const venueQuery = new Parse.Query("Venue");
		const venue = await venueQuery.get(venue_id);
		if (!venue) {
			throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, "Venue not found");
		}

		// Parse date
		const date = new Date(concert_date);
		if (Number.isNaN(date.getTime())) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Invalid concert date");
		}

		// Check for duplicate concert (same user, artist, venue, date)
		const duplicateQuery = new Parse.Query("Concert");
		duplicateQuery.equalTo("user", user);
		duplicateQuery.equalTo("artist", artist);
		duplicateQuery.equalTo("venue", venue);

		// Date comparison within same day
		const startOfDay = new Date(date);
		startOfDay.setHours(0, 0, 0, 0);
		const endOfDay = new Date(date);
		endOfDay.setHours(23, 59, 59, 999);

		duplicateQuery.greaterThanOrEqualTo("concert_date", startOfDay);
		duplicateQuery.lessThanOrEqualTo("concert_date", endOfDay);

		const existing = await duplicateQuery.first({ useMasterKey: true });
		if (existing) {
			throw new Parse.Error(
				Parse.Error.DUPLICATE_VALUE,
				"You already have this concert logged",
			);
		}

		// Create concert
		const Concert = Parse.Object.extend("Concert");
		const concert = new Concert();

		concert.set("artist", artist);
		concert.set("venue", venue);
		concert.set("user", user);
		concert.set("concert_date", date);

		if (notes) concert.set("notes", notes.trim());
		if (setlist) concert.set("setlist", setlist);
		if (setlist_id) concert.set("setlist_id", setlist_id);
		if (setlist_unavailable !== undefined) {
			concert.set("setlist_unavailable", setlist_unavailable);
		}

		// Set ACL - owner can read/write, others can read
		const acl = new Parse.ACL(user);
		acl.setPublicReadAccess(true);
		concert.setACL(acl);

		await concert.save(null, { useMasterKey: true });

		// Update user's total_gigs count
		user.increment("total_gigs");
		await user.save(null, { useMasterKey: true });

		// Return with artist and venue data included
		const result = concert.toJSON();
		result.artist = artist.toJSON();
		result.venue = venue.toJSON();

		return result;
	},
);

/**
 * Get user's concerts with filtering and pagination
 * Respects profile visibility and connection key access for upcoming concerts
 */
Parse.Cloud.define(
	"getUserConcerts",
	async (request: Parse.Cloud.FunctionRequest<GetUserConcertsParams>) => {
		const {
			user_id,
			limit = 50,
			skip = 0,
			start_date,
			end_date,
			artist_id,
			venue_id,
		} = request.params;
		const currentUser = request.user;

		// Determine which user's concerts to fetch
		let targetUser: Parse.User | undefined;
		if (user_id) {
			const userQuery = new Parse.Query<Parse.User>("_User");
			targetUser = await userQuery.get(user_id, { useMasterKey: true });
		} else if (currentUser) {
			targetUser = currentUser;
		} else {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"User ID required or must be authenticated",
			);
		}

		const isOwnConcerts = currentUser?.id === targetUser.id;
		const profileVisibility =
			(targetUser.get("profile_visibility") as ProfileVisibility) || "public";

		// Determine access level
		let canSeeUpcoming = isOwnConcerts;
		let isFollower = false;

		if (!isOwnConcerts && currentUser) {
			// Check if viewer is following target (needed for private profiles)
			isFollower = await checkIsFollower(currentUser.id, targetUser.id);

			// Check if viewer has connection key from target
			if (!canSeeUpcoming) {
				canSeeUpcoming = await checkHasActiveKey(currentUser.id, targetUser.id);
			}
		}

		// Private profile check: non-followers cannot see any concerts
		if (profileVisibility === "private" && !isOwnConcerts && !isFollower) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"This profile is private",
			);
		}

		const query = new Parse.Query("Concert");
		query.equalTo("user", targetUser);
		query.include("artist");
		query.include("venue");
		query.descending("concert_date");
		query.limit(Math.min(limit, 100));
		query.skip(skip);

		// Date filters
		if (start_date) {
			query.greaterThanOrEqualTo("concert_date", new Date(start_date));
		}
		if (end_date) {
			query.lessThanOrEqualTo("concert_date", new Date(end_date));
		}

		// If viewer cannot see upcoming concerts, filter to past only
		// Today at midnight is the cutoff - today's concerts are "upcoming"
		if (!canSeeUpcoming) {
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			query.lessThan("concert_date", today);
		}

		// Artist filter
		if (artist_id) {
			const artistPointer =
				Parse.Object.extend("Artist").createWithoutData(artist_id);
			query.equalTo("artist", artistPointer);
		}

		// Venue filter
		if (venue_id) {
			const venuePointer =
				Parse.Object.extend("Venue").createWithoutData(venue_id);
			query.equalTo("venue", venuePointer);
		}

		const [results, total] = await Promise.all([
			query.find(),
			query.count({ useMasterKey: true }),
		]);

		return {
			results: results.map((concert) => concert.toJSON()),
			count: results.length,
			total,
			can_see_upcoming: canSeeUpcoming,
		};
	},
);

/**
 * Update a concert
 */
Parse.Cloud.define(
	"updateConcert",
	async (request: Parse.Cloud.FunctionRequest<UpdateConcertParams>) => {
		const { concert_id, notes, setlist, setlist_id, setlist_unavailable } =
			request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!concert_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Concert ID required");
		}

		const query = new Parse.Query("Concert");
		query.include("artist");
		query.include("venue");
		const concert = await query.get(concert_id);

		// Verify ownership
		const concertUser = concert.get("user");
		if (!concertUser || concertUser.id !== user.id) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"You can only update your own concerts",
			);
		}

		// Update fields
		if (notes !== undefined) concert.set("notes", notes?.trim() || "");
		if (setlist !== undefined) concert.set("setlist", setlist);
		if (setlist_id !== undefined) concert.set("setlist_id", setlist_id);
		if (setlist_unavailable !== undefined) {
			concert.set("setlist_unavailable", setlist_unavailable);
		}

		await concert.save(null, { useMasterKey: true });

		return concert.toJSON();
	},
);

/**
 * Delete a concert
 */
Parse.Cloud.define(
	"deleteConcert",
	async (request: Parse.Cloud.FunctionRequest<{ concert_id: string }>) => {
		const { concert_id } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!concert_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Concert ID required");
		}

		const query = new Parse.Query("Concert");
		const concert = await query.get(concert_id);

		// Verify ownership
		const concertUser = concert.get("user");
		if (!concertUser || concertUser.id !== user.id) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"You can only delete your own concerts",
			);
		}

		// Delete associated photos
		const photoQuery = new Parse.Query("ConcertPhoto");
		photoQuery.equalTo("concert", concert);
		const photos = await photoQuery.find({ useMasterKey: true });

		if (photos.length > 0) {
			await Parse.Object.destroyAll(photos, { useMasterKey: true });
		}

		// Delete concert
		await concert.destroy({ useMasterKey: true });

		// Update user's total_gigs count
		user.increment("total_gigs", -1);
		await user.save(null, { useMasterKey: true });

		return { success: true };
	},
);

/**
 * Get concert by ID with full details
 */
Parse.Cloud.define(
	"getConcert",
	async (request: Parse.Cloud.FunctionRequest<{ concert_id: string }>) => {
		const { concert_id } = request.params;

		if (!concert_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Concert ID required");
		}

		const query = new Parse.Query("Concert");
		query.include("artist");
		query.include("venue");
		query.include("user");
		const concert = await query.get(concert_id);

		// Get photos for this concert
		const photoQuery = new Parse.Query("ConcertPhoto");
		photoQuery.equalTo("concert", concert);
		photoQuery.descending("createdAt");
		const photos = await photoQuery.find();

		const result = concert.toJSON();
		result.photos = photos.map((photo) => photo.toJSON());

		return result;
	},
);

/**
 * Get concerts on this day in history (for "On This Day" feature)
 */
Parse.Cloud.define(
	"getConcertsOnThisDay",
	async (
		request: Parse.Cloud.FunctionRequest<{
			month: number;
			day: number;
			user_id?: string;
		}>,
	) => {
		const { month, day, user_id } = request.params;
		const user = request.user;

		if (!user && !user_id) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated or user_id provided",
			);
		}

		let targetUser: Parse.User | undefined;
		if (user_id) {
			const userQuery = new Parse.Query<Parse.User>("_User");
			targetUser = await userQuery.get(user_id, { useMasterKey: true });
		} else {
			targetUser = user;
		}

		// This requires a raw query or aggregation to match month/day
		// For now, we'll fetch all user concerts and filter in JS
		// In production, this could be optimized with a database function
		const query = new Parse.Query("Concert");
		query.equalTo("user", targetUser);
		query.include("artist");
		query.include("venue");
		query.descending("concert_date");
		query.limit(1000);

		const concerts = await query.find();

		const matchingConcerts = concerts.filter((concert) => {
			const concertDate = concert.get("concert_date");
			return (
				concertDate.getMonth() + 1 === month && concertDate.getDate() === day
			);
		});

		return {
			results: matchingConcerts.map((concert) => concert.toJSON()),
			count: matchingConcerts.length,
		};
	},
);

/**
 * Get concert statistics for a user
 * Uses Bun.sql for efficient database aggregations (~1.86x faster than pg)
 */
Parse.Cloud.define(
	"getConcertStats",
	async (request: Parse.Cloud.FunctionRequest<{ user_id?: string }>) => {
		const { user_id } = request.params;
		const currentUser = request.user;

		let targetUserId: string;
		if (user_id) {
			// Validate user exists via Parse
			const userQuery = new Parse.Query<Parse.User>("_User");
			const targetUser = await userQuery.get(user_id, { useMasterKey: true });
			targetUserId = targetUser.id;
		} else if (currentUser) {
			targetUserId = currentUser.id;
		} else {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"User ID required or must be authenticated",
			);
		}

		// Parse stores user pointers as "_User$objectId"
		const userPointer = toPointer("_User", targetUserId);

		// Run all aggregation queries in parallel using Bun.sql
		const [
			summaryStats,
			topArtistsResult,
			topVenuesResult,
			topCitiesResult,
			yearlyStats,
		] = await Promise.all([
			// Summary statistics
			db`
				SELECT
					COUNT(*)::int as total_concerts,
					COUNT(DISTINCT "_p_artist")::int as unique_artists,
					COUNT(DISTINCT "_p_venue")::int as unique_venues
				FROM "Concert"
				WHERE "_p_user" = ${userPointer}
			`,

			// Top 10 artists
			db`
				SELECT
					SPLIT_PART(c."_p_artist", '$', 2) as id,
					a."name",
					COUNT(*)::int as count
				FROM "Concert" c
				LEFT JOIN "Artist" a ON a."_id" = SPLIT_PART(c."_p_artist", '$', 2)
				WHERE c."_p_user" = ${userPointer}
				GROUP BY c."_p_artist", a."name"
				ORDER BY count DESC
				LIMIT 10
			`,

			// Top 10 venues
			db`
				SELECT
					SPLIT_PART(c."_p_venue", '$', 2) as id,
					v."name",
					COUNT(*)::int as count
				FROM "Concert" c
				LEFT JOIN "Venue" v ON v."_id" = SPLIT_PART(c."_p_venue", '$', 2)
				WHERE c."_p_user" = ${userPointer}
				GROUP BY c."_p_venue", v."name"
				ORDER BY count DESC
				LIMIT 10
			`,

			// Top 10 cities
			db`
				SELECT
					v."city",
					COUNT(*)::int as count
				FROM "Concert" c
				LEFT JOIN "Venue" v ON v."_id" = SPLIT_PART(c."_p_venue", '$', 2)
				WHERE c."_p_user" = ${userPointer}
					AND v."city" IS NOT NULL
				GROUP BY v."city"
				ORDER BY count DESC
				LIMIT 10
			`,

			// Concerts by year
			db`
				SELECT
					EXTRACT(YEAR FROM "concert_date")::int as year,
					COUNT(*)::int as count
				FROM "Concert"
				WHERE "_p_user" = ${userPointer}
				GROUP BY EXTRACT(YEAR FROM "concert_date")
				ORDER BY year DESC
			`,
		]);

		const summary = summaryStats[0] || {
			total_concerts: 0,
			unique_artists: 0,
			unique_venues: 0,
		};

		return {
			total_concerts: summary.total_concerts,
			unique_artists: summary.unique_artists,
			unique_venues: summary.unique_venues,
			top_artists: topArtistsResult as TopArtist[],
			top_venues: topVenuesResult as TopVenue[],
			top_cities: topCitiesResult as TopCity[],
			concerts_by_year: yearlyStats as YearlyCount[],
		};
	},
);
