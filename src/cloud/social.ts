/**
 * Social Features Cloud Functions
 * Handles follows, likes, comments, and activity feed
 */

import type {
	ActivityType,
	LikeTargetType,
	UserSummary,
} from "../lib/db.types";
import { checkIsFollower, revokeKeysBetweenUsers } from "./privacy";

// ==================== Helper Functions ====================

/**
 * Get user summary for activity feed
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
 * Check if user has notification preference enabled
 */
async function isNotificationEnabled(
	userId: string,
	prefType: "likes_enabled" | "comments_enabled" | "followers_enabled",
): Promise<boolean> {
	const query = new Parse.Query("NotificationPreference");
	const userPointer = Parse.User.createWithoutData(userId);
	query.equalTo("user", userPointer);
	const prefs = await query.first({ useMasterKey: true });

	// Default to true if no preferences exist
	if (!prefs) return true;
	return prefs.get(prefType) !== false;
}

/**
 * Create an activity record for a user's feed
 */
async function createActivity(params: {
	recipientId: string;
	actor: Parse.User;
	type: ActivityType;
	concert?: Parse.Object;
	photo?: Parse.Object;
	comment?: Parse.Object;
	previewText?: string;
}): Promise<void> {
	const { recipientId, actor, type, concert, photo, comment, previewText } =
		params;

	// Don't create activity for self-actions
	if (recipientId === actor.id) return;

	// Check notification preferences
	let prefKey: "likes_enabled" | "comments_enabled" | "followers_enabled";
	switch (type) {
		case "follow":
			prefKey = "followers_enabled";
			break;
		case "like":
			prefKey = "likes_enabled";
			break;
		case "comment":
		case "concert":
			prefKey = "comments_enabled";
			break;
		default:
			return;
	}

	const enabled = await isNotificationEnabled(recipientId, prefKey);
	if (!enabled) return;

	const Activity = Parse.Object.extend("Activity");
	const activity = new Activity();

	const recipient = Parse.User.createWithoutData(recipientId);
	activity.set("recipient", recipient);
	activity.set("actor", actor);
	activity.set("type", type);
	activity.set("is_read", false);

	if (concert) activity.set("concert", concert);
	if (photo) activity.set("photo", photo);
	if (comment) activity.set("comment", comment);
	if (previewText) activity.set("preview_text", previewText);

	// Set ACL - recipient can read
	const acl = new Parse.ACL();
	acl.setReadAccess(recipientId, true);
	activity.setACL(acl);

	await activity.save(null, { useMasterKey: true });
}

/**
 * Fan out activity to all followers (for new concerts)
 */
async function fanOutToFollowers(
	actor: Parse.User,
	type: ActivityType,
	concert: Parse.Object,
	previewText: string,
): Promise<void> {
	const query = new Parse.Query("Follow");
	query.equalTo("following", actor);
	query.limit(1000); // Reasonable limit for fan-out

	const follows = await query.find({ useMasterKey: true });

	const createPromises = follows.map((follow) => {
		const follower = follow.get("follower");
		return createActivity({
			recipientId: follower.id,
			actor,
			type,
			concert,
			previewText,
		});
	});

	await Promise.all(createPromises);
}

// ==================== Follow Functions ====================

interface FollowUserParams {
	user_id: string;
}

/**
 * Follow a user
 */
Parse.Cloud.define(
	"followUser",
	async (request: Parse.Cloud.FunctionRequest<FollowUserParams>) => {
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
				"Cannot follow yourself",
			);
		}

		// Check if target user exists
		const targetQuery = new Parse.Query<Parse.User>("_User");
		const targetUser = await targetQuery.get(user_id, { useMasterKey: true });

		// Check for existing follow
		const existingQuery = new Parse.Query("Follow");
		existingQuery.equalTo("follower", user);
		existingQuery.equalTo("following", targetUser);
		const existing = await existingQuery.first({ useMasterKey: true });

		if (existing) {
			throw new Parse.Error(
				Parse.Error.DUPLICATE_VALUE,
				"Already following this user",
			);
		}

		// Create follow relationship
		const Follow = Parse.Object.extend("Follow");
		const follow = new Follow();
		follow.set("follower", user);
		follow.set("following", targetUser);

		// Set ACL - only the follower can delete
		const acl = new Parse.ACL(user);
		acl.setPublicReadAccess(true);
		follow.setACL(acl);

		await follow.save(null, { useMasterKey: true });

		// Update counts
		user.increment("following_count");
		targetUser.increment("follower_count");
		await Promise.all([
			user.save(null, { useMasterKey: true }),
			targetUser.save(null, { useMasterKey: true }),
		]);

		// Create activity for the followed user
		await createActivity({
			recipientId: targetUser.id,
			actor: user,
			type: "follow",
			previewText: `${user.get("username") || "Someone"} started following you`,
		});

		return {
			success: true,
			following: getUserSummary(targetUser),
		};
	},
);

/**
 * Unfollow a user
 * Also revokes connection keys in both directions (keys require mutual connection)
 */
Parse.Cloud.define(
	"unfollowUser",
	async (request: Parse.Cloud.FunctionRequest<FollowUserParams>) => {
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

		// Find the follow relationship
		const targetUser = Parse.User.createWithoutData(user_id);
		const query = new Parse.Query("Follow");
		query.equalTo("follower", user);
		query.equalTo("following", targetUser);
		const follow = await query.first({ useMasterKey: true });

		if (!follow) {
			throw new Parse.Error(
				Parse.Error.OBJECT_NOT_FOUND,
				"Not following this user",
			);
		}

		await follow.destroy({ useMasterKey: true });

		// Update counts
		user.increment("following_count", -1);
		const freshTargetQuery = new Parse.Query<Parse.User>("_User");
		const freshTarget = await freshTargetQuery.get(user_id, {
			useMasterKey: true,
		});
		freshTarget.increment("follower_count", -1);

		await Promise.all([
			user.save(null, { useMasterKey: true }),
			freshTarget.save(null, { useMasterKey: true }),
		]);

		// Revoke connection keys in both directions since mutual connection is broken
		await revokeKeysBetweenUsers(user.id, user_id);

		return { success: true };
	},
);

/**
 * Check if current user follows another user
 */
Parse.Cloud.define(
	"isFollowing",
	async (request: Parse.Cloud.FunctionRequest<FollowUserParams>) => {
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
		const query = new Parse.Query("Follow");
		query.equalTo("follower", user);
		query.equalTo("following", targetUser);
		const follow = await query.first({ useMasterKey: true });

		return { is_following: !!follow };
	},
);

interface GetFollowsParams {
	user_id?: string;
	limit?: number;
	skip?: number;
}

/**
 * Get a user's followers
 */
Parse.Cloud.define(
	"getFollowers",
	async (request: Parse.Cloud.FunctionRequest<GetFollowsParams>) => {
		const { user_id, limit = 50, skip = 0 } = request.params;
		const currentUser = request.user;

		let targetUser: Parse.User;
		if (user_id) {
			targetUser = Parse.User.createWithoutData(user_id) as Parse.User;
		} else if (currentUser) {
			targetUser = currentUser;
		} else {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"User ID required or must be authenticated",
			);
		}

		const query = new Parse.Query("Follow");
		query.equalTo("following", targetUser);
		query.include("follower");
		query.descending("createdAt");
		query.limit(Math.min(limit, 100));
		query.skip(skip);

		const [results, total] = await Promise.all([
			query.find({ useMasterKey: true }),
			query.count({ useMasterKey: true }),
		]);

		return {
			results: results.map((follow) => {
				const follower = follow.get("follower");
				return {
					id: follow.id,
					user: getUserSummary(follower),
					createdAt: follow.createdAt?.toISOString(),
				};
			}),
			count: results.length,
			total,
		};
	},
);

/**
 * Get users that a user is following
 */
Parse.Cloud.define(
	"getFollowing",
	async (request: Parse.Cloud.FunctionRequest<GetFollowsParams>) => {
		const { user_id, limit = 50, skip = 0 } = request.params;
		const currentUser = request.user;

		let targetUser: Parse.User;
		if (user_id) {
			targetUser = Parse.User.createWithoutData(user_id) as Parse.User;
		} else if (currentUser) {
			targetUser = currentUser;
		} else {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"User ID required or must be authenticated",
			);
		}

		const query = new Parse.Query("Follow");
		query.equalTo("follower", targetUser);
		query.include("following");
		query.descending("createdAt");
		query.limit(Math.min(limit, 100));
		query.skip(skip);

		const [results, total] = await Promise.all([
			query.find({ useMasterKey: true }),
			query.count({ useMasterKey: true }),
		]);

		return {
			results: results.map((follow) => {
				const following = follow.get("following");
				return {
					id: follow.id,
					user: getUserSummary(following),
					createdAt: follow.createdAt?.toISOString(),
				};
			}),
			count: results.length,
			total,
		};
	},
);

// ==================== Like Functions ====================

interface LikeConcertParams {
	concert_id: string;
}

/**
 * Like a concert
 */
Parse.Cloud.define(
	"likeConcert",
	async (request: Parse.Cloud.FunctionRequest<LikeConcertParams>) => {
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

		// Get concert with includes for activity creation
		const concertQuery = new Parse.Query("Concert");
		concertQuery.include("artist");
		concertQuery.include("venue");
		concertQuery.include("user");
		const concert = await concertQuery.get(concert_id);

		// Check for existing like
		const existingQuery = new Parse.Query("Like");
		existingQuery.equalTo("user", user);
		existingQuery.equalTo("target_type", "concert");
		existingQuery.equalTo("target_id", concert_id);
		const existing = await existingQuery.first({ useMasterKey: true });

		if (existing) {
			throw new Parse.Error(
				Parse.Error.DUPLICATE_VALUE,
				"Already liked this concert",
			);
		}

		// Create like
		const Like = Parse.Object.extend("Like");
		const like = new Like();
		like.set("user", user);
		like.set("concert", concert);
		like.set("target_type", "concert" as LikeTargetType);
		like.set("target_id", concert_id);

		// Set ACL
		const acl = new Parse.ACL(user);
		acl.setPublicReadAccess(true);
		like.setACL(acl);

		await like.save(null, { useMasterKey: true });

		// Update like count
		concert.increment("like_count");
		await concert.save(null, { useMasterKey: true });

		// Create activity for concert owner
		const concertOwner = concert.get("user");
		const artist = concert.get("artist");
		const venue = concert.get("venue");

		await createActivity({
			recipientId: concertOwner.id,
			actor: user,
			type: "like",
			concert,
			previewText: `${user.get("username") || "Someone"} liked your concert at ${venue?.get("name") || "a venue"}`,
		});

		return {
			success: true,
			like_count: concert.get("like_count"),
		};
	},
);

/**
 * Unlike a concert
 */
Parse.Cloud.define(
	"unlikeConcert",
	async (request: Parse.Cloud.FunctionRequest<LikeConcertParams>) => {
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

		// Find the like
		const query = new Parse.Query("Like");
		query.equalTo("user", user);
		query.equalTo("target_type", "concert");
		query.equalTo("target_id", concert_id);
		const like = await query.first({ useMasterKey: true });

		if (!like) {
			throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, "Like not found");
		}

		await like.destroy({ useMasterKey: true });

		// Update like count
		const concertQuery = new Parse.Query("Concert");
		const concert = await concertQuery.get(concert_id);
		concert.increment("like_count", -1);
		await concert.save(null, { useMasterKey: true });

		return {
			success: true,
			like_count: Math.max(0, concert.get("like_count")),
		};
	},
);

interface LikePhotoParams {
	photo_id: string;
}

/**
 * Like a photo
 */
Parse.Cloud.define(
	"likePhoto",
	async (request: Parse.Cloud.FunctionRequest<LikePhotoParams>) => {
		const { photo_id } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!photo_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Photo ID required");
		}

		// Get photo
		const photoQuery = new Parse.Query("ConcertPhoto");
		photoQuery.include("user");
		photoQuery.include("concert");
		const photo = await photoQuery.get(photo_id);

		// Check for existing like
		const existingQuery = new Parse.Query("Like");
		existingQuery.equalTo("user", user);
		existingQuery.equalTo("target_type", "photo");
		existingQuery.equalTo("target_id", photo_id);
		const existing = await existingQuery.first({ useMasterKey: true });

		if (existing) {
			throw new Parse.Error(
				Parse.Error.DUPLICATE_VALUE,
				"Already liked this photo",
			);
		}

		// Create like
		const Like = Parse.Object.extend("Like");
		const like = new Like();
		like.set("user", user);
		like.set("photo", photo);
		like.set("target_type", "photo" as LikeTargetType);
		like.set("target_id", photo_id);

		const acl = new Parse.ACL(user);
		acl.setPublicReadAccess(true);
		like.setACL(acl);

		await like.save(null, { useMasterKey: true });

		// Update like count
		photo.increment("like_count");
		await photo.save(null, { useMasterKey: true });

		// Create activity for photo owner
		const photoOwner = photo.get("user");
		await createActivity({
			recipientId: photoOwner.id,
			actor: user,
			type: "like",
			photo,
			previewText: `${user.get("username") || "Someone"} liked your photo`,
		});

		return {
			success: true,
			like_count: photo.get("like_count"),
		};
	},
);

/**
 * Unlike a photo
 */
Parse.Cloud.define(
	"unlikePhoto",
	async (request: Parse.Cloud.FunctionRequest<LikePhotoParams>) => {
		const { photo_id } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!photo_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Photo ID required");
		}

		// Find the like
		const query = new Parse.Query("Like");
		query.equalTo("user", user);
		query.equalTo("target_type", "photo");
		query.equalTo("target_id", photo_id);
		const like = await query.first({ useMasterKey: true });

		if (!like) {
			throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, "Like not found");
		}

		await like.destroy({ useMasterKey: true });

		// Update like count
		const photoQuery = new Parse.Query("ConcertPhoto");
		const photo = await photoQuery.get(photo_id);
		photo.increment("like_count", -1);
		await photo.save(null, { useMasterKey: true });

		return {
			success: true,
			like_count: Math.max(0, photo.get("like_count")),
		};
	},
);

/**
 * Check if user has liked a concert
 */
Parse.Cloud.define(
	"hasLikedConcert",
	async (request: Parse.Cloud.FunctionRequest<LikeConcertParams>) => {
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

		const query = new Parse.Query("Like");
		query.equalTo("user", user);
		query.equalTo("target_type", "concert");
		query.equalTo("target_id", concert_id);
		const like = await query.first({ useMasterKey: true });

		return { has_liked: !!like };
	},
);

interface GetConcertLikesParams {
	concert_id: string;
	limit?: number;
	skip?: number;
}

/**
 * Get users who liked a concert
 */
Parse.Cloud.define(
	"getConcertLikes",
	async (request: Parse.Cloud.FunctionRequest<GetConcertLikesParams>) => {
		const { concert_id, limit = 50, skip = 0 } = request.params;

		if (!concert_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Concert ID required");
		}

		const query = new Parse.Query("Like");
		query.equalTo("target_type", "concert");
		query.equalTo("target_id", concert_id);
		query.include("user");
		query.descending("createdAt");
		query.limit(Math.min(limit, 100));
		query.skip(skip);

		const [results, total] = await Promise.all([
			query.find({ useMasterKey: true }),
			query.count({ useMasterKey: true }),
		]);

		return {
			results: results.map((like) => {
				const likeUser = like.get("user");
				return {
					id: like.id,
					user: getUserSummary(likeUser),
					createdAt: like.createdAt?.toISOString(),
				};
			}),
			count: results.length,
			total,
		};
	},
);

// ==================== Comment Functions ====================

interface AddCommentParams {
	concert_id: string;
	text: string;
	parent_id?: string;
}

/**
 * Add a comment to a concert
 */
Parse.Cloud.define(
	"addComment",
	async (request: Parse.Cloud.FunctionRequest<AddCommentParams>) => {
		const { concert_id, text, parent_id } = request.params;
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

		if (!text?.trim()) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Comment text required");
		}

		// Validate text length
		const trimmedText = text.trim();
		if (trimmedText.length > 2000) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Comment too long (max 2000 characters)",
			);
		}

		// Get concert
		const concertQuery = new Parse.Query("Concert");
		concertQuery.include("artist");
		concertQuery.include("venue");
		concertQuery.include("user");
		const concert = await concertQuery.get(concert_id);

		// Validate parent comment if provided
		let parentComment: Parse.Object | undefined;
		if (parent_id) {
			const parentQuery = new Parse.Query("Comment");
			parentComment = await parentQuery.get(parent_id);
			if (parentComment.get("concert").id !== concert_id) {
				throw new Parse.Error(
					Parse.Error.INVALID_VALUE,
					"Parent comment not on this concert",
				);
			}
		}

		// Create comment
		const Comment = Parse.Object.extend("Comment");
		const comment = new Comment();
		comment.set("user", user);
		comment.set("concert", concert);
		comment.set("text", trimmedText);
		comment.set("reply_count", 0);
		comment.set("is_deleted", false);

		if (parentComment) {
			comment.set("parent", parentComment);
		}

		// Set ACL - owner can modify, public can read
		const acl = new Parse.ACL(user);
		acl.setPublicReadAccess(true);
		comment.setACL(acl);

		await comment.save(null, { useMasterKey: true });

		// Update parent reply count if this is a reply
		if (parentComment) {
			parentComment.increment("reply_count");
			await parentComment.save(null, { useMasterKey: true });
		}

		// Update concert comment count
		concert.increment("comment_count");
		await concert.save(null, { useMasterKey: true });

		// Create activity for concert owner
		const concertOwner = concert.get("user");
		const previewText =
			trimmedText.length > 50
				? `${trimmedText.substring(0, 50)}...`
				: trimmedText;

		await createActivity({
			recipientId: concertOwner.id,
			actor: user,
			type: "comment",
			concert,
			comment,
			previewText: `${user.get("username") || "Someone"} commented: "${previewText}"`,
		});

		return {
			id: comment.id,
			user: getUserSummary(user),
			concert_id,
			text: trimmedText,
			parent_id: parentComment?.id,
			reply_count: 0,
			is_deleted: false,
			createdAt: comment.createdAt?.toISOString(),
			updatedAt: comment.updatedAt?.toISOString(),
		};
	},
);

interface UpdateCommentParams {
	comment_id: string;
	text: string;
}

/**
 * Update own comment
 */
Parse.Cloud.define(
	"updateComment",
	async (request: Parse.Cloud.FunctionRequest<UpdateCommentParams>) => {
		const { comment_id, text } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!comment_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Comment ID required");
		}

		if (!text?.trim()) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Comment text required");
		}

		const trimmedText = text.trim();
		if (trimmedText.length > 2000) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Comment too long (max 2000 characters)",
			);
		}

		const query = new Parse.Query("Comment");
		query.include("user");
		const comment = await query.get(comment_id);

		// Verify ownership
		const commentUser = comment.get("user");
		if (!commentUser || commentUser.id !== user.id) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"Can only edit your own comments",
			);
		}

		// Check if deleted
		if (comment.get("is_deleted")) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"Cannot edit deleted comment",
			);
		}

		comment.set("text", trimmedText);
		await comment.save(null, { useMasterKey: true });

		return {
			id: comment.id,
			user: getUserSummary(user),
			concert_id: comment.get("concert").id,
			text: trimmedText,
			parent_id: comment.get("parent")?.id,
			reply_count: comment.get("reply_count") || 0,
			is_deleted: false,
			createdAt: comment.createdAt?.toISOString(),
			updatedAt: comment.updatedAt?.toISOString(),
		};
	},
);

interface DeleteCommentParams {
	comment_id: string;
}

/**
 * Soft delete a comment
 */
Parse.Cloud.define(
	"deleteComment",
	async (request: Parse.Cloud.FunctionRequest<DeleteCommentParams>) => {
		const { comment_id } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!comment_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Comment ID required");
		}

		const query = new Parse.Query("Comment");
		query.include("user");
		query.include("concert");
		const comment = await query.get(comment_id);

		// Verify ownership
		const commentUser = comment.get("user");
		if (!commentUser || commentUser.id !== user.id) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"Can only delete your own comments",
			);
		}

		// Soft delete
		comment.set("is_deleted", true);
		comment.set("text", "[deleted]");
		await comment.save(null, { useMasterKey: true });

		// Update concert comment count
		const concert = comment.get("concert");
		concert.increment("comment_count", -1);
		await concert.save(null, { useMasterKey: true });

		return { success: true };
	},
);

interface GetCommentsParams {
	concert_id: string;
	limit?: number;
	skip?: number;
}

/**
 * Get comments for a concert
 */
Parse.Cloud.define(
	"getComments",
	async (request: Parse.Cloud.FunctionRequest<GetCommentsParams>) => {
		const { concert_id, limit = 50, skip = 0 } = request.params;

		if (!concert_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Concert ID required");
		}

		const concert =
			Parse.Object.extend("Concert").createWithoutData(concert_id);
		const query = new Parse.Query("Comment");
		query.equalTo("concert", concert);
		query.doesNotExist("parent"); // Only top-level comments
		query.include("user");
		query.descending("createdAt");
		query.limit(Math.min(limit, 100));
		query.skip(skip);

		const [results, total] = await Promise.all([
			query.find({ useMasterKey: true }),
			query.count({ useMasterKey: true }),
		]);

		return {
			results: results.map((comment) => ({
				id: comment.id,
				user: getUserSummary(comment.get("user")),
				concert_id,
				text: comment.get("text"),
				parent_id: comment.get("parent")?.id,
				reply_count: comment.get("reply_count") || 0,
				is_deleted: comment.get("is_deleted") || false,
				createdAt: comment.createdAt?.toISOString(),
				updatedAt: comment.updatedAt?.toISOString(),
			})),
			count: results.length,
			total,
		};
	},
);

// ==================== Activity Feed Functions ====================

interface GetActivityFeedParams {
	limit?: number;
	skip?: number;
	unread_only?: boolean;
}

/**
 * Get user's activity feed
 */
Parse.Cloud.define(
	"getActivityFeed",
	async (request: Parse.Cloud.FunctionRequest<GetActivityFeedParams>) => {
		const { limit = 50, skip = 0, unread_only = false } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		const query = new Parse.Query("Activity");
		query.equalTo("recipient", user);
		query.include("actor");
		query.include("concert");
		query.include("concert.artist");
		query.include("concert.venue");
		query.include("photo");
		query.include("comment");
		query.descending("createdAt");
		query.limit(Math.min(limit, 100));
		query.skip(skip);

		if (unread_only) {
			query.equalTo("is_read", false);
		}

		const [results, total] = await Promise.all([
			query.find({ useMasterKey: true }),
			query.count({ useMasterKey: true }),
		]);

		return {
			results: results.map((activity) => {
				const actor = activity.get("actor");
				const concert = activity.get("concert");
				const photo = activity.get("photo");
				const comment = activity.get("comment");

				const result: Record<string, unknown> = {
					id: activity.id,
					actor: getUserSummary(actor),
					type: activity.get("type"),
					preview_text: activity.get("preview_text"),
					is_read: activity.get("is_read") || false,
					createdAt: activity.createdAt?.toISOString(),
				};

				if (concert) {
					const artist = concert.get("artist");
					const venue = concert.get("venue");
					result.concert = {
						id: concert.id,
						artist_name: artist?.get("name"),
						venue_name: venue?.get("name"),
						concert_date: concert.get("concert_date")?.toISOString(),
					};
				}

				if (photo) {
					result.photo = {
						id: photo.id,
						thumbnail_url: photo.get("thumbnail_url"),
					};
				}

				if (comment) {
					result.comment = {
						id: comment.id,
						text: comment.get("text"),
					};
				}

				return result;
			}),
			count: results.length,
			total,
		};
	},
);

interface MarkActivitiesReadParams {
	activity_ids?: string[];
	all?: boolean;
}

/**
 * Mark activities as read
 */
Parse.Cloud.define(
	"markActivitiesRead",
	async (request: Parse.Cloud.FunctionRequest<MarkActivitiesReadParams>) => {
		const { activity_ids, all = false } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!all && (!activity_ids || activity_ids.length === 0)) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Activity IDs required or set all=true",
			);
		}

		const query = new Parse.Query("Activity");
		query.equalTo("recipient", user);
		query.equalTo("is_read", false);

		if (!all && activity_ids) {
			query.containedIn("objectId", activity_ids);
		}

		query.limit(1000);
		const activities = await query.find({ useMasterKey: true });

		for (const activity of activities) {
			activity.set("is_read", true);
		}

		await Parse.Object.saveAll(activities, { useMasterKey: true });

		return {
			success: true,
			marked_count: activities.length,
		};
	},
);

/**
 * Get count of unread activities
 */
Parse.Cloud.define(
	"getUnreadActivityCount",
	async (request: Parse.Cloud.FunctionRequest) => {
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		const query = new Parse.Query("Activity");
		query.equalTo("recipient", user);
		query.equalTo("is_read", false);
		const count = await query.count({ useMasterKey: true });

		return { unread_count: count };
	},
);

// ==================== Concert Activity Hook ====================

/**
 * After concert save - create activity for followers (new concerts only)
 */
Parse.Cloud.afterSave("Concert", async (request) => {
	const concert = request.object;
	const user = request.user;

	// Only for new concerts (no original means it's new), not updates
	if (request.original || !user) return;

	try {
		// Fetch artist and venue for preview text
		const concertQuery = new Parse.Query("Concert");
		concertQuery.include("artist");
		concertQuery.include("venue");
		const fullConcert = await concertQuery.get(concert.id, {
			useMasterKey: true,
		});

		const artist = fullConcert.get("artist");
		const venue = fullConcert.get("venue");

		const previewText = `${user.get("username") || "Someone"} logged ${artist?.get("name") || "a concert"} at ${venue?.get("name") || "a venue"}`;

		await fanOutToFollowers(user, "concert", fullConcert, previewText);
	} catch (error) {
		console.error("Error creating concert activity:", error);
	}
});

// ==================== User Search Functions ====================

/**
 * Escape regex special characters for safe use in RegExp
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface SearchUsersParams {
	query: string;
	limit?: number;
	skip?: number;
}

/**
 * Search for users by username or full name
 * Only returns public profiles and users the current user follows
 * Excludes deactivated accounts
 */
Parse.Cloud.define(
	"searchUsers",
	async (request: Parse.Cloud.FunctionRequest<SearchUsersParams>) => {
		const { query, limit = 20, skip = 0 } = request.params;
		const currentUser = request.user;

		if (!currentUser) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"Must be authenticated",
			);
		}

		if (!query || query.trim().length < 2) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Search query must be at least 2 characters",
			);
		}

		const searchTerm = query.trim().toLowerCase();
		const safeLimit = Math.min(Math.max(1, limit), 100);

		// Build query: search username OR full_name
		const usernameQuery = new Parse.Query(Parse.User);
		usernameQuery.startsWith("username", searchTerm);

		const fullNameQuery = new Parse.Query(Parse.User);
		fullNameQuery.matches("full_name", new RegExp(escapeRegex(query.trim()), "i"));

		const mainQuery = Parse.Query.or(usernameQuery, fullNameQuery);

		// Exclude deactivated accounts
		mainQuery.doesNotExist("deactivated_at");

		// Exclude current user from results
		mainQuery.notEqualTo("objectId", currentUser.id);

		// Only public profiles (private users filtering will be done post-query)
		mainQuery.equalTo("profile_visibility", "public");

		mainQuery.limit(safeLimit);
		mainQuery.skip(skip);
		mainQuery.select(
			"username",
			"full_name",
			"profile_picture_url",
			"city",
			"follower_count",
		);

		const users = await mainQuery.find({ useMasterKey: true });

		// Check follow status for each result
		const results = await Promise.all(
			users.map(async (user) => {
				const isFollowing = await checkIsFollower(currentUser.id, user.id);
				return {
					id: user.id,
					username: user.get("username"),
					full_name: user.get("full_name"),
					profile_picture_url: user.get("profile_picture_url"),
					city: user.get("city"),
					follower_count: user.get("follower_count") || 0,
					is_following: isFollowing,
				};
			}),
		);

		return { results, count: results.length };
	},
);

console.log("Social cloud functions loaded");
