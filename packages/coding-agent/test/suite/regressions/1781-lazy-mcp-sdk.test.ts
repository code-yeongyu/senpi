/**
 * #1781 — the MCP SDK must not be part of the CLI startup import graph.
 *
 * `@modelcontextprotocol/sdk` is 210 files / ~1.16 MB that every `senpi` start
 * parsed, compiled and evaluated because the mcp builtin (`builtin/mcp/`) is
 * statically reachable from the builtin barrel — even though nothing touches
 * the SDK until a run actually connects to, attaches or authenticates against
 * an MCP server. Those paths are async, so the SDK belongs behind the lazy
 * boundary in `builtin/mcp/sdk.lazy.ts`.
 *
 * The probe is Node's own loader hook, not a source scan: it records what the
 * runtime really resolves, so a deferred `await import(...)` is absent by
 * construction while any reintroduced top-level edge — direct or transitive,
 * through any re-export chain — reappears and fails this test.
 */
import { describe, expect, it } from "vitest";
import { probeImportGraph } from "../../helpers/esm-import-graph-probe.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const repoRoot = new URL("../../../../..", import.meta.url).pathname;

/** Matches the package root so a transitive edge cannot slip through under a different specifier. */
const MCP_SDK_PATTERN = /\/node_modules\/@modelcontextprotocol\//u;

describe("#1781 lazy MCP SDK", () => {
	it("does not statically reach @modelcontextprotocol/sdk from dist/main.js", () => {
		const result = probeImportGraph(repoRoot, `${repoRoot}/packages/coding-agent/dist/main.js`);

		// Guards the probe itself: a graph this small means the walk failed, not
		// that the CLI got lean, and the assertion below would pass vacuously.
		expect(result.entries.length).toBeGreaterThan(500);

		const reached = result.entries.filter((entry) => MCP_SDK_PATTERN.test(entry.url));
		expect(
			[...new Set(reached.map((entry) => entry.url))],
			"@modelcontextprotocol/sdk is statically reachable from dist/main.js; it must stay behind the lazy boundary owned by core/extensions/builtin/mcp/sdk.lazy.ts",
		).toEqual([]);
	});
});
