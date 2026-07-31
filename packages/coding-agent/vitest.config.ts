import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

const aiSrcProviderScope = fileURLToPath(new URL("../ai/src/node/provider-scope.ts", import.meta.url));
const ptySrcIndex = fileURLToPath(new URL("../pty/src/index.ts", import.meta.url));

export default mergeConfig(
	baseConfig,
	defineConfig({
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
			// Cap the forks pool to two workers whenever `CI` is set — GitHub Actions sets it,
			// and `scripts/release.mjs` sets it for its test gate so the local release
			// reproduces CI's run. Two workers keeps the subprocess-heavy suites isolated in
			// separate fork processes (no shared-event-loop contention, bounded CPU/IO on the
			// 4-vCPU runner) while halving the per-file re-import cost that dominated the
			// single-fork wall time (measured: 1364s at maxWorkers 1, ~60% import). One
			// worker was the deterministic-hang fix; two is the measured sweet spot between
			// that safety and suite wall time. Plain local `npm test` (no `CI`) keeps the
			// default pool for speed.
			...(process.env.CI || process.env.GITHUB_ACTIONS
				? { pool: "forks" as const, maxWorkers: 2, teardownTimeout: 20000 }
				: {}),
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-ai\/node\/provider-scope$/, replacement: aiSrcProviderScope },
				{ find: /^@earendil-works\/pi-pty$/, replacement: ptySrcIndex },
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
