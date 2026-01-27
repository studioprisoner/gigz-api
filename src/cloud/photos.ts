import {
	DeleteObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

interface UploadPhotoParams {
	concert_id: string;
	filename: string;
	content_type: string;
	is_cover?: boolean;
}

interface DeletePhotoParams {
	photo_id: string;
}

interface SetCoverPhotoParams {
	concert_id: string;
	photo_id: string;
}

// Initialize S3 client for R2
const getS3Client = () => {
	if (
		!process.env.R2_ACCESS_KEY ||
		!process.env.R2_SECRET_KEY ||
		!process.env.R2_ACCOUNT_ID
	) {
		throw new Parse.Error(
			Parse.Error.INTERNAL_SERVER_ERROR,
			"R2 storage not configured",
		);
	}

	return new S3Client({
		region: "auto",
		endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: process.env.R2_ACCESS_KEY!,
			secretAccessKey: process.env.R2_SECRET_KEY!,
		},
	});
};

/**
 * Get a presigned URL for uploading a photo directly to R2
 */
Parse.Cloud.define(
	"getPhotoUploadUrl",
	async (request: Parse.Cloud.FunctionRequest<UploadPhotoParams>) => {
		const { concert_id, filename, content_type, is_cover } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!concert_id || !filename || !content_type) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"concert_id, filename, and content_type are required",
			);
		}

		// Validate content type
		const allowedTypes = [
			"image/jpeg",
			"image/png",
			"image/heic",
			"image/webp",
		];
		if (!allowedTypes.includes(content_type)) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Invalid content type. Allowed: jpeg, png, heic, webp",
			);
		}

		// Verify concert exists and user owns it
		const concertQuery = new Parse.Query("Concert");
		const concert = await concertQuery.get(concert_id);
		const concertUser = concert.get("user");

		if (!concertUser || concertUser.id !== user.id) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"You can only add photos to your own concerts",
			);
		}

		// Generate unique key for the photo
		const extension = filename.split(".").pop() || "jpg";
		const timestamp = Date.now();
		const key = `concerts/${concert_id}/${timestamp}-${Math.random().toString(36).substring(7)}.${extension}`;

		const s3Client = getS3Client();
		const bucket = process.env.R2_BUCKET || "gigz-photos";

		// Generate presigned upload URL
		const command = new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			ContentType: content_type,
		});

		const uploadUrl = await getSignedUrl(s3Client, command, {
			expiresIn: 3600, // 1 hour
		});

		// Create ConcertPhoto record (photo_url will be set after upload)
		const ConcertPhoto = Parse.Object.extend("ConcertPhoto");
		const photo = new ConcertPhoto();

		const photoUrl = `${process.env.R2_PUBLIC_URL || `https://${bucket}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`}/${key}`;

		photo.set("concert", concert);
		photo.set("user", user);
		photo.set("photo_url", photoUrl);
		photo.set("is_cover", is_cover || false);

		// Set ACL
		const acl = new Parse.ACL(user);
		acl.setPublicReadAccess(true);
		photo.setACL(acl);

		await photo.save(null, { useMasterKey: true });

		// If this is the cover photo or first photo, update other photos
		if (is_cover) {
			const existingPhotosQuery = new Parse.Query("ConcertPhoto");
			existingPhotosQuery.equalTo("concert", concert);
			existingPhotosQuery.equalTo("is_cover", true);
			existingPhotosQuery.notEqualTo("objectId", photo.id);
			const existingCovers = await existingPhotosQuery.find({
				useMasterKey: true,
			});

			for (const existingCover of existingCovers) {
				existingCover.set("is_cover", false);
				await existingCover.save(null, { useMasterKey: true });
			}
		}

		return {
			upload_url: uploadUrl,
			photo_url: photoUrl,
			photo_id: photo.id,
			key,
		};
	},
);

/**
 * Delete a photo
 */
Parse.Cloud.define(
	"deletePhoto",
	async (request: Parse.Cloud.FunctionRequest<DeletePhotoParams>) => {
		const { photo_id } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!photo_id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "photo_id is required");
		}

		const photoQuery = new Parse.Query("ConcertPhoto");
		const photo = await photoQuery.get(photo_id);

		// Verify ownership
		const photoUser = photo.get("user");
		if (!photoUser || photoUser.id !== user.id) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"You can only delete your own photos",
			);
		}

		// Delete from R2
		const photoUrl = photo.get("photo_url") as string;
		if (photoUrl && process.env.R2_ACCESS_KEY) {
			try {
				const bucket = process.env.R2_BUCKET || "gigz-photos";
				const baseUrl =
					process.env.R2_PUBLIC_URL ||
					`https://${bucket}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
				const key = photoUrl.replace(`${baseUrl}/`, "");

				const s3Client = getS3Client();
				await s3Client.send(
					new DeleteObjectCommand({
						Bucket: bucket,
						Key: key,
					}),
				);
			} catch (error) {
				console.error("Error deleting from R2:", error);
				// Continue with database deletion even if R2 deletion fails
			}
		}

		// Delete from database
		await photo.destroy({ useMasterKey: true });

		return { success: true };
	},
);

/**
 * Set a photo as the cover photo for a concert
 */
Parse.Cloud.define(
	"setCoverPhoto",
	async (request: Parse.Cloud.FunctionRequest<SetCoverPhotoParams>) => {
		const { concert_id, photo_id } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!concert_id || !photo_id) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"concert_id and photo_id are required",
			);
		}

		// Verify concert ownership
		const concertQuery = new Parse.Query("Concert");
		const concert = await concertQuery.get(concert_id);
		const concertUser = concert.get("user");

		if (!concertUser || concertUser.id !== user.id) {
			throw new Parse.Error(
				Parse.Error.OPERATION_FORBIDDEN,
				"You can only modify your own concerts",
			);
		}

		// Verify photo belongs to this concert
		const photoQuery = new Parse.Query("ConcertPhoto");
		photoQuery.equalTo("concert", concert);
		const photo = await photoQuery.get(photo_id);

		if (!photo) {
			throw new Parse.Error(
				Parse.Error.OBJECT_NOT_FOUND,
				"Photo not found in this concert",
			);
		}

		// Unset other cover photos
		const existingCoverQuery = new Parse.Query("ConcertPhoto");
		existingCoverQuery.equalTo("concert", concert);
		existingCoverQuery.equalTo("is_cover", true);
		const existingCovers = await existingCoverQuery.find({
			useMasterKey: true,
		});

		for (const existingCover of existingCovers) {
			existingCover.set("is_cover", false);
			await existingCover.save(null, { useMasterKey: true });
		}

		// Set new cover photo
		photo.set("is_cover", true);
		await photo.save(null, { useMasterKey: true });

		return photo.toJSON();
	},
);

/**
 * Get photos for a concert
 */
Parse.Cloud.define(
	"getConcertPhotos",
	async (
		request: Parse.Cloud.FunctionRequest<{
			concert_id: string;
			limit?: number;
			skip?: number;
		}>,
	) => {
		const { concert_id, limit = 50, skip = 0 } = request.params;

		if (!concert_id) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"concert_id is required",
			);
		}

		const concertQuery = new Parse.Query("Concert");
		const concert = await concertQuery.get(concert_id);

		const photoQuery = new Parse.Query("ConcertPhoto");
		photoQuery.equalTo("concert", concert);
		photoQuery.descending("createdAt");
		photoQuery.limit(Math.min(limit, 100));
		photoQuery.skip(skip);

		// Put cover photo first
		photoQuery.descending("is_cover");
		photoQuery.addDescending("createdAt");

		const photos = await photoQuery.find();

		return {
			results: photos.map((photo) => photo.toJSON()),
			count: photos.length,
		};
	},
);

/**
 * Get all photos for a user across all concerts
 */
Parse.Cloud.define(
	"getUserPhotos",
	async (
		request: Parse.Cloud.FunctionRequest<{
			user_id?: string;
			limit?: number;
			skip?: number;
		}>,
	) => {
		const { user_id, limit = 50, skip = 0 } = request.params;
		const currentUser = request.user;

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

		const photoQuery = new Parse.Query("ConcertPhoto");
		photoQuery.equalTo("user", targetUser);
		photoQuery.include("concert");
		photoQuery.include("concert.artist");
		photoQuery.include("concert.venue");
		photoQuery.descending("createdAt");
		photoQuery.limit(Math.min(limit, 100));
		photoQuery.skip(skip);

		const [photos, total] = await Promise.all([
			photoQuery.find(),
			photoQuery.count({ useMasterKey: true }),
		]);

		return {
			results: photos.map((photo) => photo.toJSON()),
			count: photos.length,
			total,
		};
	},
);
