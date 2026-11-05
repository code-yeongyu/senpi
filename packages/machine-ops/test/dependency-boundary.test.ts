import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Architecture contract: machine-ops sits below the agent engine. A remote executor pins it without pulling in
// packages/agent or packages/coding-agent, so its sources may import only node/bun builtins, the pty package and
// themselves.
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const ALLOWED = [/^node:/, /^bun:/, /^@earendil-works\/pi-pty$/, /^\.\.?\//];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sourceFiles(join(dir, entry.name))
			: entry.name.endsWith(".ts")
				? [join(dir, entry.name)]
				: [],
	);
}

/** A module specifier in double quotes, single quotes or a template literal without substitutions. */
const QUOTED = String.raw`(?:"([^"\n]+)"|'([^'\n]+)'|\`([^\`$]+)\`)`;
const IMPORT_FORMS = [
	// import x from "m"; import type { x } from "m"; export { x } from "m"; export * from "m" (also multi-line).
	new RegExp(String.raw`(?:^|[\n;])\s*(?:import|export)\b[^;]*?\bfrom\s*${QUOTED}`, "g"),
	// import "m"; (side-effect import)
	new RegExp(String.raw`(?:^|[\n;])\s*import\s*${QUOTED}`, "g"),
	// import("m") and require("m")
	new RegExp(String.raw`\b(?:import|require)\s*\(\s*${QUOTED}\s*\)`, "g"),
];

function specifiers(source: string): string[] {
	const found: string[] = [];
	for (const form of IMPORT_FORMS) {
		for (const match of source.matchAll(form)) found.push(match[1] ?? match[2] ?? match[3]);
	}
	return found;
}

function offenders(source: string): string[] {
	return specifiers(source).filter((specifier) => !ALLOWED.some((pattern) => pattern.test(specifier)));
}

// Negative controls: each way a source file can load a module, naming a package the boundary forbids.
const FORBIDDEN = "@earendil-works/pi-agent-core";
const FORBIDDEN_FORMS: readonly (readonly [string, string])[] = [
	["named import", `import { Agent } from "${FORBIDDEN}";`],
	["multi-line type import", `import type {\n\tAgent,\n\tTool,\n} from '${FORBIDDEN}';`],
	["side-effect import", `import "${FORBIDDEN}";`],
	["single-quoted side-effect import", `import '${FORBIDDEN}';`],
	["export-from", `export { Agent } from "${FORBIDDEN}";`],
	["export-star", `export * from "${FORBIDDEN}";`],
	["require", `const core = require("${FORBIDDEN}");`],
	["dynamic import", `const core = await import("${FORBIDDEN}");`],
	["dynamic import of a template literal", `const core = await import(\`${FORBIDDEN}\`);`],
];

describe("machine-ops dependency boundary", () => {
	it("imports nothing outside node/bun builtins, the pty package and itself", () => {
		const found = sourceFiles(SRC).flatMap((file) =>
			offenders(readFileSync(file, "utf8")).map((specifier) => `${file}: ${specifier}`),
		);
		expect(found).toEqual([]);
	});

	it.each(FORBIDDEN_FORMS)("the scan catches a forbidden %s", (_form, source) => {
		expect(offenders(source)).toEqual([FORBIDDEN]);
	});

	it("the scan passes allowed specifiers in every form", () => {
		const allowed = [
			`import { readFile } from "node:fs/promises";`,
			`import "./local.ts";`,
			`export * from "../types.ts";`,
			`const pty = require("@earendil-works/pi-pty");`,
			"const sqlite = await import(`bun:sqlite`);",
		].join("\n");
		expect(specifiers(allowed)).toHaveLength(5);
		expect(offenders(allowed)).toEqual([]);
	});

	it("declares no dependency on the agent or coding-agent packages", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@earendil-works/pi-pty"]);
	});
});
