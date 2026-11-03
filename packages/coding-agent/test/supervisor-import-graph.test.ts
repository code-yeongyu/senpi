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
 * senpi#3059 permits exactly three supervisor-local additions, bringing the measured graph to 55:
 * - `host-admission`: monotonic stopping state and typed refusal (51 code lines);
 * - `host-admission-proxy`: public socket framing/admission, using Node builtins and the existing `jsonl`
 *   leaf (188 code lines);
 * - `host-lifecycle-ticker`: the extracted idle/owner ticker, with type-only imports (32 code lines).
 * Together these are 9,930 source bytes, not new CLI/provider/core dependencies. The core allowlist and
 * every forbidden-import assertion below remain unchanged; this is no allowance for further graph growth.
 */
const SUPERVISOR_MODULE_CEILING = 55;
// senpi#3795: the approved sealed hop adds only these transport/lifetime leaves. Count
// the leaves actually loaded, not slots of generic headroom: the pre-existing
// graph still has its original ceiling even if a leaf is later removed.
// `host-lifecycle-internal-key` holds the supervisor's hop key and credentials, split out of host-lifecycle.ts
// (senpi#3816 review); its own imports were already in the graph. Measured: 60 modules with it (4 hop leaves
// before it), 1,970 source / 2,065 built bytes, 29 code lines.
const INTERNAL_HOP_LEAVES = new Set(
	[
		"internal-channel",
		"internal-record-cipher",
		"internal-record-stream",
		"host-lifetime-reader",
		"host-lifecycle-internal-key",
		// The one lifetime binding interface (senpi#3816 round 7: FIFO on Linux, reopened stdin on macOS). Measured:
		// 62 modules with it (6 hop leaves before it), 3,404 source / 3,198 built bytes, 44 code lines; it imports only
		// Node builtins and host-lifetime-reader, already a leaf.
		"host-lifetime-binding",
		// The recorded-supervisor poll, split out of host-watchdog.ts for its size (senpi#3816 review M2): moved code,
		// no new dependency. Measured: 63 modules with it (7 hop leaves before it), 5,369 source / 5,081 built bytes,
		// 89 code lines; it imports only process-identity and process-start-identity, both already in the graph.
		"host-supervisor-poll",
	]
		.map((name) => `packages/coding-agent/dist/modes/rpc/${name}.js`)
		// One clock domain per platform for the recorded supervisor start (senpi#3816 delta review): /proc start ticks
		// on Linux, ps lstart elsewhere. Measured: 61 modules with it (5 hop leaves before it), 2,512 source /
		// 2,184 built bytes, 40 code lines; its only repo import, process-identity, was already in the graph.
		.concat("packages/coding-agent/dist/utils/process-start-identity.js"),
);

// senpi#3815: the public endpoint's challenge-response (wire contract v1.1) adds exactly these three leaves, each
// importing only Node builtins and modules already in the graph (jsonl, socket-transport, process-identity). Measured
// at 66 modules (8 hop leaves): rpc-auth-proof 1,406 source / 1,079 built bytes, 35 code lines (the one HMAC and
// constant-time comparison, shared with the hop); rpc-public-auth 8,054 / 9,064, 214 (the pre-admission filter);
// rpc-public-key 7,349 / 8,190, 185 (the per-launch key record). Nothing else entered the graph.
const PUBLIC_AUTH_LEAVES = new Set(
	["rpc-auth-proof", "rpc-public-auth", "rpc-public-key"].map(
		(name) => `packages/coding-agent/dist/modes/rpc/${name}.js`,
	),
);

// senpi#4749: the supervisor forwards a launcher's named private descriptors to the engine it starts, so it captures the
// table at startup and spawns through the forwarding helper. That adds exactly these three leaves, each importing only
// Node builtins and each other. Measured at 69 modules (8 hop, 3 public auth leaves): private-fds 7,391 source bytes,
// 147 code lines (table capture and validation); private-fd-spawn 2,339 / 58 (explicit stdio forwarding);
// utils/inherited-duplex 1,431 / 43 (the fd adoption moved out of mcp-presenter-bootstrap, now shared).
// senpi#4864 adds the exact Windows receipt leaf, utils/private-fd-inherit (node:fs only; Bun FFI is
// resolved synchronously at runtime, not statically imported). Measured: 70 modules, four private-fd
// leaves. The base ceiling and every forbidden/core import check remain unchanged.
const PRIVATE_FD_LEAVES = new Set([
	"packages/coding-agent/dist/private-fds.js",
	"packages/coding-agent/dist/private-fd-spawn.js",
	"packages/coding-agent/dist/utils/inherited-duplex.js",
	"packages/coding-agent/dist/utils/private-fd-inherit.js",
]);

function loadedModules(entries: readonly { phase: string; url: string }[]): string[] {
	const repo = `file://${repoRoot}`;
	return [
		...new Set(
			entries.filter((entry) => entry.phase === "load" && entry.url.startsWith(repo)).map((entry) => entry.url),
		),
	].map((url) => url.slice(repo.length));
}

describe("RPC host supervisor import graph", () => {
	it("stays inside its module budget: no core module beyond the allowlist, no interactive or retired app-server module", () => {
		const modules = loadedModules(
			probeImportGraph(repoRoot, `${repoRoot}/packages/coding-agent/dist/modes/rpc/host-lifecycle.js`).entries,
		);
		const internalHopLeaves = modules.filter((url) => INTERNAL_HOP_LEAVES.has(url)).length;
		const publicAuthLeaves = modules.filter((url) => PUBLIC_AUTH_LEAVES.has(url)).length;
		const privateFdLeaves = modules.filter((url) => PRIVATE_FD_LEAVES.has(url)).length;
		console.info(
			`supervisor graph: ${modules.length} modules (base ceiling ${SUPERVISOR_MODULE_CEILING}, internal hop ${internalHopLeaves}, public auth ${publicAuthLeaves}, private fd ${privateFdLeaves})`,
		);

		const core = modules.filter((url) => url.startsWith("packages/coding-agent/dist/core/"));
		expect(
			core.filter((url) => !SUPERVISOR_CORE_ALLOWLIST.has(url.slice("packages/coding-agent/dist/core/".length))),
		).toEqual([]);
		expect(modules.filter((url) => url.startsWith("packages/coding-agent/dist/modes/interactive/"))).toEqual([]);
		expect(modules.filter((url) => url.startsWith("packages/coding-agent/dist/modes/app-server/"))).toEqual([]);
		expect(modules.length - internalHopLeaves - publicAuthLeaves - privateFdLeaves).toBeLessThanOrEqual(
			SUPERVISOR_MODULE_CEILING,
		);
	});

	// senpi#3743: a bundled install starts its supervisor through `dist/bundle/host-supervisor.js`. Before it
	// existed the supervisor booted through `cli.js`, whose main() graph cost ~60 MB in every supervisor.
	it("gives the bundled supervisor its own program that loads no other bundle file", () => {
		const entry = `${repoRoot}/packages/coding-agent/dist/bundle/host-supervisor.js`;
		const modules = loadedModules(probeImportGraph(repoRoot, entry).entries);
		expect(modules).toEqual(["packages/coding-agent/dist/bundle/host-supervisor.js"]);
	});

	it("keeps the supervisor program's own graph to the supervisor plus its preamble", () => {
		const modules = loadedModules(
			probeImportGraph(repoRoot, `${repoRoot}/packages/coding-agent/dist/modes/rpc/host-supervisor-entry.js`)
				.entries,
		);
		const lifecycle = new Set(
			loadedModules(
				probeImportGraph(repoRoot, `${repoRoot}/packages/coding-agent/dist/modes/rpc/host-lifecycle.js`).entries,
			),
		);
		// The runtime-snapshot modules are the claim `cli.js` used to make for the supervisor (senpi#3743 review):
		// node builtins only, no provider, CLI or TUI module.
		expect(modules.filter((url) => !lifecycle.has(url)).sort()).toEqual([
			"packages/coding-agent/dist/modes/rpc/host-supervisor-entry.js",
			"packages/coding-agent/dist/runtime-snapshot/dependency-files.js",
			"packages/coding-agent/dist/runtime-snapshot/file-copier.js",
			"packages/coding-agent/dist/runtime-snapshot/layout.js",
			"packages/coding-agent/dist/runtime-snapshot/package-files.js",
			"packages/coding-agent/dist/runtime-snapshot/registry.js",
			"packages/coding-agent/dist/runtime-snapshot/tree.js",
			"packages/coding-agent/dist/valid-cwd.js",
		]);
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
