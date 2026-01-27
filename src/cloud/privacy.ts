/**
 * Privacy & Connection Keys Cloud Functions
 * Handles profile visibility settings and connection key management
 */

import type { ProfileVisibility, UserSummary } from "../lib/db.types";

// ==================== Helper Functions ====================

/**
 * Get user summary for responses
 */
function getUserSummary(user: Parse.User): UserSummary {
	return {
		id: user.id,
		username: user.get("username"),
		full_name: user.get("full_name"),
		profile_picture_url: user.get("profile_picture_url"),
	};
}

/**
 * Check if two users have a mutual connection (both follow each other)
 */
export async function checkMutualConnection(
	userAId: string,
	userBId: string,
): Promise<boolean> {
	const userA = Parse.User.createWithoutData(userAId);
	const userB = Parse.User.createWithoutData(userBId);

	// Check both directions in parallel
	const queryAFollowsB = new Parse.Query("Follow");
	queryAFollowsB.equalTo("follower", userA);
	queryAFollowsB.equalTo("following", userB);

	const queryBFollowsA = new Parse.Query("Follow");
	queryBFollowsA.equalTo("follower", userB);
	queryBFollowsA.equalTo("following", userA);

	const [aFollowsB, bFollowsA] = await Promise.all([
		queryAFollowsB.first({ useMasterKey: true }),
		queryBFollowsA.first({ useMasterKey: true }),
	]);

	return !!(aFollowsB && bFollowsA);
}

/**
 * Check if viewer is following target
 */
export async function checkIsFollower(
	viewerId: string,
	targetId: string,
): Promise<boolean> {
	const viewer = Parse.User.createWithoutData(viewerId);
	const target = Parse.User.createWithoutData(targetId);

	const query = new Parse.Query("Follow");
	query.equalTo("follower", viewer);
	query.equalTo("following", target);

	const follow = await query.first({ useMasterKey: true });
	return !!follow;
}

/**
 * Check if viewer has an active connection key from target
 */
export async function checkHasActiveKey(
	viewerId: string,
	targetId: string,
): Promise<boolean> {
	const viewer = Parse.User.createWithoutData(viewerId);
	const target = Parse.User.createWithoutData(targetId);

	const query = new Parse.Query("ConnectionKey");
	query.equalTo("granter", target);
	query.equalTo("grantee", viewer);
	query.equalTo("is_active", true);

	const key = await query.first({ useMasterKey: true });
	return !!key;
}

/**
 * Revoke keys between two users in both directions (soft delete)
 */
export async function revokeKeysBetweenUsers(
	userAId: string,
	userBId: string,
): Promise<void> {
	const userA = Parse.User.createWithoutData(userAId);
	const userB = Parse.User.createWithoutData(userBId);

	// Find keys in both directions
	const queryAtoB = new Parse.Query("ConnectionKey");
	queryAtoB.equalTo("granter", userA);
	queryAtoB.equalTo("grantee", userB);
	queryAtoB.equalTo("is_active", true);

	const queryBtoA = new Parse.Query("ConnectionKey");
	queryBtoA.equalTo("granter", userB);
	queryBtoA.equalTo("grantee", userA);
	queryBtoA.equalTo("is_active", true);

	const [keyAtoB, keyBtoA] = await Promise.all([
		queryAtoB.first({ useMasterKey: true }),
		queryBtoA.first({ useMasterKey: true }),
	]);

	const keysToRevoke: Parse.Object[] = [];
	if (keyAtoB) keysToRevoke.push(keyAtoB);
	if (keyBtoA) keysToRevoke.push(keyBtoA);

	for (const key of keysToRevoke) {
		key.set("is_active", false);
	}

	if (keysToRevoke.length > 0) {
		await Parse.Object.saveAll(keysToRevoke, { useMasterKey: true });
	}
}

// ==================== Key Management Cloud Functions ====================

interface GrantKeyParams {
	user_id: string;
}

/**
 * Grant a connection key to a mutual connection
 */
Parse.Cloud.define(
	"grantConnectionKey",
	async (request: Parse.Cloud.FunctionRequest<GrantKeyParams>) => {
		const { user_id } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!user_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "User ID required");
		}

		if (user_id === user.id) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Cannot grant key to yourself",
			);
		}

		// Check if target user exists
		const targetQuery = new Parse.Query<Parse.User>("_User");
		const targetUser = await targetQuery.get(user_id, { useMasterKey: true });

		// Check for mutual connection
		const isMutual = await checkMutualConnection(user.id, user_id);
		if (!isMutual) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"Can only grant keys to mutual connections",
			);
		}

		// Check if key already exists
		const existingQuery = new Parse.Query("ConnectionKey");
		existingQuery.equalTo("granter", user);
		existingQuery.equalTo("grantee", targetUser);
		const existingKey = await existingQuery.first({ useMasterKey: true });

		if (existingKey) {
			if (existingKey.get("is_active")) {
				throw new Parse.Error(
					Parse.Error.DUPLICATE_VALUE,
					"Key already granted to this user",
				);
			}
			// Reactivate previously revoked key
			existingKey.set("is_active", true);
			existingKey.set("granted_at", new Date());
			await existingKey.save(null, { useMasterKey: true });

			return {
				id: existingKey.id,
				grantee: getUserSummary(targetUser),
				granted_at: existingKey.get("granted_at").toISOString(),
				is_active: true,
			};
		}

		// Create new key
		const ConnectionKey = Parse.Object.extend("ConnectionKey");
		const key = new ConnectionKey();
		key.set("granter", user);
		key.set("grantee", targetUser);
		key.set("granted_at", new Date());
		key.set("is_active", true);

		// Set ACL - only granter can modify
		const acl = new Parse.ACL(user);
		acl.setReadAccess(user_id, true);
		key.setACL(acl);

		await key.save(null, { useMasterKey: true });

		return {
			id: key.id,
			grantee: getUserSummary(targetUser),
			granted_at: key.get("granted_at").toISOString(),
			is_active: true,
		};
	},
);

/**
 * Revoke a connection key (soft delete)
 */
Parse.Cloud.define(
	"revokeConnectionKey",
	async (request: Parse.Cloud.FunctionRequest<GrantKeyParams>) => {
		const { user_id } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!user_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "User ID required");
		}

		const targetUser = Parse.User.createWithoutData(user_id);

		const query = new Parse.Query("ConnectionKey");
		query.equalTo("granter", user);
		query.equalTo("grantee", targetUser);
		query.equalTo("is_active", true);

		const key = await query.first({ useMasterKey: true });

		if (!key) {
			throw new Parse.Error(
				Parse.Error.OBJECT_NOT_FOUND,
				"No active key found for this user",
			);
		}

		key.set("is_active", false);
		await key.save(null, { useMasterKey: true });

		return { success: true };
	},
);

/**
 * Check if you have a connection key from another user
 */
Parse.Cloud.define(
	"hasConnectionKey",
	async (request: Parse.Cloud.FunctionRequest<{ user_id: string }>) => {
		const { user_id } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!user_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "User ID required");
		}

		const hasKey = await checkHasActiveKey(user.id, user_id);

		return { has_key: hasKey };
	},
);

interface GetKeysParams {
	limit?: number;
	skip?: number;
}

/**
 * Get users who hold your connection keys (people who can see your upcoming)
 */
Parse.Cloud.define(
	"getKeyHolders",
	async (request: Parse.Cloud.FunctionRequest<GetKeysParams>) => {
		const { limit = 50, skip = 0 } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		const query = new Parse.Query("ConnectionKey");
		query.equalTo("granter", user);
		query.equalTo("is_active", true);
		query.include("grantee");
		query.descending("granted_at");
		query.limit(Math.min(limit, 100));
		query.skip(skip);

		const [results, total] = await Promise.all([
			query.find({ useMasterKey: true }),
			query.count({ useMasterKey: true }),
		]);

		return {
			results: results.map((key) => ({
				id: key.id,
				user: getUserSummary(key.get("grantee")),
				granted_at: key.get("granted_at").toISOString(),
				is_active: key.get("is_active"),
			})),
			count: results.length,
			total,
		};
	},
);

/**
 * Get connection keys you hold (users whose upcoming you can see)
 */
Parse.Cloud.define(
	"getKeysHeld",
	async (request: Parse.Cloud.FunctionRequest<GetKeysParams>) => {
		const { limit = 50, skip = 0 } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		const query = new Parse.Query("ConnectionKey");
		query.equalTo("grantee", user);
		query.equalTo("is_active", true);
		query.include("granter");
		query.descending("granted_at");
		query.limit(Math.min(limit, 100));
		query.skip(skip);

		const [results, total] = await Promise.all([
			query.find({ useMasterKey: true }),
			query.count({ useMasterKey: true }),
		]);

		return {
			results: results.map((key) => ({
				id: key.id,
				user: getUserSummary(key.get("granter")),
				granted_at: key.get("granted_at").toISOString(),
				is_active: key.get("is_active"),
			})),
			count: results.length,
			total,
		};
	},
);

/**
 * Get mutual connections (users eligible for key granting)
 */
Parse.Cloud.define(
	"getMutualConnections",
	async (request: Parse.Cloud.FunctionRequest<GetKeysParams>) => {
		const { limit = 50, skip = 0 } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		// Get users I'm following
		const followingQuery = new Parse.Query("Follow");
		followingQuery.equalTo("follower", user);
		followingQuery.limit(1000);
		const following = await followingQuery.find({ useMasterKey: true });

		const followingIds = following.map((f) => f.get("following").id);

		if (followingIds.length === 0) {
			return { results: [], count: 0, total: 0 };
		}

		// Find who follows me back from those I follow
		const followersQuery = new Parse.Query("Follow");
		followersQuery.equalTo("following", user);
		followersQuery.containedIn(
			"follower",
			followingIds.map((id) => Parse.User.createWithoutData(id)),
		);
		followersQuery.include("follower");
		followersQuery.descending("createdAt");

		const [mutualFollows, total] = await Promise.all([
			followersQuery.limit(1000).find({ useMasterKey: true }),
			followersQuery.count({ useMasterKey: true }),
		]);

		// Apply pagination
		const paginatedFollows = mutualFollows.slice(skip, skip + limit);

		// Check which mutual connections already have keys
		const mutualUserIds = paginatedFollows.map((f) => f.get("follower").id);
		const existingKeysQuery = new Parse.Query("ConnectionKey");
		existingKeysQuery.equalTo("granter", user);
		existingKeysQuery.equalTo("is_active", true);
		existingKeysQuery.containedIn(
			"grantee",
			mutualUserIds.map((id) => Parse.User.createWithoutData(id)),
		);
		const existingKeys = await existingKeysQuery.find({ useMasterKey: true });
		const keyHolderIds = new Set(existingKeys.map((k) => k.get("grantee").id));

		return {
			results: paginatedFollows.map((follow) => {
				const mutualUser = follow.get("follower");
				return {
					user: getUserSummary(mutualUser),
					has_key: keyHolderIds.has(mutualUser.id),
				};
			}),
			count: paginatedFollows.length,
			total,
		};
	},
);

// ==================== Profile Visibility Cloud Functions ====================

interface UpdateVisibilityParams {
	visibility: ProfileVisibility;
}

/**
 * Update profile visibility setting
 */
Parse.Cloud.define(
	"updateProfileVisibility",
	async (request: Parse.Cloud.FunctionRequest<UpdateVisibilityParams>) => {
		const { visibility } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!visibility || !["public", "private"].includes(visibility)) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Visibility must be 'public' or 'private'",
			);
		}

		user.set("profile_visibility", visibility);
		await user.save(null, { useMasterKey: true });

		return {
			profile_visibility: visibility,
		};
	},
);

/**
 * Get current profile visibility setting
 */
Parse.Cloud.define(
	"getProfileVisibility",
	async (request: Parse.Cloud.FunctionRequest) => {
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		return {
			profile_visibility:
				(user.get("profile_visibility") as ProfileVisibility) || "public",
		};
	},
);

console.log("Privacy cloud functions loaded");
