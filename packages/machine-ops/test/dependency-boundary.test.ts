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

function specifiers(source: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)) found.push(match[1]);
	for (const match of source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) found.push(match[1]);
	return found;
}

describe("machine-ops dependency boundary", () => {
	it("imports nothing outside node/bun builtins, the pty package and itself", () => {
		const offenders = sourceFiles(SRC).flatMap((file) =>
			specifiers(readFileSync(file, "utf8"))
				.filter((specifier) => !ALLOWED.some((pattern) => pattern.test(specifier)))
				.map((specifier) => `${file}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("declares no dependency on the agent or coding-agent packages", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@earendil-works/pi-pty"]);
	});
});
