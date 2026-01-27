import path from "node:path";
import type { ParseServerOptions } from "parse-server";

// Ensure required environment variables are set
const requiredEnvVars = [
	"DATABASE_URL",
	"PARSE_APP_ID",
	"PARSE_MASTER_KEY",
	"PARSE_SERVER_URL",
] as const;

for (const envVar of requiredEnvVars) {
	if (!process.env[envVar]) {
		throw new Error(`Missing required environment variable: ${envVar}`);
	}
}

export const parseConfig: ParseServerOptions = {
	appName: "Gigz",
	databaseURI: process.env.DATABASE_URL,
	databaseOptions: {
		ssl: {
			rejectUnauthorized: false,
		},
		// Pool settings are configured via databaseURI or postgres adapter defaults
		// Parse Server's PostgresStorageAdapter uses pg-promise which manages pooling internally
	},
	appId: process.env.PARSE_APP_ID!,
	masterKey: process.env.PARSE_MASTER_KEY!,
	serverURL: process.env.PARSE_SERVER_URL!,
	publicServerURL:
		process.env.PARSE_PUBLIC_URL || process.env.PARSE_SERVER_URL!,
	clientKey: process.env.PARSE_CLIENT_KEY,
	restAPIKey: process.env.PARSE_CLIENT_KEY, // Use same key for REST API
	javascriptKey: process.env.PARSE_CLIENT_KEY, // Use same key for JS SDK

	// Cloud code
	cloud: path.resolve(import.meta.dir, "../cloud/main.ts"),

	// File storage - Cloudflare R2 (S3-compatible)
	...(process.env.R2_ACCESS_KEY && {
		filesAdapter: {
			module: "@parse/s3-files-adapter",
			options: {
				bucket: process.env.R2_BUCKET || "gigz-photos",
				region: "auto",
				directAccess: true,
				baseUrl: process.env.R2_PUBLIC_URL,
				s3overrides: {
					endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
					credentials: {
						accessKeyId: process.env.R2_ACCESS_KEY,
						secretAccessKey: process.env.R2_SECRET_KEY,
					},
				},
			},
		},
	}),

	// Authentication adapters
	auth: {
		apple: {
			clientId: process.env.APPLE_BUNDLE_ID,
		},
		// Google can be added later
		// google: {
		//   clientId: process.env.GOOGLE_CLIENT_ID,
		// },
	},

	// Email adapter for password reset (Resend)
	// Note: verifyUserEmails disabled - OTP already proves email ownership
	...(process.env.RESEND_API_KEY && {
		emailAdapter: {
			module: "parse-server-resend-adapter",
			options: {
				apiKey: process.env.RESEND_API_KEY,
				defaultFrom: process.env.EMAIL_FROM || "noreply@gigz.app",
			},
		},
		verifyUserEmails: false,
	}),

	// Security settings
	allowClientClassCreation: false,
	enableAnonymousUsers: false,

	// Session settings
	sessionLength: 31536000, // 1 year in seconds

	// Schema
	enforcePrivateUsers: true,
};
