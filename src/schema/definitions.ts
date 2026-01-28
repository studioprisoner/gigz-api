/**
 * Schema definitions for Gigz API
 * These define the structure and permissions for all Parse classes
 */

// Schema field type definitions
interface FieldType {
	type: string;
	required?: boolean;
	defaultValue?: unknown;
	targetClass?: string;
}

// Schema index definition
interface IndexDefinition {
	[key: string]: number | string;
}

// Class Level Permission definition
interface CLPPermission {
	"*"?: boolean;
	requiresAuthentication?: boolean;
	[key: string]: boolean | undefined;
}

interface CLP {
	find: CLPPermission;
	get: CLPPermission;
	create: CLPPermission;
	update: CLPPermission;
	delete: CLPPermission;
	addField: CLPPermission;
	protectedFields?: Record<string, string[]>;
}

export interface SchemaDefinition {
	className: string;
	fields: Record<string, FieldType>;
	indexes?: Record<string, IndexDefinition>;
	classLevelPermissions: CLP;
}

// Class Level Permissions helpers
const publicReadAuthWrite: CLP = {
	find: { "*": true },
	get: { "*": true },
	create: { requiresAuthentication: true },
	update: {},
	delete: {},
	addField: {},
	protectedFields: {},
};

const authOnlyOwnerModify: CLP = {
	find: { "*": true },
	get: { "*": true },
	create: { requiresAuthentication: true },
	update: { requiresAuthentication: true },
	delete: { requiresAuthentication: true },
	addField: {},
	protectedFields: {},
};

const privateUserOnly: CLP = {
	find: { requiresAuthentication: true },
	get: { requiresAuthentication: true },
	create: { requiresAuthentication: true },
	update: { requiresAuthentication: true },
	delete: { requiresAuthentication: true },
	addField: {},
	protectedFields: {},
};

// Internal system classes - master key only
const masterKeyOnly: CLP = {
	find: {},
	get: {},
	create: {},
	update: {},
	delete: {},
	addField: {},
	protectedFields: {},
};

// Social features - auth required, owner modify
const socialOwnerOnly: CLP = {
	find: { requiresAuthentication: true },
	get: { requiresAuthentication: true },
	create: { requiresAuthentication: true },
	update: { requiresAuthentication: true },
	delete: { requiresAuthentication: true },
	addField: {},
	protectedFields: {},
};

export const schemas: SchemaDefinition[] = [
	{
		className: "Artist",
		fields: {
			name: { type: "String", required: true },
			slug: { type: "String", required: true },
			image_url: { type: "String" },
			spotify_id: { type: "String" },
			musicbrainz_id: { type: "String" },
			created_by: { type: "Pointer", targetClass: "_User" },
			verified: { type: "Boolean", defaultValue: false },
		},
		indexes: {
			name_index: { name: 1 },
			slug_unique: { slug: 1 },
			spotify_index: { spotify_id: 1 },
		},
		classLevelPermissions: publicReadAuthWrite,
	},
	{
		className: "Venue",
		fields: {
			name: { type: "String", required: true },
			slug: { type: "String", required: true },
			address: { type: "String" },
			city: { type: "String" },
			country: { type: "String" },
			location: { type: "GeoPoint" },
			capacity: { type: "Number" },
			created_by: { type: "Pointer", targetClass: "_User" },
			verified: { type: "Boolean", defaultValue: false },
		},
		indexes: {
			name_index: { name: 1 },
			slug_unique: { slug: 1 },
			city_index: { city: 1 },
		},
		classLevelPermissions: publicReadAuthWrite,
	},
	{
		className: "Concert",
		fields: {
			artist: { type: "Pointer", targetClass: "Artist", required: true },
			venue: { type: "Pointer", targetClass: "Venue", required: true },
			concert_date: { type: "Date", required: true },
			tour_name: { type: "String" },
			official_setlist: { type: "Array" },
			description: { type: "String" },
			attendee_count: { type: "Number", defaultValue: 0 },
		},
		indexes: {
			artist_index: { artist: 1 },
			venue_index: { venue: 1 },
			date_index: { concert_date: -1 },
			artist_venue_date_unique: { artist: 1, venue: 1, concert_date: 1 },
		},
		classLevelPermissions: publicReadAuthWrite,
	},
	{
		className: "UserConcert",
		fields: {
			user: { type: "Pointer", targetClass: "_User", required: true },
			concert: { type: "Pointer", targetClass: "Concert", required: true },
			notes: { type: "String" },
			personal_setlist: { type: "Array" },
			rating: { type: "Number" },
			is_favorite: { type: "Boolean", defaultValue: false },
			like_count: { type: "Number", defaultValue: 0 },
			comment_count: { type: "Number", defaultValue: 0 },
		},
		indexes: {
			user_index: { user: 1 },
			concert_index: { concert: 1 },
			user_date_index: { user: 1, createdAt: -1 },
			user_concert_unique: { user: 1, concert: 1 },
		},
		classLevelPermissions: authOnlyOwnerModify,
	},
	{
		className: "Festival",
		fields: {
			name: { type: "String", required: true },
			slug: { type: "String", required: true },
			start_date: { type: "Date" },
			end_date: { type: "Date" },
			venue: { type: "Pointer", targetClass: "Venue" },
			created_by: { type: "Pointer", targetClass: "_User" },
		},
		indexes: {
			name_index: { name: 1 },
			slug_unique: { slug: 1 },
			date_index: { start_date: 1 },
		},
		classLevelPermissions: authOnlyOwnerModify,
	},
	{
		className: "ConcertPhoto",
		fields: {
			userConcert: { type: "Pointer", targetClass: "UserConcert", required: true },
			user: { type: "Pointer", targetClass: "_User", required: true },
			photo_url: { type: "String", required: true },
			thumbnail_url: { type: "String" },
			is_cover: { type: "Boolean", defaultValue: false },
			like_count: { type: "Number", defaultValue: 0 },
		},
		indexes: {
			userConcert_index: { userConcert: 1 },
			user_index: { user: 1 },
		},
		classLevelPermissions: authOnlyOwnerModify,
	},
	{
		className: "NotificationPreference",
		fields: {
			user: { type: "Pointer", targetClass: "_User", required: true },
			on_this_day_enabled: { type: "Boolean", defaultValue: true },
			on_this_day_time: { type: "String", defaultValue: "09:00" },
			festival_reminders_enabled: { type: "Boolean", defaultValue: true },
			likes_enabled: { type: "Boolean", defaultValue: true },
			comments_enabled: { type: "Boolean", defaultValue: true },
			followers_enabled: { type: "Boolean", defaultValue: true },
		},
		indexes: {
			user_unique: { user: 1 },
		},
		classLevelPermissions: privateUserOnly,
	},
	// Social Features
	{
		className: "Follow",
		fields: {
			follower: { type: "Pointer", targetClass: "_User", required: true },
			following: { type: "Pointer", targetClass: "_User", required: true },
		},
		indexes: {
			follower_following_unique: { follower: 1, following: 1 },
			follower_index: { follower: 1 },
			following_index: { following: 1 },
		},
		classLevelPermissions: socialOwnerOnly,
	},
	{
		className: "Like",
		fields: {
			user: { type: "Pointer", targetClass: "_User", required: true },
			userConcert: { type: "Pointer", targetClass: "UserConcert" },
			photo: { type: "Pointer", targetClass: "ConcertPhoto" },
			target_type: { type: "String", required: true },
			target_id: { type: "String", required: true },
		},
		indexes: {
			user_target_unique: { user: 1, target_type: 1, target_id: 1 },
			userConcert_index: { userConcert: 1 },
			photo_index: { photo: 1 },
			user_index: { user: 1 },
		},
		classLevelPermissions: socialOwnerOnly,
	},
	{
		className: "Comment",
		fields: {
			user: { type: "Pointer", targetClass: "_User", required: true },
			userConcert: { type: "Pointer", targetClass: "UserConcert", required: true },
			text: { type: "String", required: true },
			parent: { type: "Pointer", targetClass: "Comment" },
			reply_count: { type: "Number", defaultValue: 0 },
			is_deleted: { type: "Boolean", defaultValue: false },
		},
		indexes: {
			userConcert_created_index: { userConcert: 1, createdAt: -1 },
			user_index: { user: 1 },
			parent_index: { parent: 1 },
		},
		classLevelPermissions: socialOwnerOnly,
	},
	{
		className: "Activity",
		fields: {
			recipient: { type: "Pointer", targetClass: "_User", required: true },
			actor: { type: "Pointer", targetClass: "_User", required: true },
			type: { type: "String", required: true },
			userConcert: { type: "Pointer", targetClass: "UserConcert" },
			photo: { type: "Pointer", targetClass: "ConcertPhoto" },
			comment: { type: "Pointer", targetClass: "Comment" },
			preview_text: { type: "String" },
			is_read: { type: "Boolean", defaultValue: false },
		},
		indexes: {
			recipient_created_index: { recipient: 1, createdAt: -1 },
			recipient_read_index: { recipient: 1, is_read: 1 },
			created_index: { createdAt: -1 },
		},
		classLevelPermissions: socialOwnerOnly,
	},
	{
		className: "ConnectionKey",
		fields: {
			granter: { type: "Pointer", targetClass: "_User", required: true },
			grantee: { type: "Pointer", targetClass: "_User", required: true },
			granted_at: { type: "Date", required: true },
			is_active: { type: "Boolean", defaultValue: true },
		},
		indexes: {
			granter_grantee_unique: { granter: 1, grantee: 1 },
			granter_index: { granter: 1 },
			grantee_index: { grantee: 1 },
			grantee_active_index: { grantee: 1, is_active: 1 },
		},
		classLevelPermissions: socialOwnerOnly,
	},
	// OTP Authentication
	{
		className: "OTPCode",
		fields: {
			email_hash: { type: "String", required: true },
			code_hash: { type: "String", required: true },
			expires_at: { type: "Date", required: true },
			attempts: { type: "Number", defaultValue: 0 },
		},
		indexes: {
			email_hash_index: { email_hash: 1 },
			expires_at_index: { expires_at: 1 },
		},
		classLevelPermissions: masterKeyOnly,
	},
	// Rate limiting for OTP requests
	{
		className: "OTPRateLimit",
		fields: {
			identifier_hash: { type: "String", required: true },
			type: { type: "String", required: true },
			count: { type: "Number", defaultValue: 1 },
			window_start: { type: "Date", required: true },
		},
		indexes: {
			identifier_type_index: { identifier_hash: 1, type: 1 },
			window_start_index: { window_start: 1 },
		},
		classLevelPermissions: masterKeyOnly,
	},
];

/**
 * Extended _User fields (added to built-in Parse User class)
 */
export const userFields = {
	phone_number: { type: "String" as const },
	full_name: { type: "String" as const },
	profile_picture_url: { type: "String" as const },
	subscription_status: { type: "String" as const, defaultValue: "free" },
	total_gigs: { type: "Number" as const, defaultValue: 0 },
	city: { type: "String" as const },
	follower_count: { type: "Number" as const, defaultValue: 0 },
	following_count: { type: "Number" as const, defaultValue: 0 },
	profile_visibility: { type: "String" as const, defaultValue: "public" },
	deactivated_at: { type: "Date" as const }, // Set when user requests account deletion
};

/**
 * Indexes for _User class (for search functionality)
 */
export const userIndexes: Record<string, IndexDefinition> = {
	username_index: { username: 1 },
	full_name_index: { full_name: 1 },
};

/**
 * Initialize schemas in Parse Server
 * Run this on server startup or as a migration
 */
export async function initializeSchemas(): Promise<void> {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const Parse = require("parse/node");

	for (const schema of schemas) {
		let schemaExists = false;
		let existingSchema: { fields: Record<string, unknown> } | null = null;

		// Check if schema exists
		try {
			existingSchema = await new Parse.Schema(schema.className).get();
			schemaExists = true;
		} catch {
			schemaExists = false;
		}

		if (schemaExists && existingSchema) {
			// Update existing schema with any new fields
			console.log(
				`Schema ${schema.className} already exists, checking for updates...`,
			);
			const schemaUpdate = new Parse.Schema(schema.className);
			let hasUpdates = false;

			for (const [fieldName, fieldConfig] of Object.entries(schema.fields)) {
				if (!existingSchema.fields[fieldName]) {
					const { type, targetClass, required, defaultValue } = fieldConfig;
					const options: Record<string, unknown> = {};
					if (targetClass) options.targetClass = targetClass;
					if (required) options.required = required;
					if (defaultValue !== undefined) options.defaultValue = defaultValue;

					schemaUpdate.addField(fieldName, type, options);
					hasUpdates = true;
				}
			}

			if (hasUpdates) {
				try {
					await schemaUpdate.update();
					console.log(`  Updated ${schema.className} with new fields`);
				} catch (error) {
					console.error(`  Error updating ${schema.className}:`, error);
				}
			}
		} else {
			// Schema doesn't exist, create it
			console.log(`Creating schema: ${schema.className}`);
			try {
				const newSchema = new Parse.Schema(schema.className);

				for (const [fieldName, fieldConfig] of Object.entries(schema.fields)) {
					const { type, targetClass, required, defaultValue } = fieldConfig;
					const options: Record<string, unknown> = {};
					if (targetClass) options.targetClass = targetClass;
					if (required) options.required = required;
					if (defaultValue !== undefined) options.defaultValue = defaultValue;

					newSchema.addField(fieldName, type, options);
				}

				if (schema.indexes) {
					for (const [indexName, indexConfig] of Object.entries(
						schema.indexes,
					)) {
						newSchema.addIndex(indexName, indexConfig);
					}
				}

				newSchema.setCLP(schema.classLevelPermissions);
				await newSchema.save();
				console.log(`  Created ${schema.className}`);
			} catch (error) {
				console.error(`  Error creating ${schema.className}:`, error);
			}
		}
	}

	// Update _User schema with custom fields and indexes
	try {
		// Fetch existing _User schema to check what already exists
		const existingUserSchema = await new Parse.Schema("_User").get();
		const existingFields = existingUserSchema.fields || {};
		const existingIndexes = existingUserSchema.indexes || {};

		const userSchema = new Parse.Schema("_User");
		let hasUpdates = false;

		for (const [fieldName, fieldConfig] of Object.entries(userFields)) {
			if (!existingFields[fieldName]) {
				const { type, defaultValue } = fieldConfig;
				const options: Record<string, unknown> = {};
				if (defaultValue !== undefined) options.defaultValue = defaultValue;
				userSchema.addField(fieldName, type, options);
				hasUpdates = true;
			}
		}

		// Add indexes for user search (only if they don't exist)
		for (const [indexName, indexConfig] of Object.entries(userIndexes)) {
			if (!existingIndexes[indexName]) {
				userSchema.addIndex(indexName, indexConfig);
				hasUpdates = true;
			}
		}

		if (hasUpdates) {
			await userSchema.update();
			console.log("Updated _User schema with custom fields and indexes");
		} else {
			console.log("_User schema already up to date");
		}
	} catch (error) {
		console.error("Error updating _User schema:", error);
	}

	console.log("Schema initialization complete");
}
