/**
 * omo#12965, T-F: `pi.engine` is the engine an extension runs in. A plugin that needs the running engine's exports
 * reads them there instead of importing `@code-yeongyu/senpi`, whose import can evaluate a second engine copy.
 * Public extension API contract: on Node and on Bun every export of `pi.engine` is the same value as the export the
 * loader serves the extension for that specifier, and the property cannot be reassigned. The namespace object itself
 * is not compared: Bun's object loader hands each importer a fresh namespace object over the same exports.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const LOADER = fileURLToPath(new URL("../../src/core/extensions/loader.ts", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const EXTENSION = `import * as served from "@code-yeongyu/senpi";

export default function (pi: { engine: Record<string, unknown> }) {
	const engine = pi.engine;
	const names = Object.keys(served);
	let assignment = "assigned";
	try {
		(pi as { engine: unknown }).engine = {};
	} catch (error) {
		assignment = error instanceof TypeError ? "TypeError" : "other error";
	}
	(globalThis as Record<string, unknown>).__piEngineProbe = {
		exports: names.length,
		missingFromEngine: names.filter((name) => !(name in engine)),
		differing: names.filter((name) => (served as Record<string, unknown>)[name] !== engine[name]),
		hasCreateAgentSession: typeof engine.createAgentSession === "function",
		assignment,
		unchangedAfterAssignment: pi.engine === engine,
	};
}
`;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function probe(runtime: "node" | "bun"): Record<string, unknown> {
	const root = mkdtempSync(join(tmpdir(), "senpi-pi-engine-"));
	roots.push(root);
	writeFileSync(join(root, "extension.ts"), EXTENSION);
	writeFileSync(
		join(root, "main.mts"),
		[
			`import { loadExtensions } from ${JSON.stringify(LOADER)};`,
			`const result = await loadExtensions([${JSON.stringify(join(root, "extension.ts"))}], ${JSON.stringify(root)});`,
			"process.stdout.write(JSON.stringify({ errors: result.errors, probe: globalThis.__piEngineProbe }));",
			"process.exit(0);",
		].join("\n"),
	);
	const [command, args] =
		runtime === "bun"
			? ["bun", [join(root, "main.mts")]]
			: [process.execPath, ["--import", "tsx", join(root, "main.mts")]];
	const output = execFileSync(command, args, { cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 170_000 });
	return JSON.parse(output) as Record<string, unknown>;
}

describe("pi.engine (omo#12965, T-F)", () => {
	it.each(["node", "bun"] as const)(
		"on %s gives an extension the exports the loader serves for the engine specifier, read-only",
		(runtime) => {
			const result = probe(runtime);

			expect(result.errors).toEqual([]);
			expect(result.probe).toMatchObject({
				missingFromEngine: [],
				differing: [],
				hasCreateAgentSession: true,
				assignment: "TypeError",
				unchangedAfterAssignment: true,
			});
			expect((result.probe as { exports: number }).exports).toBeGreaterThan(0);
		},
		180_000,
	);
});
