/**
 * Startup static-import-graph regression guard.
 *
 * Importing `dist/main.js` is ~70% of CLI boot wall time, and every package
 * statically reachable from it is parsed, compiled and evaluated before the
 * first frame renders — whether or not the run ever uses that package. The
 * modules asserted here are used only inside call-time code paths (a webfetch
 * tool invocation, a Claude-SDK-OAuth stream), so they belong behind the
 * repository's documented lazy boundaries and must stay there.
 *
 * The probe is Node's own loader hook, not a source scan: it records what the
 * runtime really resolves, so a deferred `await import(...)` is absent by
 * construction while any reintroduced top-level edge — direct or transitive,
 * through any re-export chain — reappears and fails this test.
 */
import { describe, expect, it } from "vitest";
import { probeImportGraph } from "./helpers/esm-import-graph-probe.ts";
import { assertWorkspaceBuildPrerequisite } from "./support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const repoRoot = new URL("../../..", import.meta.url).pathname;

/**
 * Packages whose cost is paid on every start today and is wasted unless the
 * run actually reaches the owning feature. `pattern` matches the resolved URL
 * so a transitive edge cannot slip through under a different specifier.
 */
const DEFERRED_STARTUP_PACKAGES = [
	{
		specifier: "jsdom",
		pattern: /\/node_modules\/jsdom\//u,
		owner: "webfetch HTML conversion (core/extensions/builtin/webfetch/webfetch/content.lazy.ts)",
	},
	{
		specifier: "@anthropic-ai/claude-agent-sdk",
		pattern: /\/node_modules\/@anthropic-ai\/claude-agent-sdk\/sdk\.mjs$/u,
		owner: "claude-sdk-oauth streaming lane (core/extensions/builtin/claude-sdk-oauth/sdk-boundary.lazy.ts)",
	},
] as const;

describe("CLI startup import graph", () => {
	it("does not statically reach deferred heavy packages from dist/main.js", () => {
		const result = probeImportGraph(repoRoot, `${repoRoot}/packages/coding-agent/dist/main.js`);

		// Guards the probe itself: a graph this small means the walk failed, not
		// that the CLI got lean, and every assertion below would pass vacuously.
		expect(result.entries.length).toBeGreaterThan(500);

		for (const { specifier, pattern, owner } of DEFERRED_STARTUP_PACKAGES) {
			const reached = result.entries.filter((entry) => entry.specifier === specifier || pattern.test(entry.url));
			expect(
				reached.map((entry) => entry.url),
				`${specifier} is statically reachable from dist/main.js; it must stay behind the lazy boundary owned by ${owner}`,
			).toEqual([]);
		}
	});
});
