import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcProviders = fileURLToPath(new URL("../ai/src/providers", import.meta.url));
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
		// Cap fork concurrency when CI is set. This suite's subprocess-lifecycle tests
		// (MCP keep-alive/ping-on-call fixtures, the default-on terminal PTY builtin,
		// and the app-server daemon/websocket listeners) each spawn several real child
		// processes. On the 4-vCPU GitHub runner, running these in parallel oversubscribes
		// CPU/IO and — worse in the release publish job — leaves child processes unreaped
		// long enough that the forks pool cannot exit, hanging the whole `npm test` step
		// (observed: coding-agent RUN never summarizes, orphan senpi/esbuild processes).
		// The same oversubscription flakes the local owner release, whose parallel forks
		// contend with the release build for CPU (app-server spawn timeouts, perf-bound
		// and race-control tests). A per-test timeout cannot fix a pool-shutdown hang.
		// Serialize to a single fork whenever `CI` is set — GitHub Actions sets it, and
		// `scripts/release.mjs` sets it for its test gate so the local release reproduces
		// CI's deterministic run. Plain local `npm test` (no `CI`) keeps the default pool
		// for speed.
		...(process.env.CI || process.env.GITHUB_ACTIONS
			? { pool: "forks" as const, maxWorkers: 1, teardownTimeout: 20000 }
			: {}),
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
			{ find: /^@earendil-works\/pi-ai\/providers\/(.+)$/, replacement: `${aiSrcProviders}/$1.ts` },
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
