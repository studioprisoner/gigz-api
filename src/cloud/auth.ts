/**
 * Authentication Cloud Functions
 * Handles Apple Sign In, Email/Password, and session management
 */

import type { AuthProvider, AuthResult, UserProfile } from "../lib/db.types";

// Parameter interfaces
interface SignInWithAppleParams {
	identityToken: string;
	authorizationCode: string;
	fullName?: string;
	email?: string;
}

interface SignUpWithEmailParams {
	email: string;
	password: string;
	username?: string;
	fullName?: string;
}

interface SignInWithEmailParams {
	email: string;
	password: string;
}

interface RequestPasswordResetParams {
	email: string;
}

interface LinkAppleAccountParams {
	identityToken: string;
	authorizationCode: string;
}

// Helper functions

/**
 * Validate email format
 */
function validateEmail(email: string): boolean {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email);
}

/**
 * Validate password strength (min 8 characters)
 */
function validatePassword(password: string): boolean {
	return password.length >= 8;
}

/**
 * Generate username from email if not provided
 */
function generateUsername(email: string): string {
	const baseUsername = email
		.split("@")[0]
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	const randomSuffix = Math.random().toString(36).substring(2, 6);
	return `${baseUsername}${randomSuffix}`;
}

/**
 * Get list of auth providers linked to a user
 */
function getAuthProviders(user: Parse.User): AuthProvider[] {
	const providers: AuthProvider[] = [];
	const authData = user.get("authData");

	if (authData?.apple) {
		providers.push("apple");
	}

	// Check if user has password (email/password auth)
	// Users with password auth have a hashed password stored
	const hasPassword = user.get("_hashed_password") || user.get("password");
	if (hasPassword || user.get("email")) {
		// If they have an email and signed up normally, they have password auth
		// This is a heuristic - Parse doesn't expose password existence directly
		if (!authData || Object.keys(authData).length === 0 || user.get("email")) {
			providers.push("password");
		}
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
 * Sign in or register with Apple ID
 * Parse's Apple adapter handles token verification automatically
 */
Parse.Cloud.define(
	"signInWithApple",
	async (
		request: Parse.Cloud.FunctionRequest<SignInWithAppleParams>,
	): Promise<AuthResult> => {
		const { identityToken, authorizationCode, fullName, email } =
			request.params;

		if (!identityToken || !authorizationCode) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Identity token and authorization code are required",
			);
		}

		try {
			// Decode the identity token to get the Apple user ID
			// The token is a JWT - we extract the subject (sub) claim
			const tokenParts = identityToken.split(".");
			if (tokenParts.length !== 3) {
				throw new Parse.Error(
					Parse.Error.INVALID_VALUE,
					"Invalid identity token format",
				);
			}

			const payload = JSON.parse(
				Buffer.from(tokenParts[1], "base64").toString("utf-8"),
			);
			const appleUserId = payload.sub;

			if (!appleUserId) {
				throw new Parse.Error(
					Parse.Error.INVALID_VALUE,
					"Could not extract Apple user ID from token",
				);
			}

			// Check if user already exists with this Apple ID
			const existingUserQuery = new Parse.Query(Parse.User);
			existingUserQuery.equalTo("authData.apple.id", appleUserId);
			const existingUser = await existingUserQuery.first({
				useMasterKey: true,
			});

			const isNewUser = !existingUser;

			// Use REST API to login/signup with Apple auth data
			// This is necessary because cloud code doesn't create session tokens
			// when using Parse.User.logInWith() - only the REST API does
			const serverUrl =
				process.env.PARSE_SERVER_URL || "http://localhost:3000/parse";
			const appId = process.env.PARSE_APP_ID;
			const masterKey = process.env.PARSE_MASTER_KEY;

			// Build the user data for the REST API call
			const userData: Record<string, unknown> = {
				authData: {
					apple: {
						id: appleUserId,
						token: identityToken,
					},
				},
			};

			// For new users, add profile data to the initial creation
			if (isNewUser) {
				const username = email
					? generateUsername(email)
					: `apple_${appleUserId.substring(0, 8)}`;
				userData.username = username;
				if (email) {
					userData.email = email;
				}
				if (fullName) {
					userData.full_name = fullName;
				}
			}

			console.log(
				`[signInWithApple] Making REST API call to ${serverUrl}/users`,
			);

			// Make REST API call to Parse Server's users endpoint
			// This properly creates a session token for the user
			// Use master key to bypass auth adapter restrictions
			const response = await fetch(`${serverUrl}/users`, {
				method: "POST",
				headers: {
					"X-Parse-Application-Id": appId || "",
					"X-Parse-Master-Key": masterKey || "",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(userData),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error(
					`[signInWithApple] REST API error: ${response.status} ${errorText}`,
				);
				let errorData: { code?: number; error?: string };
				try {
					errorData = JSON.parse(errorText);
				} catch {
					errorData = { error: errorText };
				}
				throw new Parse.Error(
					errorData.code || Parse.Error.INTERNAL_SERVER_ERROR,
					errorData.error || "Failed to authenticate with Apple",
				);
			}

			console.log(`[signInWithApple] REST API success, parsing response`);

			const result = await response.json();
			const sessionToken = result.sessionToken;

			if (!sessionToken) {
				throw new Parse.Error(
					Parse.Error.INTERNAL_SERVER_ERROR,
					"Failed to create session",
				);
			}

			// Fetch fresh user data
			const freshUserQuery = new Parse.Query(Parse.User);
			const freshUser = await freshUserQuery.get(result.objectId, {
				useMasterKey: true,
			});

			return {
				sessionToken,
				user: formatUserProfile(freshUser),
				isNewUser,
			};
		} catch (error) {
			if (error instanceof Parse.Error) {
				throw error;
			}
			throw new Parse.Error(
				Parse.Error.INTERNAL_SERVER_ERROR,
				`Apple authentication failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	},
);

/**
 * Sign up with email and password
 */
Parse.Cloud.define(
	"signUpWithEmail",
	async (
		request: Parse.Cloud.FunctionRequest<SignUpWithEmailParams>,
	): Promise<AuthResult> => {
		const { email, password, username, fullName } = request.params;

		if (!email || !password) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Email and password are required",
			);
		}

		// Validate email format
		if (!validateEmail(email)) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Invalid email format");
		}

		// Validate password strength
		if (!validatePassword(password)) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Password must be at least 8 characters",
			);
		}

		// Check if email already exists
		const emailQuery = new Parse.Query(Parse.User);
		emailQuery.equalTo("email", email.toLowerCase());
		const existingEmail = await emailQuery.first({ useMasterKey: true });

		if (existingEmail) {
			throw new Parse.Error(
				Parse.Error.EMAIL_TAKEN,
				"An account with this email already exists",
			);
		}

		// Check if username is taken (if provided)
		const finalUsername = username?.trim() || generateUsername(email);

		const usernameQuery = new Parse.Query(Parse.User);
		usernameQuery.equalTo("username", finalUsername);
		const existingUsername = await usernameQuery.first({ useMasterKey: true });

		if (existingUsername) {
			throw new Parse.Error(
				Parse.Error.USERNAME_TAKEN,
				"This username is already taken",
			);
		}

		try {
			// Create new user
			const user = new Parse.User();
			user.set("username", finalUsername);
			user.set("email", email.toLowerCase());
			user.set("password", password);

			if (fullName) {
				user.set("full_name", fullName.trim());
			}

			// Sign up the user (this also logs them in)
			await user.signUp();

			const sessionToken = user.getSessionToken();

			if (!sessionToken) {
				throw new Parse.Error(
					Parse.Error.INTERNAL_SERVER_ERROR,
					"Failed to create session",
				);
			}

			return {
				sessionToken,
				user: formatUserProfile(user),
				isNewUser: true,
			};
		} catch (error) {
			if (error instanceof Parse.Error) {
				throw error;
			}
			throw new Parse.Error(
				Parse.Error.INTERNAL_SERVER_ERROR,
				`Signup failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	},
);

/**
 * Sign in with email and password
 */
Parse.Cloud.define(
	"signInWithEmail",
	async (
		request: Parse.Cloud.FunctionRequest<SignInWithEmailParams>,
	): Promise<AuthResult> => {
		const { email, password } = request.params;

		if (!email || !password) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Email and password are required",
			);
		}

		try {
			// Parse.User.logIn expects username, but we want to allow email login
			// First, find user by email to get username
			const userQuery = new Parse.Query(Parse.User);
			userQuery.equalTo("email", email.toLowerCase());
			const userByEmail = await userQuery.first({ useMasterKey: true });

			if (!userByEmail) {
				throw new Parse.Error(
					Parse.Error.OBJECT_NOT_FOUND,
					"Invalid email or password",
				);
			}

			const username = userByEmail.get("username");

			// Now log in with username
			const user = await Parse.User.logIn(username, password);

			const sessionToken = user.getSessionToken();

			if (!sessionToken) {
				throw new Parse.Error(
					Parse.Error.INTERNAL_SERVER_ERROR,
					"Failed to create session",
				);
			}

			return {
				sessionToken,
				user: formatUserProfile(user),
				isNewUser: false,
			};
		} catch (error) {
			if (error instanceof Parse.Error) {
				// Mask specific errors for security
				if (
					error.code === Parse.Error.OBJECT_NOT_FOUND ||
					error.code === 101 // Invalid username/password
				) {
					throw new Parse.Error(
						Parse.Error.OBJECT_NOT_FOUND,
						"Invalid email or password",
					);
				}
				throw error;
			}
			throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, "Login failed");
		}
	},
);

/**
 * Request password reset email
 */
Parse.Cloud.define(
	"requestPasswordReset",
	async (
		request: Parse.Cloud.FunctionRequest<RequestPasswordResetParams>,
	): Promise<{ success: boolean }> => {
		const { email } = request.params;

		if (!email) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Email is required");
		}

		if (!validateEmail(email)) {
			throw new Parse.Error(Parse.Error.INVALID_VALUE, "Invalid email format");
		}

		try {
			// This will send email if RESEND_API_KEY is configured
			await Parse.User.requestPasswordReset(email.toLowerCase());

			// Always return success to prevent email enumeration
			return { success: true };
		} catch {
			// Swallow errors to prevent email enumeration
			// Parse will throw if email doesn't exist
			return { success: true };
		}
	},
);

/**
 * Validate current session and return user data
 */
Parse.Cloud.define(
	"validateSession",
	async (
		request: Parse.Cloud.FunctionRequest,
	): Promise<{ valid: boolean; user?: UserProfile }> => {
		const user = request.user;

		if (!user) {
			return { valid: false };
		}

		try {
			// Fetch fresh user data to ensure session is still valid
			const userQuery = new Parse.Query(Parse.User);
			const freshUser = await userQuery.get(user.id, { useMasterKey: true });

			return {
				valid: true,
				user: formatUserProfile(freshUser),
			};
		} catch {
			return { valid: false };
		}
	},
);

/**
 * Link Apple account to existing user
 * Requires authenticated user
 */
Parse.Cloud.define(
	"linkAppleAccount",
	async (
		request: Parse.Cloud.FunctionRequest<LinkAppleAccountParams>,
	): Promise<{ success: boolean; authProviders: AuthProvider[] }> => {
		const user = request.user;
		const { identityToken, authorizationCode } = request.params;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		if (!identityToken || !authorizationCode) {
			throw new Parse.Error(
				Parse.Error.INVALID_VALUE,
				"Identity token and authorization code are required",
			);
		}

		try {
			// Check if user already has Apple linked
			const authData = user.get("authData");
			if (authData?.apple) {
				throw new Parse.Error(
					Parse.Error.OTHER_CAUSE,
					"Apple account is already linked",
				);
			}

			// Decode the identity token to get the Apple user ID
			const tokenParts = identityToken.split(".");
			if (tokenParts.length !== 3) {
				throw new Parse.Error(
					Parse.Error.INVALID_VALUE,
					"Invalid identity token format",
				);
			}

			const payload = JSON.parse(
				Buffer.from(tokenParts[1], "base64").toString("utf-8"),
			);
			const appleUserId = payload.sub;

			if (!appleUserId) {
				throw new Parse.Error(
					Parse.Error.INVALID_VALUE,
					"Could not extract Apple user ID from token",
				);
			}

			// Check if this Apple ID is already linked to another account
			const existingQuery = new Parse.Query(Parse.User);
			existingQuery.equalTo("authData.apple.id", appleUserId);
			const existingUser = await existingQuery.first({ useMasterKey: true });

			if (existingUser && existingUser.id !== user.id) {
				throw new Parse.Error(
					Parse.Error.OTHER_CAUSE,
					"This Apple ID is already linked to another account",
				);
			}

			// Link Apple to user
			// @ts-expect-error - linkWith is available but not in types
			await user.linkWith("apple", {
				authData: {
					id: appleUserId,
					token: identityToken,
				},
			});

			// Fetch fresh user data
			const userQuery = new Parse.Query(Parse.User);
			const freshUser = await userQuery.get(user.id, { useMasterKey: true });

			return {
				success: true,
				authProviders: getAuthProviders(freshUser),
			};
		} catch (error) {
			if (error instanceof Parse.Error) {
				throw error;
			}
			throw new Parse.Error(
				Parse.Error.INTERNAL_SERVER_ERROR,
				`Failed to link Apple account: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	},
);

/**
 * Unlink Apple account from user
 * Requires authenticated user with another auth method available
 */
Parse.Cloud.define(
	"unlinkAppleAccount",
	async (
		request: Parse.Cloud.FunctionRequest,
	): Promise<{ success: boolean; authProviders: AuthProvider[] }> => {
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		try {
			// Fetch fresh user data
			const userQuery = new Parse.Query(Parse.User);
			const freshUser = await userQuery.get(user.id, { useMasterKey: true });

			const authData = freshUser.get("authData");

			if (!authData?.apple) {
				throw new Parse.Error(
					Parse.Error.OTHER_CAUSE,
					"No Apple account is linked",
				);
			}

			// Ensure user has another auth method (password)
			// We check if they have an email set - if so, they can set a password
			const email = freshUser.get("email");
			if (!email) {
				throw new Parse.Error(
					Parse.Error.OTHER_CAUSE,
					"Cannot unlink Apple account without another authentication method. Please add an email and password first.",
				);
			}

			// Unlink Apple
			// @ts-expect-error - _unlinkFrom is available but not in types
			await freshUser._unlinkFrom("apple");

			// Fetch updated user
			const updatedUserQuery = new Parse.Query(Parse.User);
			const updatedUser = await updatedUserQuery.get(user.id, {
				useMasterKey: true,
			});

			return {
				success: true,
				authProviders: getAuthProviders(updatedUser),
			};
		} catch (error) {
			if (error instanceof Parse.Error) {
				throw error;
			}
			throw new Parse.Error(
				Parse.Error.INTERNAL_SERVER_ERROR,
				`Failed to unlink Apple account: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	},
);

/**
 * Get list of linked auth providers for current user
 */
Parse.Cloud.define(
	"getAuthProviders",
	async (
		request: Parse.Cloud.FunctionRequest,
	): Promise<{ authProviders: AuthProvider[] }> => {
		const user = request.user;

		if (!user) {
			throw new Parse.Error(
				Parse.Error.INVALID_SESSION_TOKEN,
				"User must be authenticated",
			);
		}

		// Fetch fresh user data
		const userQuery = new Parse.Query(Parse.User);
		const freshUser = await userQuery.get(user.id, { useMasterKey: true });

		return {
			authProviders: getAuthProviders(freshUser),
		};
	},
);

console.log("Auth cloud functions loaded");
