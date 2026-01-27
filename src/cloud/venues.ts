import slugify from "slugify";

interface CreateVenueParams {
	name: string;
	address?: string;
	city?: string;
	country?: string;
	latitude?: number;
	longitude?: number;
	capacity?: number;
}

interface SearchVenuesParams {
	query?: string;
	city?: string;
	latitude?: number;
	longitude?: number;
	radius_km?: number;
	limit?: number;
	skip?: number;
}

/**
 * Create a new venue with duplicate detection
 */
Parse.Cloud.define(
	"createVenue",
	async (request: Parse.Cloud.FunctionRequest<CreateVenueParams>) => {
		const { name, address, city, country, latitude, longitude, capacity } =
			request.params;
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
				"Venue name is required",
			);
		}

		const trimmedName = name.trim();
		const slug = slugify(trimmedName, { lower: true, strict: true });

		// Check for existing venue by slug
		const slugQuery = new Parse.Query("Venue");
		slugQuery.equalTo("slug", slug);
		const existingBySlug = await slugQuery.first({ useMasterKey: true });

		if (existingBySlug) {
			return existingBySlug.toJSON();
		}

		// Check for existing venue by name + city (case-insensitive)
		const nameQuery = new Parse.Query("Venue");
		nameQuery.matches("name", new RegExp(`^${escapeRegex(trimmedName)}$`, "i"));
		if (city) {
			nameQuery.matches(
				"city",
				new RegExp(`^${escapeRegex(city.trim())}$`, "i"),
			);
		}
		const existingByName = await nameQuery.first({ useMasterKey: true });

		if (existingByName) {
			return existingByName.toJSON();
		}

		// If coordinates provided, check for nearby duplicates with same name
		if (latitude !== undefined && longitude !== undefined) {
			const geoPoint = new Parse.GeoPoint(latitude, longitude);
			const nearbyQuery = new Parse.Query("Venue");
			nearbyQuery.matches(
				"name",
				new RegExp(`^${escapeRegex(trimmedName)}$`, "i"),
			);
			nearbyQuery.withinKilometers("location", geoPoint, 1); // Within 1km
			const nearbyVenue = await nearbyQuery.first({ useMasterKey: true });

			if (nearbyVenue) {
				return nearbyVenue.toJSON();
			}
		}

		// Create new venue
		const Venue = Parse.Object.extend("Venue");
		const venue = new Venue();

		venue.set("name", trimmedName);
		venue.set("slug", slug);
		venue.set("created_by", user);
		venue.set("verified", false);

		if (address) venue.set("address", address.trim());
		if (city) venue.set("city", city.trim());
		if (country) venue.set("country", country.trim());
		if (capacity) venue.set("capacity", capacity);

		if (latitude !== undefined && longitude !== undefined) {
			venue.set("location", new Parse.GeoPoint(latitude, longitude));
		}

		// Set ACL - public read, only admins can modify
		const acl = new Parse.ACL();
		acl.setPublicReadAccess(true);
		acl.setWriteAccess(user, false);
		venue.setACL(acl);

		await venue.save(null, { useMasterKey: true });

		return venue.toJSON();
	},
);

/**
 * Search venues by name, city, or location
 */
Parse.Cloud.define(
	"searchVenues",
	async (request: Parse.Cloud.FunctionRequest<SearchVenuesParams>) => {
		const {
			query,
			city,
			latitude,
			longitude,
			radius_km = 50,
			limit = 20,
			skip = 0,
		} = request.params;

		const searchQuery = new Parse.Query("Venue");

		// Text search on name
		if (query && query.trim().length > 0) {
			searchQuery.matches("name", new RegExp(escapeRegex(query.trim()), "i"));
		}

		// Filter by city
		if (city && city.trim().length > 0) {
			searchQuery.matches("city", new RegExp(escapeRegex(city.trim()), "i"));
		}

		// Geo search
		if (latitude !== undefined && longitude !== undefined) {
			const geoPoint = new Parse.GeoPoint(latitude, longitude);
			searchQuery.withinKilometers("location", geoPoint, radius_km);
		}

		searchQuery.ascending("name");
		searchQuery.limit(Math.min(limit, 100));
		searchQuery.skip(skip);

		const results = await searchQuery.find();

		return {
			results: results.map((venue) => venue.toJSON()),
			count: results.length,
		};
	},
);

/**
 * Get venue by ID
 */
Parse.Cloud.define(
	"getVenue",
	async (request: Parse.Cloud.FunctionRequest<{ id: string }>) => {
		const { id } = request.params;

		if (!id) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Venue ID required");
		}

		const query = new Parse.Query("Venue");
		const venue = await query.get(id);

		return venue.toJSON();
	},
);

/**
 * Get venue by slug
 */
Parse.Cloud.define(
	"getVenueBySlug",
	async (request: Parse.Cloud.FunctionRequest<{ slug: string }>) => {
		const { slug } = request.params;

		if (!slug) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Venue slug required");
		}

		const query = new Parse.Query("Venue");
		query.equalTo("slug", slug);
		const venue = await query.first();

		if (!venue) {
			throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, "Venue not found");
		}

		return venue.toJSON();
	},
);

/**
 * Get venues by city
 */
Parse.Cloud.define(
	"getVenuesByCity",
	async (
		request: Parse.Cloud.FunctionRequest<{
			city: string;
			limit?: number;
			skip?: number;
		}>,
	) => {
		const { city, limit = 50, skip = 0 } = request.params;

		if (!city) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "City required");
		}

		const query = new Parse.Query("Venue");
		query.matches("city", new RegExp(`^${escapeRegex(city.trim())}$`, "i"));
		query.ascending("name");
		query.limit(Math.min(limit, 100));
		query.skip(skip);

		const results = await query.find();

		return {
			results: results.map((venue) => venue.toJSON()),
			count: results.length,
		};
	},
);

/**
 * Before save trigger for Venue
 */
Parse.Cloud.beforeSave("Venue", async (request) => {
	const venue = request.object;

	// Generate slug if not set
	if (!venue.get("slug") && venue.get("name")) {
		const slug = slugify(venue.get("name"), { lower: true, strict: true });
		venue.set("slug", slug);
	}

	// Trim string fields
	if (venue.get("name")) venue.set("name", venue.get("name").trim());
	if (venue.get("address")) venue.set("address", venue.get("address").trim());
	if (venue.get("city")) venue.set("city", venue.get("city").trim());
	if (venue.get("country")) venue.set("country", venue.get("country").trim());
});

// Helper function to escape regex special characters
function escapeRegex(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
