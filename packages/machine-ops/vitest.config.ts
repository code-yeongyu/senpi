import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

const ptySrcIndex = fileURLToPath(new URL("../pty/src/index.ts", import.meta.url));

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			testTimeout: 30_000,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			// The conformance suite spawns real process groups and PTYs; use the same CI worker bound as coding-agent.
			...(process.env.CI || process.env.GITHUB_ACTIONS ? { pool: "forks" as const, maxWorkers: 2 } : {}),
		},
		resolve: {
			alias: [{ find: /^@earendil-works\/pi-pty$/, replacement: ptySrcIndex }],
		},
	}),
);
