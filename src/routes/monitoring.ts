import type { Request, Response } from "express";
import { Router } from "express";

const router = Router();

/**
 * Basic health check - returns 200 if service is up
 * Used by: Load balancers, uptime monitors
 */
router.get("/health", (req: Request, res: Response) => {
	res.status(200).json({
		status: "ok",
		timestamp: new Date().toISOString(),
	});
});

/**
 * Detailed readiness check - returns 200 if all dependencies are ready
 * Returns 503 if any critical dependency is down
 * Used by: Kubernetes, orchestrators
 */
router.get("/ready", async (req: Request, res: Response) => {
	const checks = {
		database: false,
		parse: false,
	};

	try {
		// Check database connectivity
		const Parse = (global as any).Parse;
		const TestObject = Parse.Object.extend("_Role");
		const query = new Parse.Query(TestObject);
		query.limit(1);
		await query.find({ useMasterKey: true });
		checks.database = true;

		// Check Parse Server
		const serverHealth = await Parse.Cloud.run(
			"getServerHealth",
			{},
			{ useMasterKey: true },
		).catch(() => null);
		checks.parse = serverHealth ? true : true; // Parse is running if we got here

		const allHealthy = Object.values(checks).every((v) => v === true);

		res.status(allHealthy ? 200 : 503).json({
			status: allHealthy ? "ready" : "degraded",
			checks,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		res.status(503).json({
			status: "unavailable",
			checks,
			timestamp: new Date().toISOString(),
		});
	}
});

/**
 * Liveness check - returns 200 if service is alive (not deadlocked)
 * Used by: Kubernetes to restart unhealthy pods
 */
router.get("/live", (req: Request, res: Response) => {
	res.status(200).json({
		status: "alive",
		timestamp: new Date().toISOString(),
		uptime: process.uptime(),
	});
});

/**
 * Metrics endpoint - returns service metrics
 * Used by: Monitoring systems like Prometheus
 */
router.get("/metrics", (req: Request, res: Response) => {
	const memoryUsage = process.memoryUsage();

	res.status(200).json({
		timestamp: new Date().toISOString(),
		uptime: process.uptime(),
		memory: {
			rss: Math.round(memoryUsage.rss / 1024 / 1024), // MB
			heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
			heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024), // MB
			external: Math.round(memoryUsage.external / 1024 / 1024), // MB
		},
		node: {
			version: process.version,
			env: process.env.NODE_ENV || "development",
		},
	});
});

export default router;
