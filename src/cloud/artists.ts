import slugify from "slugify";

interface CreateArtistParams {
	name: string;
	image_url?: string;
	spotify_id?: string;
	musicbrainz_id?: string;
}

interface SearchArtistsParams {
	query: string;
	limit?: number;
	skip?: number;
}

/**
 * Create a new artist with duplicate detection
 */
Parse.Cloud.define(
	"createArtist",
	async (request: Parse.Cloud.FunctionRequest<CreateArtistParams>) => {
		const { name, image_url, spotify_id, musicbrainz_id } = request.params;
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!name || name.trim().length === 0) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Artist name is required",
			);
		}

		const trimmedName = name.trim();
		const slug = slugify(trimmedName, { lower: true, strict: true });

		// Check for existing artist by slug (exact match)
		const slugQuery = new Parse.Query("Artist");
		slugQuery.equalTo("slug", slug);
		const existingBySlug = await slugQuery.first({ useMasterKey: true });

		if (existingBySlug) {
			return existingBySlug.toJSON();
		}

		// Check for existing artist by name (case-insensitive fuzzy match)
		const nameQuery = new Parse.Query("Artist");
		nameQuery.matches("name", new RegExp(`^${escapeRegex(trimmedName)}$`, "i"));
		const existingByName = await nameQuery.first({ useMasterKey: true });

		if (existingByName) {
			return existingByName.toJSON();
		}

		// Check by spotify_id if provided
		if (spotify_id) {
			const spotifyQuery = new Parse.Query("Artist");
			spotifyQuery.equalTo("spotify_id", spotify_id);
			const existingBySpotify = await spotifyQuery.first({
				useMasterKey: true,
			});

			if (existingBySpotify) {
				return existingBySpotify.toJSON();
			}
		}

		// Create new artist
		const Artist = Parse.Object.extend("Artist");
		const artist = new Artist();

		artist.set("name", trimmedName);
		artist.set("slug", slug);
		artist.set("created_by", user);
		artist.set("verified", false);

		if (image_url) artist.set("image_url", image_url);
		if (spotify_id) artist.set("spotify_id", spotify_id);
		if (musicbrainz_id) artist.set("musicbrainz_id", musicbrainz_id);

		// Set ACL - public read, only creator can modify (admin via masterKey)
		const acl = new Parse.ACL();
		acl.setPublicReadAccess(true);
		acl.setWriteAccess(user, false); // Users can't modify artists directly
		artist.setACL(acl);

		await artist.save(null, { useMasterKey: true });

		return artist.toJSON();
	},
);

/**
 * Search artists by name
 */
Parse.Cloud.define(
	"searchArtists",
	async (request: Parse.Cloud.FunctionRequest<SearchArtistsParams>) => {
		const { query, limit = 20, skip = 0 } = request.params;

		if (!query || query.trim().length === 0) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Search query required");
		}

		const searchQuery = new Parse.Query("Artist");
		searchQuery.matches("name", new RegExp(escapeRegex(query.trim()), "i"));
		searchQuery.ascending("name");
		searchQuery.limit(Math.min(limit, 100));
		searchQuery.skip(skip);

		const results = await searchQuery.find();

		return {
			results: results.map((artist) => artist.toJSON()),
			count: results.length,
		};
	},
);

/**
 * Get artist by ID
 */
Parse.Cloud.define(
	"getArtist",
	async (request: Parse.Cloud.FunctionRequest<{ id: string }>) => {
		const { id } = request.params;

		if (!id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Artist ID required");
		}

		const query = new Parse.Query("Artist");
		const artist = await query.get(id);

		return artist.toJSON();
	},
);

/**
 * Get artist by slug
 */
Parse.Cloud.define(
	"getArtistBySlug",
	async (request: Parse.Cloud.FunctionRequest<{ slug: string }>) => {
		const { slug } = request.params;

		if (!slug) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Artist slug required");
		}

		const query = new Parse.Query("Artist");
		query.equalTo("slug", slug);
		const artist = await query.first();

		if (!artist) {
			throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, "Artist not found");
		}

		return artist.toJSON();
	},
);

/**
 * Before save trigger for Artist
 */
Parse.Cloud.beforeSave("Artist", async (request) => {
	const artist = request.object;

	// Generate slug if not set
	if (!artist.get("slug") && artist.get("name")) {
		const slug = slugify(artist.get("name"), { lower: true, strict: true });
		artist.set("slug", slug);
	}

	// Ensure name is trimmed
	if (artist.get("name")) {
		artist.set("name", artist.get("name").trim());
	}
});

// Helper function to escape regex special characters
function escapeRegex(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
