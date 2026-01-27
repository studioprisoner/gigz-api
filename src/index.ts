import "dotenv/config";
import express from "express";
import { ParseServer } from "parse-server";
import { parseConfig } from "./config/parse.ts";
import monitoringRoutes from "./routes/monitoring.ts";
import { initializeSchemas } from "./schema/definitions.ts";

const app = express();

// Monitoring endpoints
app.use("/", monitoringRoutes);

// Initialize and start Parse Server
async function startServer() {
	const parseServer = new ParseServer(parseConfig);
	await parseServer.start();

	// Mount Parse Server
	app.use("/parse", parseServer.app);

	const PORT = process.env.PORT || 3000;

	app.listen(PORT, async () => {
		console.log(`Gigz API running on port ${PORT}`);
		console.log(`Parse Server mounted at /parse`);
		console.log(`Health check available at /health`);

		// Initialize schemas after HTTP server is listening
		// (Parse SDK connects via HTTP to the REST API)
		try {
			await initializeSchemas();
		} catch (error) {
			console.error("Failed to initialize schemas:", error);
		}
	});
}

startServer().catch((error) => {
	console.error("Failed to start server:", error);
	process.exit(1);
});

export default app;
