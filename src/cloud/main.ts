/**
 * Cloud Code Entry Point
 * Registers all cloud functions and triggers
 */

// Privacy module loaded first as other modules depend on its exports
import "./privacy.ts";
import "./auth.ts";
import "./otp.ts";
import "./artists.ts";
import "./venues.ts";
import "./concerts.ts";
import "./photos.ts";
import "./users.ts";
import "./social.ts";
import { initializeSchemas } from "../schema/definitions.ts";

// Schema initialization job (run via dashboard or CLI)
Parse.Cloud.job("initializeSchemas", async (_request) => {
	await initializeSchemas();
	return "Schemas initialized successfully";
});

// Health check cloud function
Parse.Cloud.define("health", async () => {
	return {
		status: "ok",
		timestamp: new Date().toISOString(),
		version: "1.0.0",
	};
});

console.log("Cloud functions loaded");
