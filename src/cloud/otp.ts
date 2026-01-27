/**
 * OTP (One-Time Password) Email Authentication
 * Passwordless authentication via email verification codes
 */

import { randomBytes } from "node:crypto";
import { generateOTPCode, hashSHA256, normalizeEmail } from "../lib/crypto";
import type { AuthProvider, AuthResult, UserProfile } from "../lib/db.types";
import { sendOTPEmail } from "../lib/resend";

// Constants
const OTP_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_EMAIL_PER_HOUR = 5;
const RATE_LIMIT_IP_PER_HOUR = 10;
const RATE_LIMIT_RESEND_PER_10MIN = 3;
const SESSION_EXPIRY_DAYS = 365;

// Parameter interfaces
interface RequestOTPParams {
	email: string;
}

interface VerifyOTPParams {
	email: string;
	code: string;
}

interface ResendOTPParams {
	email: string;
}

/**
 * Validate email format
 */
function validateEmail(email: string): boolean {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email);
}

/**
 * Generate username from email
 */
function generateUsername(email: string): string {
	const baseUsername = (email.split("@")[0] ?? "user")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	const randomSuffix = Math.random().toString(36).substring(2, 6);
	return `${baseUsername}${randomSuffix}`;
}

/**
 * Generate a secure random token for session
 */
function generateSecureToken(): string {
	return randomBytes(32).toString("hex");
}

/**
 * Generate a secure random password (for OTP users who will never use it)
 */
function generateSecurePassword(): string {
	return randomBytes(32).toString("base64");
}

/**
 * Create a session manually for a user via REST API
 * The Parse SDK marks 'user' as readonly on _Session, so we use REST API
 */
async function createSessionForUser(user: Parse.User): Promise<string> {
	const serverUrl =
		process.env.PARSE_SERVER_URL || "http://localhost:3000/parse";
	const appId = process.env.PARSE_APP_ID;
	const masterKey = process.env.PARSE_MASTER_KEY;

	const sessionToken = `r:${generateSecureToken()}`;
	const expiresAt = new Date(
		Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
	);

	const response = await fetch(`${serverUrl}/classes/_Session`, {
		method: "POST",
		headers: {
			"X-Parse-Application-Id": appId || "",
			"X-Parse-Master-Key": masterKey || "",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			user: { __type: "Pointer", className: "_User", objectId: user.id },
			createdWith: { action: "login", authProvider: "otp" },
			restricted: false,
			expiresAt: { __type: "Date", iso: expiresAt.toISOString() },
			sessionToken: sessionToken,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		console.error(`[OTP] Failed to create session via REST: ${errorText}`);
		throw new Error(`Failed to create session: ${errorText}`);
	}

	return sessionToken;
}

/**
 * Get list of auth providers linked to a user
 * OTP is available to any user with an email address
 */
function getAuthProviders(user: Parse.User): AuthProvider[] {
	const providers: AuthProvider[] = [];
	const authData = user.get("authData");
	const email = user.get("email");

	if (authData?.apple) {
		providers.push("apple");
	}

	// OTP is available to any user with an email
	if (email) {
		providers.push("otp");
	}

	// Check if user has password (email/password auth)
	// Users created via OTP have a random password they don't know
	// So we only show "password" if they signed up with email/password (no authData)
	// or if they have Apple + email (meaning they added email/password later)
	const hasAuthData = authData && Object.keys(authData).length > 0;
	if (email && !hasAuthData) {
		providers.push("password");
	}

	return providers;
}

/**
 * Format user object to UserProfile
 */
function formatUserProfile(user: Parse.User): UserProfile {
	return {
		id: user.id,
		username: user.get("username"),
		email: user.get("email"),
		full_name: user.get("full_name"),
		profile_picture_url: user.get("profile_picture_url"),
		subscription_status: user.get("subscription_status") || "free",
		total_gigs: user.get("total_gigs") || 0,
		city: user.get("city"),
		authProviders: getAuthProviders(user),
	};
}

/**
 * Check rate limit for a given identifier and type
 * Returns true if rate limit exceeded
 */
async function checkRateLimit(
	identifierHash: string,
	type: "email" | "ip" | "resend",
	limit: number,
	windowMinutes: number,
): Promise<boolean> {
	const OTPRateLimit = Parse.Object.extend("OTPRateLimit");
	const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

	const query = new Parse.Query(OTPRateLimit);
	query.equalTo("identifier_hash", identifierHash);
	query.equalTo("type", type);
	query.greaterThan("window_start", windowStart);

	const existing = await query.first({ useMasterKey: true });

	if (existing) {
		const count = existing.get("count") || 0;
		if (count >= limit) {
			return true; // Rate limit exceeded
		}
		// Increment count
		existing.increment("count");
		await existing.save(null, { useMasterKey: true });
	} else {
		// Create new rate limit entry
		const rateLimit = new OTPRateLimit();
		rateLimit.set("identifier_hash", identifierHash);
		rateLimit.set("type", type);
		rateLimit.set("count", 1);
		rateLimit.set("window_start", new Date());
		await rateLimit.save(null, { useMasterKey: true });
	}

	return false;
}

/**
 * Request OTP code
 * Generates a code, stores it hashed, and sends via email
 */
Parse.Cloud.define(
	"requestOTP",
	async (
		request: Parse.Cloud.FunctionRequest<RequestOTPParams>,
	): Promise<{ success: boolean; expiresIn: number }> => {
		const { email } = request.params;

		if (!email) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Email is required");
		}

		if (!validateEmail(email)) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Invalid email format");
		}

		const normalizedEmail = normalizeEmail(email);
		const emailHash = hashSHA256(normalizedEmail);

		// Check rate limits
		const emailRateLimited = await checkRateLimit(
			emailHash,
			"email",
			RATE_LIMIT_EMAIL_PER_HOUR,
			60,
		);

		if (emailRateLimited) {
			// Always return success to prevent email enumeration
			// But don't actually send the email
			console.log(`[OTP] Rate limit exceeded for email: ${emailHash}`);
			return { success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 };
		}

		// Check IP rate limit if available
		const clientIP = request.ip;
		if (clientIP) {
			const ipHash = hashSHA256(clientIP);
			const ipRateLimited = await checkRateLimit(
				ipHash,
				"ip",
				RATE_LIMIT_IP_PER_HOUR,
				60,
			);

			if (ipRateLimited) {
				console.log(`[OTP] Rate limit exceeded for IP: ${ipHash}`);
				return { success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 };
			}
		}

		// Delete any existing OTP for this email
		const OTPCode = Parse.Object.extend("OTPCode");
		const existingQuery = new Parse.Query(OTPCode);
		existingQuery.equalTo("email_hash", emailHash);
		const existingCodes = await existingQuery.find({ useMasterKey: true });
		await Parse.Object.destroyAll(existingCodes, { useMasterKey: true });

		// Generate new OTP code
		const code = generateOTPCode();
		const codeHash = hashSHA256(code);
		const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

		// Store the OTP
		const otpRecord = new OTPCode();
		otpRecord.set("email_hash", emailHash);
		otpRecord.set("code_hash", codeHash);
		otpRecord.set("expires_at", expiresAt);
		otpRecord.set("attempts", 0);
		await otpRecord.save(null, { useMasterKey: true });

		// Send the email
		try {
			await sendOTPEmail(normalizedEmail, code);
		} catch (error) {
			console.error("[OTP] Failed to send email:", error);
			// Still return success to prevent email enumeration
		}

		console.log(`[OTP] Code requested for email hash: ${emailHash}`);

		return { success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 };
	},
);

/**
 * Verify OTP code and authenticate user
 * Returns session token and user profile
 */
Parse.Cloud.define(
	"verifyOTP",
	async (
		request: Parse.Cloud.FunctionRequest<VerifyOTPParams>,
	): Promise<AuthResult> => {
		const { email, code } = request.params;

		console.log(
			`[OTP] verifyOTP called for email: ${email?.substring(0, 3)}***`,
		);

		if (!email || !code) {
			console.log("[OTP] Missing email or code");
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Email and code are required",
			);
		}

		if (!validateEmail(email)) {
			console.log("[OTP] Invalid email format");
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Invalid email format");
		}

		// Validate code format (6 digits)
		if (!/^\d{6}$/.test(code)) {
			console.log(`[OTP] Invalid code format: ${code.length} chars`);
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Invalid code format");
		}

		const normalizedEmail = normalizeEmail(email);
		const emailHash = hashSHA256(normalizedEmail);
		const codeHash = hashSHA256(code);

		// Find the OTP record
		const OTPCode = Parse.Object.extend("OTPCode");
		const query = new Parse.Query(OTPCode);
		query.equalTo("email_hash", emailHash);
		const otpRecord = await query.first({ useMasterKey: true });

		if (!otpRecord) {
			console.log("[OTP] No OTP record found for email hash");
			throw new Parse.Error(
				Parse.Error.OBJECT_NOT_FOUND,
				"Invalid or expired code",
			);
		}

		console.log(
			`[OTP] Found OTP record, attempts: ${otpRecord.get("attempts")}`,
		);

		// Check if expired
		const expiresAt = otpRecord.get("expires_at");
		if (new Date() > expiresAt) {
			console.log("[OTP] Code expired");
			await otpRecord.destroy({ useMasterKey: true });
			throw new Parse.Error(
				Parse.Error.OBJECT_NOT_FOUND,
				"Invalid or expired code",
			);
		}

		// Check attempt limit
		const attempts = otpRecord.get("attempts") || 0;
		if (attempts >= MAX_ATTEMPTS) {
			await otpRecord.destroy({ useMasterKey: true });
			throw new Parse.Error(
				Parse.Error.OBJECT_NOT_FOUND,
				"Too many failed attempts. Please request a new code.",
			);
		}

		// Verify the code
		const storedCodeHash = otpRecord.get("code_hash");
		if (codeHash !== storedCodeHash) {
			console.log(`[OTP] Code mismatch - attempt ${attempts + 1}`);
			// Increment attempts
			otpRecord.increment("attempts");
			await otpRecord.save(null, { useMasterKey: true });
			throw new Parse.Error(
				Parse.Error.OBJECT_NOT_FOUND,
				"Invalid or expired code",
			);
		}

		console.log("[OTP] Code verified successfully");

		// Code is valid! Delete the OTP record
		await otpRecord.destroy({ useMasterKey: true });

		// Find or create user by email
		const userQuery = new Parse.Query(Parse.User);
		userQuery.equalTo("email", normalizedEmail);
		const existingUser = await userQuery.first({ useMasterKey: true });

		const isNewUser = !existingUser;
		let user: Parse.User;

		// REST API config
		const serverUrl =
			process.env.PARSE_SERVER_URL || "http://localhost:3000/parse";
		const appId = process.env.PARSE_APP_ID;
		const masterKey = process.env.PARSE_MASTER_KEY;

		let sessionToken: string;

		if (!existingUser) {
			// Create new user via REST API
			// Parse automatically creates a session and returns sessionToken
			const createResponse = await fetch(`${serverUrl}/users`, {
				method: "POST",
				headers: {
					"X-Parse-Application-Id": appId || "",
					"X-Parse-Master-Key": masterKey || "",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					username: generateUsername(normalizedEmail),
					email: normalizedEmail,
					password: generateSecurePassword(),
				}),
			});

			if (!createResponse.ok) {
				const errorText = await createResponse.text();
				console.error(`[OTP] Failed to create user: ${errorText}`);
				throw new Parse.Error(
					Parse.Error.INTERNAL_SERVER_ERROR,
					"Failed to create account. Please try again.",
				);
			}

			const createResult = (await createResponse.json()) as {
				objectId: string;
				sessionToken: string;
			};
			console.log(`[OTP] Created new user: ${createResult.objectId}`);
			sessionToken = createResult.sessionToken;

			// Mark email as verified (must be done after creation because Parse resets it)
			// OTP already proves email ownership
			const verifyResponse = await fetch(
				`${serverUrl}/users/${createResult.objectId}`,
				{
					method: "PUT",
					headers: {
						"X-Parse-Application-Id": appId || "",
						"X-Parse-Master-Key": masterKey || "",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ emailVerified: true }),
				},
			);

			if (!verifyResponse.ok) {
				console.warn(
					`[OTP] Failed to set emailVerified: ${await verifyResponse.text()}`,
				);
			} else {
				console.log(`[OTP] Email marked as verified`);
			}

			// Fetch the created user
			const newUserQuery = new Parse.Query(Parse.User);
			user = (await newUserQuery.get(createResult.objectId, {
				useMasterKey: true,
			})) as Parse.User;
		} else {
			user = existingUser as Parse.User;
			console.log(`[OTP] Found existing user: ${user.id}`);

			// For existing users, create a new session
			try {
				sessionToken = await createSessionForUser(user);
				console.log(`[OTP] Session created for existing user: ${user.id}`);
			} catch (sessionError) {
				console.error(`[OTP] Failed to create session:`, sessionError);
				throw new Parse.Error(
					Parse.Error.INTERNAL_SERVER_ERROR,
					"Failed to create session. Please try again.",
				);
			}
		}

		console.log(
			`[OTP] User ${isNewUser ? "created" : "authenticated"}: ${user.id}`,
		);

		return {
			sessionToken,
			user: formatUserProfile(user),
			isNewUser,
		};
	},
);

/**
 * Resend OTP code
 * Same as requestOTP but with stricter rate limiting
 */
Parse.Cloud.define(
	"resendOTP",
	async (
		request: Parse.Cloud.FunctionRequest<ResendOTPParams>,
	): Promise<{ success: boolean; expiresIn: number }> => {
		const { email } = request.params;

		if (!email) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Email is required");
		}

		if (!validateEmail(email)) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Invalid email format");
		}

		const normalizedEmail = normalizeEmail(email);
		const emailHash = hashSHA256(normalizedEmail);

		// Stricter rate limit for resend (3 per 10 minutes)
		const resendRateLimited = await checkRateLimit(
			emailHash,
			"resend",
			RATE_LIMIT_RESEND_PER_10MIN,
			10,
		);

		if (resendRateLimited) {
			console.log(`[OTP] Resend rate limit exceeded for: ${emailHash}`);
			return { success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 };
		}

		// Also check normal email rate limit
		const emailRateLimited = await checkRateLimit(
			emailHash,
			"email",
			RATE_LIMIT_EMAIL_PER_HOUR,
			60,
		);

		if (emailRateLimited) {
			console.log(`[OTP] Email rate limit exceeded for: ${emailHash}`);
			return { success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 };
		}

		// Check IP rate limit if available
		const clientIP = request.ip;
		if (clientIP) {
			const ipHash = hashSHA256(clientIP);
			const ipRateLimited = await checkRateLimit(
				ipHash,
				"ip",
				RATE_LIMIT_IP_PER_HOUR,
				60,
			);

			if (ipRateLimited) {
				console.log(`[OTP] IP rate limit exceeded for: ${ipHash}`);
				return { success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 };
			}
		}

		// Delete any existing OTP for this email
		const OTPCode = Parse.Object.extend("OTPCode");
		const existingQuery = new Parse.Query(OTPCode);
		existingQuery.equalTo("email_hash", emailHash);
		const existingCodes = await existingQuery.find({ useMasterKey: true });
		await Parse.Object.destroyAll(existingCodes, { useMasterKey: true });

		// Generate new OTP code
		const code = generateOTPCode();
		const codeHash = hashSHA256(code);
		const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

		// Store the OTP
		const otpRecord = new OTPCode();
		otpRecord.set("email_hash", emailHash);
		otpRecord.set("code_hash", codeHash);
		otpRecord.set("expires_at", expiresAt);
		otpRecord.set("attempts", 0);
		await otpRecord.save(null, { useMasterKey: true });

		// Send the email
		try {
			await sendOTPEmail(normalizedEmail, code);
		} catch (error) {
			console.error("[OTP] Failed to send email:", error);
		}

		console.log(`[OTP] Code resent for email hash: ${emailHash}`);

		return { success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 };
	},
);

console.log("OTP cloud functions loaded");
