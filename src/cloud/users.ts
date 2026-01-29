import type { ProfileVisibility } from "../lib/db.types";
import {
	checkHasActiveKey,
	checkIsFollower,
	checkMutualConnection,
} from "./privacy";

interface UpdateProfileParams {
	full_name?: string;
	phone_number?: string;
	city?: string;
	profile_picture_url?: string;
	username?: string;
}

interface GetNotificationPreferencesResult {
	on_this_day_enabled: boolean;
	on_this_day_time: string;
	festival_reminders_enabled: boolean;
	likes_enabled: boolean;
	comments_enabled: boolean;
	followers_enabled: boolean;
}

interface UpdateNotificationPreferencesParams {
	on_this_day_enabled?: boolean;
	on_this_day_time?: string;
	festival_reminders_enabled?: boolean;
	likes_enabled?: boolean;
	comments_enabled?: boolean;
	followers_enabled?: boolean;
}

/**
 * Get current user's profile
 */
Parse.Cloud.define(
	"getProfile",
	async (request: Parse.Cloud.FunctionRequest) => {
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		// Fetch fresh user data
		const userQuery = new Parse.Query<Parse.User>("_User");
		const freshUser = await userQuery.get(user.id, { useMasterKey: true });

		return {
			id: freshUser.id,
			username: freshUser.get("username"),
			email: freshUser.get("email"),
			full_name: freshUser.get("full_name"),
			phone_number: freshUser.get("phone_number"),
			profile_picture_url: freshUser.get("profile_picture_url"),
			subscription_status: freshUser.get("subscription_status") || "free",
			total_gigs: freshUser.get("total_gigs") || 0,
			city: freshUser.get("city"),
			follower_count: freshUser.get("follower_count") || 0,
			following_count: freshUser.get("following_count") || 0,
			profile_visibility:
				(freshUser.get("profile_visibility") as ProfileVisibility) || "public",
			createdAt: freshUser.createdAt,
			updatedAt: freshUser.updatedAt,
		};
	},
);

/**
 * Get a user's public profile
 * Respects profile visibility settings
 */
Parse.Cloud.define(
	"getUserProfile",
	async (request: Parse.Cloud.FunctionRequest<{ user_id: string }>) => {
		const { user_id } = request.params;
		const currentUser = request.user;

		if (!user_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "User ID required");
		}

		const userQuery = new Parse.Query<Parse.User>("_User");
		const targetUser = await userQuery.get(user_id, { useMasterKey: true });

		const profileVisibility =
			(targetUser.get("profile_visibility") as ProfileVisibility) || "public";

		// Check access for private profiles
		const isOwnProfile = currentUser?.id === user_id;
		let isFollower = false;
		let isMutualConnection = false;
		let hasKey = false;

		if (!isOwnProfile && currentUser) {
			// Check relationship status in parallel
			const [followerStatus, mutualStatus, keyStatus] = await Promise.all([
				checkIsFollower(currentUser.id, user_id),
				checkMutualConnection(currentUser.id, user_id),
				checkHasActiveKey(currentUser.id, user_id),
			]);
			isFollower = followerStatus;
			isMutualConnection = mutualStatus;
			hasKey = keyStatus;
		}

		// Private profile access check
		if (profileVisibility === "private" && !isOwnProfile && !isFollower) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"This profile is private",
			);
		}

		// Return public fields + relationship info
		return {
			id: targetUser.id,
			username: targetUser.get("username"),
			full_name: targetUser.get("full_name"),
			profile_picture_url: targetUser.get("profile_picture_url"),
			total_gigs: targetUser.get("total_gigs") || 0,
			city: targetUser.get("city"),
			follower_count: targetUser.get("follower_count") || 0,
			following_count: targetUser.get("following_count") || 0,
			profile_visibility: profileVisibility,
			is_mutual_connection: isMutualConnection,
			has_key: hasKey,
			createdAt: targetUser.createdAt,
		};
	},
);

/**
 * Update current user's profile
 */
Parse.Cloud.define(
	"updateProfile",
	async (request: Parse.Cloud.FunctionRequest<UpdateProfileParams>) => {
		const { full_name, phone_number, city, profile_picture_url, username } =
			request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		// Handle username update
		if (username !== undefined) {
			const trimmedUsername = username.trim().toLowerCase();

			// Validate username format: 3-30 chars, alphanumeric + underscore only
			const usernameRegex = /^[a-z0-9_]{3,30}$/;
			if (!usernameRegex.test(trimmedUsername)) {
				throw new Parse.Error(
					Parse.Error.INVALID_VALUE,
					"Username must be 3-30 characters and contain only letters, numbers, and underscores",
				);
			}

			// Check if username is different from current
			const currentUsername = user.get("username");
			if (trimmedUsername !== currentUsername?.toLowerCase()) {
				// Check if username is already taken
				const usernameQuery = new Parse.Query(Parse.User);
				usernameQuery.equalTo("username", trimmedUsername);
				usernameQuery.notEqualTo("objectId", user.id);
				const existingUser = await usernameQuery.first({ useMasterKey: true });

				if (existingUser) {
					throw new Parse.Error(
						Parse.Error.USERNAME_TAKEN,
						"Username is already taken",
					);
				}

				user.set("username", trimmedUsername);
			}
		}

		if (full_name !== undefined) user.set("full_name", full_name?.trim() || "");
		if (phone_number !== undefined)
			user.set("phone_number", phone_number?.trim() || "");
		if (city !== undefined) user.set("city", city?.trim() || "");
		if (profile_picture_url !== undefined)
			user.set("profile_picture_url", profile_picture_url);

		await user.save(null, { useMasterKey: true });

		return {
			id: user.id,
			username: user.get("username"),
			email: user.get("email"),
			full_name: user.get("full_name"),
			phone_number: user.get("phone_number"),
			profile_picture_url: user.get("profile_picture_url"),
			subscription_status: user.get("subscription_status") || "free",
			total_gigs: user.get("total_gigs") || 0,
			city: user.get("city"),
			follower_count: user.get("follower_count") || 0,
			following_count: user.get("following_count") || 0,
			profile_visibility:
				(user.get("profile_visibility") as ProfileVisibility) || "public",
		};
	},
);

/**
 * Get notification preferences
 */
Parse.Cloud.define(
	"getNotificationPreferences",
	async (
		request: Parse.Cloud.FunctionRequest,
	): Promise<GetNotificationPreferencesResult> => {
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		const query = new Parse.Query("NotificationPreference");
		query.equalTo("user", user);
		const existingPrefs = await query.first({ useMasterKey: true });

		let prefs: Parse.Object;
		if (existingPrefs) {
			prefs = existingPrefs;
		} else {
			// Create default preferences
			const NotificationPreference = Parse.Object.extend(
				"NotificationPreference",
			);
			prefs = new NotificationPreference();
			prefs.set("user", user);
			prefs.set("on_this_day_enabled", true);
			prefs.set("on_this_day_time", "09:00");
			prefs.set("festival_reminders_enabled", true);
			prefs.set("likes_enabled", true);
			prefs.set("comments_enabled", true);
			prefs.set("followers_enabled", true);

			const acl = new Parse.ACL(user);
			prefs.setACL(acl);

			await prefs.save(null, { useMasterKey: true });
		}

		return {
			on_this_day_enabled: prefs.get("on_this_day_enabled"),
			on_this_day_time: prefs.get("on_this_day_time"),
			festival_reminders_enabled: prefs.get("festival_reminders_enabled"),
			likes_enabled: prefs.get("likes_enabled"),
			comments_enabled: prefs.get("comments_enabled"),
			followers_enabled: prefs.get("followers_enabled"),
		};
	},
);

/**
 * Update notification preferences
 */
Parse.Cloud.define(
	"updateNotificationPreferences",
	async (
		request: Parse.Cloud.FunctionRequest<UpdateNotificationPreferencesParams>,
	): Promise<GetNotificationPreferencesResult> => {
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		const {
			on_this_day_enabled,
			on_this_day_time,
			festival_reminders_enabled,
			likes_enabled,
			comments_enabled,
			followers_enabled,
		} = request.params;

		const query = new Parse.Query("NotificationPreference");
		query.equalTo("user", user);
		const existingPrefs = await query.first({ useMasterKey: true });

		let prefs: Parse.Object;
		if (existingPrefs) {
			prefs = existingPrefs;
		} else {
			// Create new preferences
			const NotificationPreference = Parse.Object.extend(
				"NotificationPreference",
			);
			prefs = new NotificationPreference();
			prefs.set("user", user);

			const acl = new Parse.ACL(user);
			prefs.setACL(acl);
		}

		if (on_this_day_enabled !== undefined)
			prefs.set("on_this_day_enabled", on_this_day_enabled);
		if (on_this_day_time !== undefined)
			prefs.set("on_this_day_time", on_this_day_time);
		if (festival_reminders_enabled !== undefined)
			prefs.set("festival_reminders_enabled", festival_reminders_enabled);
		if (likes_enabled !== undefined) prefs.set("likes_enabled", likes_enabled);
		if (comments_enabled !== undefined)
			prefs.set("comments_enabled", comments_enabled);
		if (followers_enabled !== undefined)
			prefs.set("followers_enabled", followers_enabled);

		await prefs.save(null, { useMasterKey: true });

		return {
			on_this_day_enabled: prefs.get("on_this_day_enabled"),
			on_this_day_time: prefs.get("on_this_day_time"),
			festival_reminders_enabled: prefs.get("festival_reminders_enabled"),
			likes_enabled: prefs.get("likes_enabled"),
			comments_enabled: prefs.get("comments_enabled"),
			followers_enabled: prefs.get("followers_enabled"),
		};
	},
);

// Account deletion grace period (30 days)
const DELETION_GRACE_PERIOD_DAYS = 30;

/**
 * Helper function to permanently delete a user and all their data
 * Used by purgeDeactivatedAccounts job
 */
async function permanentlyDeleteUser(user: Parse.User): Promise<void> {
	console.log(`[DeleteAccount] Permanently deleting user: ${user.id}`);

	// Delete all user's concerts and their photos
	const concertQuery = new Parse.Query("Concert");
	concertQuery.equalTo("user", user);
	concertQuery.limit(1000);
	const concerts = await concertQuery.find({ useMasterKey: true });

	for (const concert of concerts) {
		const photoQuery = new Parse.Query("ConcertPhoto");
		photoQuery.equalTo("concert", concert);
		const photos = await photoQuery.find({ useMasterKey: true });
		await Parse.Object.destroyAll(photos, { useMasterKey: true });
	}
	await Parse.Object.destroyAll(concerts, { useMasterKey: true });

	// Delete notification preferences
	const prefsQuery = new Parse.Query("NotificationPreference");
	prefsQuery.equalTo("user", user);
	const prefs = await prefsQuery.first({ useMasterKey: true });
	if (prefs) {
		await prefs.destroy({ useMasterKey: true });
	}

	// Delete follows (where user is follower or following)
	const followerQuery = new Parse.Query("Follow");
	followerQuery.equalTo("follower", user);
	followerQuery.limit(1000);
	const followingQuery = new Parse.Query("Follow");
	followingQuery.equalTo("following", user);
	followingQuery.limit(1000);
	const [followerFollows, followingFollows] = await Promise.all([
		followerQuery.find({ useMasterKey: true }),
		followingQuery.find({ useMasterKey: true }),
	]);
	const allFollows = [...followerFollows, ...followingFollows];
	if (allFollows.length > 0) {
		await Parse.Object.destroyAll(allFollows, { useMasterKey: true });
	}

	// Delete connection keys
	const granterKeyQuery = new Parse.Query("ConnectionKey");
	granterKeyQuery.equalTo("granter", user);
	granterKeyQuery.limit(1000);
	const granteeKeyQuery = new Parse.Query("ConnectionKey");
	granteeKeyQuery.equalTo("grantee", user);
	granteeKeyQuery.limit(1000);
	const [granterKeys, granteeKeys] = await Promise.all([
		granterKeyQuery.find({ useMasterKey: true }),
		granteeKeyQuery.find({ useMasterKey: true }),
	]);
	const allKeys = [...granterKeys, ...granteeKeys];
	if (allKeys.length > 0) {
		await Parse.Object.destroyAll(allKeys, { useMasterKey: true });
	}

	// Delete likes by user
	const likesQuery = new Parse.Query("Like");
	likesQuery.equalTo("user", user);
	likesQuery.limit(1000);
	const likes = await likesQuery.find({ useMasterKey: true });
	if (likes.length > 0) {
		await Parse.Object.destroyAll(likes, { useMasterKey: true });
	}

	// Soft delete comments (preserve thread structure)
	const commentsQuery = new Parse.Query("Comment");
	commentsQuery.equalTo("user", user);
	commentsQuery.limit(1000);
	const comments = await commentsQuery.find({ useMasterKey: true });
	for (const comment of comments) {
		comment.set("is_deleted", true);
		comment.set("text", "[deleted]");
	}
	if (comments.length > 0) {
		await Parse.Object.saveAll(comments, { useMasterKey: true });
	}

	// Delete activities
	const actorQuery = new Parse.Query("Activity");
	actorQuery.equalTo("actor", user);
	actorQuery.limit(1000);
	const recipientQuery = new Parse.Query("Activity");
	recipientQuery.equalTo("recipient", user);
	recipientQuery.limit(1000);
	const [actorActivities, recipientActivities] = await Promise.all([
		actorQuery.find({ useMasterKey: true }),
		recipientQuery.find({ useMasterKey: true }),
	]);
	const allActivities = [...actorActivities, ...recipientActivities];
	if (allActivities.length > 0) {
		await Parse.Object.destroyAll(allActivities, { useMasterKey: true });
	}

	// Delete all sessions for this user
	const sessionQuery = new Parse.Query("_Session");
	sessionQuery.equalTo("user", user);
	sessionQuery.limit(1000);
	const sessions = await sessionQuery.find({ useMasterKey: true });
	if (sessions.length > 0) {
		await Parse.Object.destroyAll(sessions, { useMasterKey: true });
	}

	// Finally, delete the user
	await user.destroy({ useMasterKey: true });

	console.log(`[DeleteAccount] User ${user.id} permanently deleted`);
}

/**
 * Request account deletion (soft delete with 30-day grace period)
 * Sets deactivated_at and invalidates all sessions
 */
Parse.Cloud.define(
	"requestAccountDeletion",
	async (
		request: Parse.Cloud.FunctionRequest,
	): Promise<{ success: boolean; deletionDate: string }> => {
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		// Check if already deactivated
		if (user.get("deactivated_at")) {
			const deletionDate = new Date(user.get("deactivated_at"));
			deletionDate.setDate(deletionDate.getDate() + DELETION_GRACE_PERIOD_DAYS);
			return {
				success: true,
				deletionDate: deletionDate.toISOString(),
			};
		}

		// Set deactivation date
		const now = new Date();
		user.set("deactivated_at", now);
		await user.save(null, { useMasterKey: true });

		// Invalidate all sessions for this user (log them out everywhere)
		const sessionQuery = new Parse.Query("_Session");
		sessionQuery.equalTo("user", user);
		sessionQuery.limit(1000);
		const sessions = await sessionQuery.find({ useMasterKey: true });
		if (sessions.length > 0) {
			await Parse.Object.destroyAll(sessions, { useMasterKey: true });
		}

		// Calculate deletion date
		const deletionDate = new Date(now);
		deletionDate.setDate(deletionDate.getDate() + DELETION_GRACE_PERIOD_DAYS);

		console.log(
			`[DeleteAccount] User ${user.id} requested deletion, scheduled for ${deletionDate.toISOString()}`,
		);

		return {
			success: true,
			deletionDate: deletionDate.toISOString(),
		};
	},
);

/**
 * Cancel account deletion (restore account within grace period)
 */
Parse.Cloud.define(
	"cancelAccountDeletion",
	async (
		request: Parse.Cloud.FunctionRequest,
	): Promise<{ success: boolean }> => {
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		const deactivatedAt = user.get("deactivated_at");
		if (!deactivatedAt) {
			throw new Parse.Error(
				Parse.Error.OBJECT_NOT_FOUND,
				"Account is not scheduled for deletion",
			);
		}

		// Check if still within grace period
		const deletionDate = new Date(deactivatedAt);
		deletionDate.setDate(deletionDate.getDate() + DELETION_GRACE_PERIOD_DAYS);

		if (new Date() > deletionDate) {
			throw new Parse.Error(
				Parse.Error.OBJECT_NOT_FOUND,
				"Grace period has expired. Account cannot be restored.",
			);
		}

		// Clear deactivation
		user.unset("deactivated_at");
		await user.save(null, { useMasterKey: true });

		console.log(`[DeleteAccount] User ${user.id} cancelled deletion request`);

		return { success: true };
	},
);

/**
 * Get account deletion status
 */
Parse.Cloud.define(
	"getAccountDeletionStatus",
	async (
		request: Parse.Cloud.FunctionRequest,
	): Promise<{
		scheduled: boolean;
		deletionDate?: string;
		daysRemaining?: number;
	}> => {
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		const deactivatedAt = user.get("deactivated_at");
		if (!deactivatedAt) {
			return { scheduled: false };
		}

		const deletionDate = new Date(deactivatedAt);
		deletionDate.setDate(deletionDate.getDate() + DELETION_GRACE_PERIOD_DAYS);

		const now = new Date();
		const daysRemaining = Math.max(
			0,
			Math.ceil(
				(deletionDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
			),
		);

		return {
			scheduled: true,
			deletionDate: deletionDate.toISOString(),
			daysRemaining,
		};
	},
);

/**
 * Background job to permanently delete accounts past grace period
 * Should be run daily via cron/scheduler
 */
Parse.Cloud.job("purgeDeactivatedAccounts", async (request) => {
	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - DELETION_GRACE_PERIOD_DAYS);

	// Find users scheduled for deletion past the grace period
	const query = new Parse.Query(Parse.User);
	query.lessThan("deactivated_at", cutoffDate);
	query.limit(100); // Process in batches

	const usersToDelete = await query.find({ useMasterKey: true });

	console.log(
		`[PurgeJob] Found ${usersToDelete.length} accounts to permanently delete`,
	);

	let deleted = 0;
	let failed = 0;

	for (const user of usersToDelete) {
		try {
			await permanentlyDeleteUser(user as Parse.User);
			deleted++;
		} catch (error) {
			console.error(`[PurgeJob] Failed to delete user ${user.id}:`, error);
			failed++;
		}
	}

	const message = `Purged ${deleted} accounts, ${failed} failed`;
	console.log(`[PurgeJob] ${message}`);

	request.message(message);
	return message;
});

/**
 * After user save - ensure total_gigs is never negative
 */
Parse.Cloud.afterSave("_User", async (request) => {
	const user = request.object;
	const totalGigs = user.get("total_gigs");

	if (totalGigs !== undefined && totalGigs < 0) {
		user.set("total_gigs", 0);
		await user.save(null, { useMasterKey: true });
	}
});

/**
 * Before user signup - set default values
 */
Parse.Cloud.beforeSave("_User", async (request) => {
	const user = request.object;

	// Set defaults for new users
	if (!user.existed()) {
		if (!user.get("subscription_status")) {
			user.set("subscription_status", "free");
		}
		if (!user.get("total_gigs")) {
			user.set("total_gigs", 0);
		}
		if (!user.get("profile_visibility")) {
			user.set("profile_visibility", "public");
		}
	}
});
