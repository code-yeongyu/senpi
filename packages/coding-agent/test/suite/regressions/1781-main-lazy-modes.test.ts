/**
 * senpi#1781 - command/mode-only module graphs must not be evaluated before `main()` runs.
 *
 * `dist/main.js` is imported by every launch, so every module statically reachable from it is
 * resolved, parsed, compiled and evaluated before the first argument is inspected - whether the run
 * is `senpi --help`, an interactive session or an RPC host. The modules pinned here belong to one
 * command or one mode: the app-server command tree (70 modules), the RPC host cluster, the package
 * manager CLI, the `--list-tips` tip registry and the `--resume` session picker. They are now
 * `await import(...)`ed at the branch that uses them and must stay there.
 *
 * The probe is Node's own loader hook, not a source scan: a deferred import is absent by
 * construction, while a reintroduced top-level edge - direct or transitive, under any specifier -
 * reappears here. Two properties are asserted, because they fail differently:
 *
 * 1. `main.js` must not RESOLVE the deferred specifiers. This is the edge this lane owns, and it is
 *    exact: only `dist/main.js` can resolve `./modes/rpc/rpc-mode.js`, so the entry is proof that
 *    the static import came back.
 * 2. The subgraphs that nothing else drags in must be absent from the whole graph. `app-server`
 *    keeps one documented residual: `core/extensions/loader.ts` imports the package barrel
 *    (`src/index.ts` -> `modes/index.ts` -> `rpc/host-ensure.ts` -> `app-server/daemon/process.ts`),
 *    which is owned elsewhere and deliberately not touched here.
 */
import { describe, expect, it } from "vitest";
import { INTERNAL_SUPERVISOR_FLAG } from "../../../src/modes/rpc/host-lifecycle.ts";
import { INTERNAL_SUPERVISOR_ROUTE_FLAG } from "../../../src/modes/rpc/supervisor-route.ts";
import { probeImportGraph } from "../../helpers/esm-import-graph-probe.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const repoRoot = new URL("../../../../..", import.meta.url).pathname;

/** Every specifier `dist/main.js` itself must no longer resolve, with the branch that owns it. */
const DEFERRED_SPECIFIERS = [
	{ specifier: "./cli/app-server-command.js", branch: "the `app-server` command (cli/deferred-commands.ts)" },
	{ specifier: "./package-manager-cli.js", branch: "install/remove/update/list/config (cli/deferred-commands.ts)" },
	{
		specifier: "./modes/rpc/host-lifecycle.js",
		branch: "--internal-rpc-host-supervisor (modes/rpc/supervisor-route.ts)",
	},
	{ specifier: "./modes/rpc/multi-session-host.js", branch: "--mode rpc --multi-session" },
	{ specifier: "./modes/rpc/rpc-mode.js", branch: "--mode rpc" },
	{ specifier: "./cli/list-tips.js", branch: "--list-tips" },
	{ specifier: "./cli/session-picker.js", branch: "--resume" },
] as const;

/** Subgraphs no other startup module reaches: once main defers them, nothing loads them. */
const FORBIDDEN_SUBGRAPHS = [
	{ pattern: /\/dist\/modes\/rpc\/multi-session-host\.js$/u, owner: "--mode rpc --multi-session" },
	{ pattern: /\/dist\/package-manager-cli\.js$/u, owner: "the package-manager commands" },
] as const;

const APP_SERVER_SUBGRAPH = /\/dist\/modes\/app-server\//u;

/**
 * The single app-server module the package barrel still drags in through
 * `core/extensions/loader.ts` -> `index.ts` -> `modes/index.ts` -> `rpc/host-ensure.ts`. That edge
 * is owned outside this lane; allow it rather than pin it, so closing it elsewhere keeps this green.
 */
const APP_SERVER_BARREL_RESIDUAL = /\/dist\/modes\/app-server\/daemon\/process\.js$/u;

describe("main() lazy command and mode graphs", () => {
	it("keeps command/mode-only modules out of the dist/main.js static import graph", () => {
		const result = probeImportGraph(repoRoot, `${repoRoot}/packages/coding-agent/dist/main.js`);

		// Guards the probe itself: a graph this small means the walk failed, not that the CLI got
		// lean, and every assertion below would pass vacuously.
		expect(result.entries.length).toBeGreaterThan(500);

		// Soft assertions: every pin below is independent, so one reintroduced import must not hide
		// the others from the failure report.
		for (const { specifier, branch } of DEFERRED_SPECIFIERS) {
			const resolved = result.entries.filter((entry) => entry.specifier === specifier);
			expect
				.soft(
					resolved.map((entry) => entry.url),
					`dist/main.js statically imports ${specifier}; it must be awaited at ${branch}`,
				)
				.toEqual([]);
		}

		for (const { pattern, owner } of FORBIDDEN_SUBGRAPHS) {
			const reached = result.entries.filter((entry) => pattern.test(entry.url)).map((entry) => entry.url);
			expect
				.soft(reached, `${pattern.source} is reachable from dist/main.js but is only used by ${owner}`)
				.toEqual([]);
		}

		const appServer = result.entries
			.filter((entry) => APP_SERVER_SUBGRAPH.test(entry.url) && !APP_SERVER_BARREL_RESIDUAL.test(entry.url))
			.map((entry) => entry.url);
		expect
			.soft(
				[...new Set(appServer)].length,
				`the app-server tree is reachable from dist/main.js outside the package barrel: ${[...new Set(appServer)].slice(0, 3).join(", ")}`,
			)
			.toBe(0);
	});

	it("scans for the same supervisor sentinel the host lifecycle defines", () => {
		// The route module copies the literal so the sentinel scan does not import the module it
		// defers; this is what keeps the copy honest.
		expect(INTERNAL_SUPERVISOR_ROUTE_FLAG).toBe(INTERNAL_SUPERVISOR_FLAG);
	});
});
