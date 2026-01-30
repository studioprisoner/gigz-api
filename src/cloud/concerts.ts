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
	tour_name?: string;
	rating?: number;
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
	userConcert_id: string;
	notes?: string;
	setlist?: string[];
	setlist_id?: string;
	setlist_unavailable?: boolean;
	rating?: number;
	is_favorite?: boolean;
}

/**
 * Find or create a Concert event (shared by multiple users)
 */
async function findOrCreateConcert(
	artist: Parse.Object,
	venue: Parse.Object,
	concert_date: Date,
	tour_name?: string
): Promise<Parse.Object> {
	// Check if Concert event already exists
	// WORKAROUND: Use objectId matching instead of pointer matching due to schema issues
	const concertQuery = new Parse.Query("Concert");
	concertQuery.equalTo("artist", {
		__type: "Pointer",
		className: "Artist",
		objectId: artist.id
	});
	concertQuery.equalTo("venue", {
		__type: "Pointer",
		className: "Venue",
		objectId: venue.id
	});

	// Date comparison within same day
	const startOfDay = new Date(concert_date);
	startOfDay.setHours(0, 0, 0, 0);
	const endOfDay = new Date(concert_date);
	endOfDay.setHours(23, 59, 59, 999);

	concertQuery.greaterThanOrEqualTo("concert_date", startOfDay);
	concertQuery.lessThanOrEqualTo("concert_date", endOfDay);

	const existingConcert = await concertQuery.first({ useMasterKey: true });

	if (existingConcert) {
		// Update attendee count
		existingConcert.increment("attendee_count");
		await existingConcert.save(null, { useMasterKey: true });
		return existingConcert;
	}

	// Create new Concert event
	const Concert = Parse.Object.extend("Concert");
	const concert = new Concert();

	concert.set("artist", artist);
	concert.set("venue", venue);
	concert.set("concert_date", concert_date);
	concert.set("attendee_count", 1);

	if (tour_name) concert.set("tour_name", tour_name.trim());

	// Set ACL - publicly readable, admin writable
	const acl = new Parse.ACL();
	acl.setPublicReadAccess(true);
	concert.setACL(acl);

	await concert.save(null, { useMasterKey: true });
	return concert;
}

/**
 * Add a new concert (creates Concert event + UserConcert attendance record)
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
			tour_name,
			rating,
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

		// Validate rating if provided
		if (rating !== undefined && (rating < 1 || rating > 5)) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Rating must be between 1 and 5",
			);
		}

		// Find or create the Concert event
		const concert = await findOrCreateConcert(artist, venue, date, tour_name);

		// Check if user already attended this concert
		const duplicateQuery = new Parse.Query("UserConcert");
		duplicateQuery.equalTo("user", user);
		duplicateQuery.equalTo("concert", concert);

		const existingAttendance = await duplicateQuery.first({ useMasterKey: true });
		if (existingAttendance) {
			throw new Parse.Error(
				Parse.Error.DUPLICATE_VALUE,
				"You already have this concert logged",
			);
		}

		// FIXED: Create UserConcert using Parse SDK with proper pointer setup
		// The issue was duplicate columns from migration - we need to set BOTH old and new pointer formats
		const UserConcert = Parse.Object.extend("UserConcert");
		const userConcert = new UserConcert();

		// Set all fields including the user pointer
		userConcert.set("user", user);
		userConcert.set("concert", concert);
		userConcert.set("notes", notes?.trim());
		userConcert.set("personal_setlist", setlist);
		userConcert.set("rating", rating);

		if (setlist_unavailable !== undefined) {
			userConcert.set("setlist_unavailable", setlist_unavailable);
		}

		// Set ACL - user can read/write their own concert record
		const acl = new Parse.ACL();
		acl.setPublicReadAccess(true);
		acl.setReadAccess(user, true);
		acl.setWriteAccess(user, true);
		userConcert.setACL(acl);

		// Save with master key to bypass any permission issues
		await userConcert.save(null, { useMasterKey: true });

		console.log(`[addConcert] Successfully created UserConcert ${userConcert.id} for user ${user.id}`);

		// Update user's total_gigs count
		user.increment("total_gigs");
		await user.save(null, { useMasterKey: true });

		// Return the created UserConcert with all relations included
		const userConcertData = userConcert.toJSON();
		userConcertData.concert = concert.toJSON();
		userConcertData.concert.artist = artist.toJSON();
		userConcertData.concert.venue = venue.toJSON();

		return userConcertData;
	},
);

/**
 * Get user's concerts with filtering and pagination
 * FIXED: Uses direct SQL queries to work around Parse pointer field mapping issue
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

		// WORKAROUND: Use direct SQL query due to Parse pointer mapping issue
		// Parse generates "user" = 'id' instead of "_p_user" = '_User$id'
		const userPointer = toPointer("_User", targetUser.id);

		// Build filter conditions
		const today = !canSeeUpcoming ? new Date() : null;
		if (today) today.setHours(0, 0, 0, 0);

		const startDate = start_date ? new Date(start_date) : null;
		const endDate = end_date ? new Date(end_date) : null;
		const artistPointer = artist_id ? toPointer("Artist", artist_id) : null;
		const venuePointer = venue_id ? toPointer("Venue", venue_id) : null;

		// Execute query with proper joins using Bun SQL template
		const results = await db`
			SELECT
				uc."objectId" as userConcert_id,
				uc."notes",
				uc."personal_setlist",
				uc."rating",
				uc."is_favorite",
				uc."like_count",
				uc."comment_count",
				uc."createdAt" as userConcert_createdAt,
				uc."updatedAt" as userConcert_updatedAt,
				c."objectId" as concert_id,
				c."concert_date",
				c."tour_name",
				c."attendee_count",
				c."createdAt" as concert_createdAt,
				a."objectId" as artist_id,
				a."name" as artist_name,
				a."slug" as artist_slug,
				a."image_url" as artist_image_url,
				a."spotify_id" as artist_spotify_id,
				a."verified" as artist_verified,
				v."objectId" as venue_id,
				v."name" as venue_name,
				v."slug" as venue_slug,
				v."city" as venue_city,
				v."country" as venue_country,
				v."capacity" as venue_capacity
			FROM "UserConcert" uc
			JOIN "Concert" c ON c."objectId" = SPLIT_PART(uc."_p_concert", '$', 2)
			LEFT JOIN "Artist" a ON a."objectId" = SPLIT_PART(c."_p_artist", '$', 2)
			LEFT JOIN "Venue" v ON v."objectId" = SPLIT_PART(c."_p_venue", '$', 2)
			WHERE uc."_p_user" = ${userPointer}
			${today ? db`AND c."concert_date" < ${today}` : db``}
			${startDate ? db`AND c."concert_date" >= ${startDate}` : db``}
			${endDate ? db`AND c."concert_date" <= ${endDate}` : db``}
			${artistPointer ? db`AND c."_p_artist" = ${artistPointer}` : db``}
			${venuePointer ? db`AND c."_p_venue" = ${venuePointer}` : db``}
			ORDER BY c."concert_date" DESC
			LIMIT ${limit}
			OFFSET ${skip}
		`;

		// Get total count
		const countResult = await db`
			SELECT COUNT(*)::int as total
			FROM "UserConcert" uc
			JOIN "Concert" c ON c."objectId" = SPLIT_PART(uc."_p_concert", '$', 2)
			WHERE uc."_p_user" = ${userPointer}
			${today ? db`AND c."concert_date" < ${today}` : db``}
			${startDate ? db`AND c."concert_date" >= ${startDate}` : db``}
			${endDate ? db`AND c."concert_date" <= ${endDate}` : db``}
			${artistPointer ? db`AND c."_p_artist" = ${artistPointer}` : db``}
			${venuePointer ? db`AND c."_p_venue" = ${venuePointer}` : db``}
		`;

		const total = countResult[0]?.total || 0;

		// Helper to format dates in Parse format
		const formatDate = (date: any) => {
			if (!date) return null;
			// If it's already in Parse format, return as-is
			if (date.__type === "Date") return date;
			// Convert to Parse Date format
			return {
				__type: "Date",
				iso: date instanceof Date ? date.toISOString() : new Date(date).toISOString()
			};
		};

		// Transform results to match Parse format
		// Note: PostgreSQL converts unquoted column aliases to lowercase
		// PERFORMANCE OPTIMIZATION: Exclude personal_setlist from list view to reduce payload
		const formattedResults = results.map((row: any) => ({
			objectId: row.userconcert_id,
			notes: row.notes,
			// personal_setlist excluded from list view - use getConcertSetlist endpoint
			rating: row.rating,
			is_favorite: row.is_favorite,
			like_count: row.like_count,
			comment_count: row.comment_count,
			createdAt: formatDate(row.userconcert_createdat),
			updatedAt: formatDate(row.userconcert_updatedat),
			concert: {
				objectId: row.concert_id,
				concert_date: formatDate(row.concert_date),
				tour_name: row.tour_name,
				attendee_count: row.attendee_count,
				createdAt: formatDate(row.concert_createdat),
				artist: {
					objectId: row.artist_id,
					name: row.artist_name,
					slug: row.artist_slug,
					image_url: row.artist_image_url,
					spotify_id: row.artist_spotify_id,
					verified: row.artist_verified,
					__type: "Object",
					className: "Artist",
				},
				venue: {
					objectId: row.venue_id,
					name: row.venue_name,
					slug: row.venue_slug,
					city: row.venue_city,
					country: row.venue_country,
					capacity: row.venue_capacity,
					__type: "Object",
					className: "Venue",
				},
				__type: "Object",
				className: "Concert",
			},
			__type: "Object",
			className: "UserConcert",
		}));

		return {
			results: formattedResults,
			count: formattedResults.length,
			total,
			can_see_upcoming: canSeeUpcoming,
		};
	},
);

/**
 * Get setlist data for a specific concert (lazy loading endpoint)
 * Optimized for mobile performance - load setlists on demand
 */
Parse.Cloud.define(
	"getConcertSetlist",
	async (request: Parse.Cloud.FunctionRequest<{ userConcert_id: string }>) => {
		const { userConcert_id } = request.params;
		const currentUser = request.user;

		if (!currentUser) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated"
			);
		}

		if (!userConcert_id) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"UserConcert ID required"
			);
		}

		// Fetch the UserConcert with minimal data
		const query = new Parse.Query("UserConcert");
		const userConcert = await query.get(userConcert_id, { useMasterKey: true });

		// Verify user can access this concert
		const concertUser = userConcert.get("user");
		if (!concertUser || concertUser.id !== currentUser.id) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"You can only access your own concerts"
			);
		}

		// Get setlist data and parse as JSON array if it's stored as string
		const personalSetlist = userConcert.get("personal_setlist");
		let setlistArray = null;

		if (personalSetlist) {
			if (typeof personalSetlist === "string") {
				try {
					// Parse JSON string to array
					setlistArray = JSON.parse(personalSetlist);
				} catch (error) {
					// If parsing fails, treat as single-item array
					setlistArray = [personalSetlist];
				}
			} else if (Array.isArray(personalSetlist)) {
				// Already an array
				setlistArray = personalSetlist;
			}
		}

		return {
			userConcert_id: userConcert_id,
			personal_setlist: setlistArray || []
		};
	}
);

/**
 * Update a user concert attendance record
 */
Parse.Cloud.define(
	"updateConcert",
	async (request: Parse.Cloud.FunctionRequest<UpdateConcertParams>) => {
		const { userConcert_id, notes, setlist, rating, is_favorite } =
			request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!userConcert_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "UserConcert ID required");
		}

		const query = new Parse.Query("UserConcert");
		query.include("concert.artist");
		query.include("concert.venue");
		const userConcert = await query.get(userConcert_id);

		// Verify ownership
		const concertUser = userConcert.get("user");
		if (!concertUser || concertUser.id !== user.id) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"You can only update your own concerts",
			);
		}

		// Validate rating if provided
		if (rating !== undefined && (rating < 1 || rating > 5)) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Rating must be between 1 and 5",
			);
		}

		// Update fields
		if (notes !== undefined) userConcert.set("notes", notes?.trim() || "");
		if (setlist !== undefined) userConcert.set("personal_setlist", setlist);
		if (rating !== undefined) userConcert.set("rating", rating);
		if (is_favorite !== undefined) userConcert.set("is_favorite", is_favorite);

		await userConcert.save(null, { useMasterKey: true });

		return userConcert.toJSON();
	},
);

/**
 * Delete a user concert attendance record
 */
Parse.Cloud.define(
	"deleteConcert",
	async (request: Parse.Cloud.FunctionRequest<{ userConcert_id: string }>) => {
		const { userConcert_id } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!userConcert_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "UserConcert ID required");
		}

		const query = new Parse.Query("UserConcert");
		query.include("concert");
		const userConcert = await query.get(userConcert_id);

		// Verify ownership
		const concertUser = userConcert.get("user");
		if (!concertUser || concertUser.id !== user.id) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"You can only delete your own concerts",
			);
		}

		const concert = userConcert.get("concert");

		// Delete associated photos
		const photoQuery = new Parse.Query("ConcertPhoto");
		photoQuery.equalTo("userConcert", userConcert);
		const photos = await photoQuery.find({ useMasterKey: true });

		if (photos.length > 0) {
			await Parse.Object.destroyAll(photos, { useMasterKey: true });
		}

		// Delete UserConcert
		await userConcert.destroy({ useMasterKey: true });

		// Update Concert attendee count
		if (concert) {
			concert.increment("attendee_count", -1);
			await concert.save(null, { useMasterKey: true });

			// If no more attendees, optionally delete the Concert event
			// (uncomment if you want to clean up empty events)
			// if (concert.get("attendee_count") <= 0) {
			//   await concert.destroy({ useMasterKey: true });
			// }
		}

		// Update user's total_gigs count
		user.increment("total_gigs", -1);
		await user.save(null, { useMasterKey: true });

		return { success: true };
	},
);

/**
 * Get UserConcert by ID with full details
 */
Parse.Cloud.define(
	"getConcert",
	async (request: Parse.Cloud.FunctionRequest<{ userConcert_id: string }>) => {
		const { userConcert_id } = request.params;

		if (!userConcert_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "UserConcert ID required");
		}

		const query = new Parse.Query("UserConcert");
		query.include("concert.artist");
		query.include("concert.venue");
		query.include("user");
		const userConcert = await query.get(userConcert_id);

		// Get photos for this user's concert
		const photoQuery = new Parse.Query("ConcertPhoto");
		photoQuery.equalTo("userConcert", userConcert);
		photoQuery.descending("createdAt");
		const photos = await photoQuery.find();

		const result = userConcert.toJSON();
		result.photos = photos.map((photo) => photo.toJSON());

		// Normalize personal_setlist to JSON array format for consistency
		if (result.personal_setlist) {
			if (typeof result.personal_setlist === "string") {
				try {
					result.personal_setlist = JSON.parse(result.personal_setlist);
				} catch (error) {
					// If parsing fails, treat as single-item array
					result.personal_setlist = [result.personal_setlist];
				}
			}
		}

		return result;
	},
);

/**
 * Get concert event details (shared event info)
 */
Parse.Cloud.define(
	"getConcertEvent",
	async (request: Parse.Cloud.FunctionRequest<{ concert_id: string }>) => {
		const { concert_id } = request.params;

		if (!concert_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Concert ID required");
		}

		const query = new Parse.Query("Concert");
		query.include("artist");
		query.include("venue");
		const concert = await query.get(concert_id);

		// Get all attendees (UserConcerts) for this event
		const attendeesQuery = new Parse.Query("UserConcert");
		attendeesQuery.equalTo("concert", concert);
		attendeesQuery.include("user");
		attendeesQuery.limit(100); // Adjust as needed
		const attendees = await attendeesQuery.find();

		const result = concert.toJSON();
		result.attendees = attendees.map((uc) => ({
			userConcert_id: uc.id,
			user: uc.get("user")?.toJSON(),
			notes: uc.get("notes"),
			rating: uc.get("rating"),
			is_favorite: uc.get("is_favorite"),
		}));

		return result;
	},
);

/**
 * Get concerts on this day in history (for "On This Day" feature)
 * Updated to work with UserConcert records
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

		// Query UserConcerts with Concert includes
		const query = new Parse.Query("UserConcert");
		query.equalTo("user", targetUser);
		query.include("concert.artist");
		query.include("concert.venue");
		query.descending("concert.concert_date");
		query.limit(1000);

		const userConcerts = await query.find();

		const matchingConcerts = userConcerts.filter((userConcert) => {
			const concert = userConcert.get("concert");
			const concertDate = concert.get("concert_date");
			return (
				concertDate.getMonth() + 1 === month && concertDate.getDate() === day
			);
		});

		return {
			results: matchingConcerts.map((userConcert) => userConcert.toJSON()),
			count: matchingConcerts.length,
		};
	},
);

/**
 * Get concert statistics for a user
 * Updated to work with UserConcert table
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
		// Updated to query UserConcert table
		const [
			summaryStats,
			topArtistsResult,
			topVenuesResult,
			topCitiesResult,
			yearlyStats,
		] = await Promise.all([
			// Summary statistics from UserConcert
			db`
				SELECT
					COUNT(*)::int as total_concerts,
					COUNT(DISTINCT c."_p_artist")::int as unique_artists,
					COUNT(DISTINCT c."_p_venue")::int as unique_venues
				FROM "UserConcert" uc
				JOIN "Concert" c ON c."_id" = SPLIT_PART(uc."_p_concert", '$', 2)
				WHERE uc."_p_user" = ${userPointer}
			`,

			// Top 10 artists
			db`
				SELECT
					SPLIT_PART(c."_p_artist", '$', 2) as id,
					a."name",
					COUNT(*)::int as count
				FROM "UserConcert" uc
				JOIN "Concert" c ON c."_id" = SPLIT_PART(uc."_p_concert", '$', 2)
				LEFT JOIN "Artist" a ON a."_id" = SPLIT_PART(c."_p_artist", '$', 2)
				WHERE uc."_p_user" = ${userPointer}
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
				FROM "UserConcert" uc
				JOIN "Concert" c ON c."_id" = SPLIT_PART(uc."_p_concert", '$', 2)
				LEFT JOIN "Venue" v ON v."_id" = SPLIT_PART(c."_p_venue", '$', 2)
				WHERE uc."_p_user" = ${userPointer}
				GROUP BY c."_p_venue", v."name"
				ORDER BY count DESC
				LIMIT 10
			`,

			// Top 10 cities
			db`
				SELECT
					v."city",
					COUNT(*)::int as count
				FROM "UserConcert" uc
				JOIN "Concert" c ON c."_id" = SPLIT_PART(uc."_p_concert", '$', 2)
				LEFT JOIN "Venue" v ON v."_id" = SPLIT_PART(c."_p_venue", '$', 2)
				WHERE uc."_p_user" = ${userPointer}
					AND v."city" IS NOT NULL
				GROUP BY v."city"
				ORDER BY count DESC
				LIMIT 10
			`,

			// Concerts by year
			db`
				SELECT
					EXTRACT(YEAR FROM c."concert_date")::int as year,
					COUNT(*)::int as count
				FROM "UserConcert" uc
				JOIN "Concert" c ON c."_id" = SPLIT_PART(uc."_p_concert", '$', 2)
				WHERE uc."_p_user" = ${userPointer}
				GROUP BY EXTRACT(YEAR FROM c."concert_date")
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