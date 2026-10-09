/**
 * The lifecycle supervisor's static import graph must stay small.
 *
 * A supervisor runs once per endpoint (every omo task shard and Desktop thread host), owns only the
 * public socket and restarts its host, and never parses CLI arguments or talks to a provider. Its
 * graph once reached `cli/args.js` - and through it the `@earendil-works/pi-ai` barrel and the whole
 * provider catalog - via one environment-name constant in `protocol-identity.ts`, which kept tens of
 * MB resident in every supervisor. The probe is Node's own loader hook, so a reintroduced edge,
 * direct or transitive, reappears here under any specifier.
 */
import { describe, expect, it } from "vitest";
import { probeImportGraph } from "./helpers/esm-import-graph-probe.ts";
import { assertWorkspaceBuildPrerequisite } from "./support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const repoRoot = new URL("../../..", import.meta.url).pathname;

const SUPERVISOR_FORBIDDEN = [
	{ what: "the CLI argument parser", reached: (url: string) => /\/dist\/cli\/args\.js$/u.test(url) },
	{ what: "the pi-ai provider barrel", reached: (url: string) => /\/ai\/dist\/index\.js$/u.test(url) },
] as const;

/**
 * proc-perf-fix item 3 (todo 12): the supervisor's graph is a budget, not only a denylist. These `dist/core/`
 * modules are its leaves on purpose - the brand behind every daemon path (`brand.js`), the durable crash
 * record it writes when the host child dies (`process-crash-record.js`), and the build identity it
 * answers `get_protocol_info` with (`engine-build-identity.js`); nothing else under `core/` belongs.
 */
const SUPERVISOR_CORE_ALLOWLIST = new Set(["brand.js", "process-crash-record.js", "engine-build-identity.js"]);
/**
 * The measured module count of the supervisor graph when this budget was set; it may only shrink. 35 was
 * measured before main's #2460 added `modes/rpc/host-exec-argv.ts` (the launch's forwarded-argv filter) to
 * the graph; 36 is the count on that base. senpi#2566 takes it to 52, every module named:
 * - 11 split `host-lifecycle` and `host-daemon-paths` by responsibility (each file under 250 lines):
 *   `host-lifecycle-{launch,proxy,activity,drain,shutdown,scratch,stall-wait}`, `host-cli-entry`,
 *   `host-supervisor-log` (out of `host-lifecycle`; `stall-wait` is the new bounded wait for a stalled
 *   child), and `host-endpoint-names`, `host-generation-paths` (out of `host-daemon-paths`);
 * - 5 are what the supervisor now does: `host-stop-intent` (who stopped the host and why),
 *   `host-stalled-evidence` + `loop-lag-threshold` (waiting for a stalled child instead of killing it),
 *   `host-state-json` (their atomic writes) and `ownership-safe-lock` (one terminal record per generation).
 * Measured over main's graph: +31.6 KB of built code.
 * The in-host watchdog stays out: the supervisor reads only its threshold, from the `loop-lag-threshold` leaf.
 */
const SUPERVISOR_MODULE_CEILING = 52;

function loadedModules(entries: readonly { phase: string; url: string }[]): string[] {
	const repo = `file://${repoRoot}`;
	return [
		...new Set(
			entries.filter((entry) => entry.phase === "load" && entry.url.startsWith(repo)).map((entry) => entry.url),
		),
	].map((url) => url.slice(repo.length));
}

describe("RPC host supervisor import graph", () => {
	it("stays inside its module budget: no core module beyond the allowlist, no interactive or app-server module but the daemon process reader", () => {
		const modules = loadedModules(
			probeImportGraph(repoRoot, `${repoRoot}/packages/coding-agent/dist/modes/rpc/host-lifecycle.js`).entries,
		);
		console.info(`supervisor graph: ${modules.length} modules (ceiling ${SUPERVISOR_MODULE_CEILING})`);

		const core = modules.filter((url) => url.startsWith("packages/coding-agent/dist/core/"));
		expect(
			core.filter((url) => !SUPERVISOR_CORE_ALLOWLIST.has(url.slice("packages/coding-agent/dist/core/".length))),
		).toEqual([]);
		expect(modules.filter((url) => url.startsWith("packages/coding-agent/dist/modes/interactive/"))).toEqual([]);
		expect(
			modules.filter(
				(url) =>
					url.startsWith("packages/coding-agent/dist/modes/app-server/") &&
					url !== "packages/coding-agent/dist/modes/app-server/daemon/process.js",
			),
		).toEqual([]);
		expect(modules.length).toBeLessThanOrEqual(SUPERVISOR_MODULE_CEILING);
	});

	it("keeps the CLI argument parser and the provider catalog out of the supervisor", () => {
		const result = probeImportGraph(repoRoot, `${repoRoot}/packages/coding-agent/dist/modes/rpc/host-lifecycle.js`);

		// Guards the probe itself: an empty walk would make every absence below vacuous.
		expect(result.entries.some((entry) => /\/dist\/modes\/rpc\/socket-transport\.js$/u.test(entry.url))).toBe(true);

		for (const { what, reached } of SUPERVISOR_FORBIDDEN) {
			expect
				.soft(
					result.entries.filter((entry) => reached(entry.url)).map((entry) => entry.url),
					`the supervisor graph statically reaches ${what}`,
				)
				.toEqual([]);
		}
	});
});
