import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));
const ptySrcIndex = fileURLToPath(new URL("../pty/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		setupFiles: ["./test/setup.ts"],
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		// Cap fork concurrency ON CI ONLY. This suite's subprocess-lifecycle tests
		// (MCP keep-alive/ping-on-call fixtures, and now the default-on terminal PTY
		// builtin) each spawn several real child processes. With the default forks
		// pool (maxWorkers = CPU count) the 4-vCPU GitHub runner is oversubscribed once
		// every default-on builtin's suite runs in parallel, and those child processes
		// get starved — surfacing as intermittent "condition timed out" / off-by-one
		// ping-count / kernel-startup-timeout flakes that no per-test timeout bump can
		// fix (it is CPU/IO starvation, not tight deadlines). Two workers keep useful
		// parallelism while bounding peak concurrent subprocesses. Local runs (many
		// cores, no oversubscription) keep the default pool for speed.
		...(process.env.GITHUB_ACTIONS ? { pool: "forks" as const, maxWorkers: 2 } : {}),
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@earendil-works\/pi-pty$/, replacement: ptySrcIndex },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
