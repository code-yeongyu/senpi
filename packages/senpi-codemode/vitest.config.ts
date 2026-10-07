import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

const senpiSrcIndex = fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url));
const aiSrcProviderScope = fileURLToPath(new URL("../ai/src/node/provider-scope.ts", import.meta.url));
const aiSrcBedrockProvider = fileURLToPath(new URL("../ai/src/bedrock-provider.ts", import.meta.url));
const aiSrcBunOAuth = fileURLToPath(new URL("../ai/src/bun-oauth.ts", import.meta.url));
const ptySrcIndex = fileURLToPath(new URL("../pty/src/index.ts", import.meta.url));

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			testTimeout: 30_000,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			// Interpreter tests spawn child runtimes; use the same CI worker bound as coding-agent.
			...(process.env.CI || process.env.GITHUB_ACTIONS ? { pool: "forks" as const, maxWorkers: 2 } : {}),
		},
		resolve: {
			alias: [
				{ find: /^@code-yeongyu\/senpi$/, replacement: senpiSrcIndex },
				{ find: /^@earendil-works\/pi-ai\/node\/provider-scope$/, replacement: aiSrcProviderScope },
				{ find: /^@earendil-works\/pi-ai\/bedrock-provider$/, replacement: aiSrcBedrockProvider },
				{ find: /^@earendil-works\/pi-ai\/bun-oauth$/, replacement: aiSrcBunOAuth },
				{ find: /^@earendil-works\/pi-pty$/, replacement: ptySrcIndex },
			],
		},
	}),
);
