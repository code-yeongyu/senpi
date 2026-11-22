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

function extensionRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-6208-"));
	roots.push(root);
	const helpers = Array.from({ length: 24 }, (_, index) => `helper-${index}.ts`);
	for (const [index, helper] of helpers.entries())
		writeFileSync(join(root, helper), `export const value: number = ${index};\n`);
	writeFileSync(
		join(root, "extension.ts"),
		`${helpers.map((helper, index) => `import { value as v${index} } from "./${helper}";`).join("\n")}
export const total = () => [${helpers.map((_, index) => `v${index}`).join(", ")}].length;
export default total;
`,
	);
	return root;
}

/** Starts an import from an importer nobody keeps, and collects garbage on every loop turn until it settles. */
function importWithCollection(root: string, start: string): string {
	const output = execFileSync(
		"bun",
		[
			"--eval",
			`
import { join } from "node:path";
import { createBunExtensionImporter } from ${JSON.stringify(importerPath)};
const root = ${JSON.stringify(root)};
const start = () => ${start};
let settled = false;
const pending = start().finally(() => {
	settled = true;
});
const collect = () => {
	Bun.gc(true);
	if (!settled) setImmediate(collect);
};
setImmediate(collect);
try {
	console.log(JSON.stringify({ modules: await pending }));
} catch (error) {
	console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
`,
		],
		{ cwd: root, encoding: "utf8", timeout: 30_000 },
	);
	return output.trim().split("\n").at(-1) ?? "";
}

// senpi#6208: since senpi#6199 an import serves one module per loop turn, and the registry holds a graph only weakly.
// The tool child's module job drops its importer as soon as importNamespace returns, so a collection between two
// turns took the graph and failed the job with "Extension generation 0 has been disposed".
describe("an extension graph stays alive while an import is in flight (senpi#6208)", () => {
	it("completes importNamespace when the caller drops the importer and garbage is collected between loads", () => {
		// Given: a 25-module extension graph.
		const root = extensionRoot();

		// When: the importer is dropped right after the import starts and every loop turn forces a full collection.
		const result = importWithCollection(
			root,
			`createBunExtensionImporter({}).importNamespace(join(root, "extension.ts")).then((namespace) => namespace.total())`,
		);

		// Then
		expect(result).toBe('{"modules":24}');
	});

	it("completes a default import under the same collection pressure", () => {
		// Given
		const root = extensionRoot();

		// When
		const result = importWithCollection(
			root,
			`createBunExtensionImporter({}).import(join(root, "extension.ts"), { default: true }).then((factory) => factory())`,
		);

		// Then
		expect(result).toBe('{"modules":24}');
	});
});
