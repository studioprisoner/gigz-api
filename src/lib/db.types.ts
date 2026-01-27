/**
 * Type definitions for Bun.sql query results
 */

export interface ConcertStats {
	totalConcerts: number;
	uniqueArtists: number;
	uniqueVenues: number;
	firstConcert: Date | null;
	latestConcert: Date | null;
}

export interface YearlyCount {
	year: number;
	count: number;
}

export interface TopArtist {
	id: string;
	name: string;
	count: number;
}

export interface TopVenue {
	id: string;
	name: string;
	count: number;
}

export interface TopCity {
	city: string;
	count: number;
}

export interface ConcertStatsResult {
	total_concerts: number;
	unique_artists: number;
	unique_venues: number;
	top_artists: TopArtist[];
	top_venues: TopVenue[];
	top_cities: TopCity[];
	concerts_by_year: YearlyCount[];
}

// Social feature types
export type ActivityType = "follow" | "like" | "comment" | "concert";
export type LikeTargetType = "concert" | "photo";

export interface FollowResult {
	id: string;
	follower: UserSummary;
	following: UserSummary;
	createdAt: string;
}

export interface UserSummary {
	id: string;
	username: string;
	full_name?: string;
	profile_picture_url?: string;
}

export interface LikeResult {
	id: string;
	user: UserSummary;
	target_type: LikeTargetType;
	target_id: string;
	createdAt: string;
}

export interface CommentResult {
	id: string;
	user: UserSummary;
	concert_id: string;
	text: string;
	parent_id?: string;
	reply_count: number;
	is_deleted: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface ActivityResult {
	id: string;
	actor: UserSummary;
	type: ActivityType;
	concert?: {
		id: string;
		artist_name: string;
		venue_name: string;
		concert_date: string;
	};
	photo?: {
		id: string;
		thumbnail_url?: string;
	};
	comment?: {
		id: string;
		text: string;
	};
	preview_text?: string;
	is_read: boolean;
	createdAt: string;
}

export interface PaginatedResult<T> {
	results: T[];
	count: number;
	total: number;
}

// Privacy feature types
export type ProfileVisibility = "public" | "private";

export interface ConnectionKeyResult {
	id: string;
	user: UserSummary;
	granted_at: string;
	is_active: boolean;
}

export interface MutualConnectionResult {
	user: UserSummary;
	has_key: boolean;
}

// Authentication types
export type AuthProvider = "apple" | "password" | "otp";

export interface AuthResult {
	sessionToken: string;
	user: UserProfile;
	isNewUser: boolean;
}

export interface UserProfile {
	id: string;
	username: string;
	email: string;
	full_name?: string;
	profile_picture_url?: string;
	subscription_status: string;
	total_gigs: number;
	city?: string;
	authProviders: AuthProvider[];
}
