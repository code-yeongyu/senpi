import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const importerPath = fileURLToPath(new URL("../../../src/core/extensions/bun-extension-importer.ts", import.meta.url));
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runBun(root: string, scenario: string): string {
	return execFileSync(
		"bun",
		[
			"--eval",
			`
import { join } from "node:path";
import { createBunExtensionImporter } from ${JSON.stringify(importerPath)};
const root = ${JSON.stringify(root)};
${scenario}
`,
		],
		{ cwd: root, encoding: "utf8", timeout: 30_000 },
	);
}

// senpi#6199: a host compiles an extension graph on its own loop (the boot load of senpi#6147, a warm, an open).
// Bun fetches a whole static graph inside one microtask drain, so a load that never yields held the loop for every
// module and a client's 2 s auth handshake starved behind it.
describe("extension graph import and the host loop (senpi#6199)", () => {
	it("loads at most one module per event-loop turn while an import is in flight", () => {
		// Given: an extension whose static graph has 24 local modules.
		const root = mkdtempSync(join(tmpdir(), "senpi-6199-"));
		roots.push(root);
		const helpers = Array.from({ length: 24 }, (_, index) => `helper-${index}.ts`);
		for (const [index, helper] of helpers.entries())
			writeFileSync(join(root, helper), `export const value: number = ${index};\n`);
		writeFileSync(
			join(root, "extension.ts"),
			`${helpers.map((helper, index) => `import { value as v${index} } from "./${helper}";`).join("\n")}
export default () => [${helpers.map((_, index) => `v${index}`).join(", ")}].length;
`,
		);

		// When: a turn-by-turn probe records how many modules the importer had loaded at each turn of the loop.
		const output = runBun(
			root,
			`
const importer = createBunExtensionImporter({});
const loadedAtTurn = [];
let settled = false;
const probe = () => {
	loadedAtTurn.push(importer.compiledSources().size);
	if (!settled) setImmediate(probe);
};
setImmediate(probe);
const factory = await importer.import(join(root, "extension.ts"), { default: true });
settled = true;
loadedAtTurn.push(importer.compiledSources().size);
console.log(JSON.stringify({ modules: factory(), loadedAtTurn }));
`,
		);

		// Then: the loop turned between module loads instead of once after the whole graph.
		const { modules, loadedAtTurn } = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
			modules: number;
			loadedAtTurn: number[];
		};
		expect(modules).toBe(24);
		expect(loadedAtTurn.at(-1)).toBe(25);
		const largestStep = Math.max(...loadedAtTurn.map((loaded, turn) => loaded - (loadedAtTurn[turn - 1] ?? 0)));
		expect(largestStep).toBe(1);
	});

	it("still serves a synchronous require of a graph module", () => {
		// Given: a CommonJS dependency that requires a sibling while it evaluates.
		const root = mkdtempSync(join(tmpdir(), "senpi-6199-cjs-"));
		roots.push(root);
		writeFileSync(join(root, "leaf.cjs"), "module.exports = { leaf: 'leaf' };\n");
		writeFileSync(join(root, "middle.cjs"), "module.exports = { middle: require('./leaf.cjs').leaf };\n");
		writeFileSync(
			join(root, "extension.ts"),
			'import middle from "./middle.cjs";\nexport default () => middle.middle;\n',
		);

		// When
		const output = runBun(
			root,
			`
const importer = createBunExtensionImporter({});
const factory = await importer.import(join(root, "extension.ts"), { default: true });
console.log(JSON.stringify(factory()));
`,
		);

		// Then
		expect(output.trim().split("\n").at(-1)).toBe('"leaf"');
	});
});
