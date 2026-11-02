/**
 * Keep @earendil-works/pi-pty and @xterm/headless off the CLI startup graph.
 *
 * Importing `dist/main.js` is ~70% of CLI boot wall time. pi-pty's screen
 * model evaluates `@xterm/headless` at module load (~458ms in
 * `RegExp.prototype.test`) even when the run never creates a terminal session.
 * Those packages belong behind the terminal builtin's deferred import
 * (`core/extensions/builtin/terminal/pty.lazy.ts`) and must stay there.
 *
 * The probe is Node's own loader hook, not a source scan: a deferred
 * `await import(...)` is absent by construction while any reintroduced
 * top-level edge — direct or transitive, through any re-export chain —
 * reappears and fails this test.
 */
import { describe, expect, it } from "vitest";
import { probeImportGraph } from "../../helpers/esm-import-graph-probe.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const repoRoot = new URL("../../../../..", import.meta.url).pathname;

describe("CLI startup import graph — lazy pi-pty", () => {
	it("does not statically reach pi-pty or @xterm/headless from dist/main.js", () => {
		const result = probeImportGraph(repoRoot, `${repoRoot}/packages/coding-agent/dist/main.js`);

		// Guards the probe itself: a graph this small means the walk failed, not
		// that the CLI got lean, and every assertion below would pass vacuously.
		expect(result.entries.length).toBeGreaterThan(500);

		const xtermReached = result.entries.filter((entry) => /\/node_modules\/@xterm\/headless\//u.test(entry.url));
		expect(
			xtermReached.map((entry) => entry.url),
			"@xterm/headless is statically reachable from dist/main.js; it must stay behind builtin/terminal/pty.lazy.ts",
		).toEqual([]);

		const ptyReached = result.entries.filter((entry) => /\/packages\/pty\/dist\//u.test(entry.url));
		expect(
			ptyReached.map((entry) => entry.url),
			"@earendil-works/pi-pty is statically reachable from dist/main.js; it must stay behind builtin/terminal/pty.lazy.ts",
		).toEqual([]);
	});
});
