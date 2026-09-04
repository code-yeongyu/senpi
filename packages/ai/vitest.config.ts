import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		// The provider and Cursor lifecycle suites create real HTTP/HTTP2 clients and
		// child processes. Keep CI fork concurrency bounded so a small runner cannot
		// oversubscribe the process table and strand a worker during pool teardown.
		...(process.env.CI || process.env.GITHUB_ACTIONS
			? { pool: "forks" as const, maxWorkers: 2, teardownTimeout: 20000 }
			: {}),
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-telemetry$/, replacement: telemetrySrcIndex }],
	},
});