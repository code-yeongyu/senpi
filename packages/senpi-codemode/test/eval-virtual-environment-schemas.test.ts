import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { virtualEvalSchema, virtualEvalSchemaNames } from "../src/bridges/eval-virtual-schemas.ts";

const SRC = join(import.meta.dirname, "..", "src");
const DOCUMENTED_CODE = /\b(environment_[a-z_]+|eval_isolate_[a-z_]+)\b/g;
const CODE = "(?:environment|eval_isolate)_[a-z_]+";
// The only places a code is raised: an EnvironmentError constructed with it (the code may sit on the next line), an
// entry of a kind-to-code table, a `return "<code>"` from a classifier, and an error or result text it prefixes. A comparison, a list or a type member
// does not raise anything, so it is not matched.
const RAISE_SITES = [
	new RegExp(`new EnvironmentError\\(\\s*"(${CODE})"`, "g"),
	new RegExp(`^\\s*[a-z]+: "(${CODE})",\\s*$`, "gm"),
	new RegExp(`\\breturn "(${CODE})";`, "g"),
	new RegExp(`\\bsuper\\(\\s*\`(${CODE}): `, "g"),
	new RegExp(`\`; (${CODE}): `, "g"),
];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "vendor" ? [] : sourceFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function emittedCodes(): Set<string> {
	const codes = new Set<string>();
	for (const file of sourceFiles(SRC)) {
		if (file.endsWith("eval-environment-schemas.ts")) continue;
		const source = withoutComments(readFileSync(file, "utf8"));
		for (const site of RAISE_SITES) for (const match of source.matchAll(site)) if (match[1]) codes.add(match[1]);
	}
	return codes;
}

function propertiesOf(parameters: unknown): Record<string, unknown> {
	if (typeof parameters !== "object" || parameters === null || !("properties" in parameters))
		throw new Error(`expected parameters with properties, got ${JSON.stringify(parameters)}`);
	const properties: unknown = parameters.properties;
	if (typeof properties !== "object" || properties === null) throw new Error("parameters.properties is not an object");
	return Object.fromEntries(Object.entries(properties));
}

function entry(name: string): { readonly name: string; readonly description: string; readonly parameters: unknown } {
	const found = virtualEvalSchema(name);
	if (found === undefined || !("name" in found) || found.description === undefined)
		throw new Error(`${name} is not a documented schema entry`);
	return { name: found.name, description: found.description, parameters: found.parameters };
}

describe("tool_schema('eval:*') virtual entries", () => {
	it("are exactly the five documented names", () => {
		const names = ["eval:wait", "eval:helpers", "eval:kernel-tools", "eval:environments", "eval:isolation"];
		expect([...virtualEvalSchemaNames()].sort()).toEqual([...names].sort());
		for (const name of names) expect(entry(name).name).toBe(name);
		expect(virtualEvalSchema("eval:environment")).toBeUndefined();
		expect(virtualEvalSchema("eval:isolate")).toBeUndefined();
	});

	it("document the magics, %load and the environment modes", () => {
		const { description, parameters } = entry("eval:environments");
		for (const text of ["%pip install", "%bun add", "%npm add", "%environment managed | project", "%load", "8 MiB"]) {
			expect(description).toContain(text);
		}
		expect(Object.keys(propertiesOf(parameters))).toEqual([
			"%pip",
			"%bun",
			"%npm",
			"%environment",
			"%load",
			"packages.install",
		]);
	});

	it("document packages.install with its signature, managers, receipt and codes", () => {
		const { description, parameters } = entry("eval:environments");
		for (const text of [
			"packages.install(manager, requirements, {timeout?})",
			'"pip"',
			'"bun"',
			'"npm"',
			"timeout=",
			"600",
			"manager, mode, root, revision, requested, resolved, changed",
			"installer, mode, revision, added, shadowed",
			"stop",
			"environment_install_timeout",
		]) {
			expect(description).toContain(text);
		}
		const properties = propertiesOf(parameters);
		expect(properties["packages.install"]).toEqual({
			description: "js and py: packages.install(manager, requirements, {timeout?}) (py: timeout=...)",
		});
	});

	it("document isolate, its refusals and the sandbox limits", () => {
		const { description } = entry("eval:isolation");
		for (const text of [
			"isolate: true",
			"sandbox.enabled",
			"eval_isolate_invalid",
			"SENPI_CODEMODE_SANDBOX_MEMORY_MB",
		]) {
			expect(description).toContain(text);
		}
	});

	it("name only error codes the source actually emits", () => {
		const emitted = emittedCodes();
		for (const name of ["eval:environments", "eval:isolation"]) {
			const documented = [...entry(name).description.matchAll(DOCUMENTED_CODE)].map((match) => match[1]);
			expect(documented.length).toBeGreaterThan(0);
			expect(documented.filter((code) => code !== undefined && !emitted.has(code))).toEqual([]);
		}
	});

	it("document every error code the source raises", () => {
		const emitted = emittedCodes();
		const documented = new Set(
			[entry("eval:environments"), entry("eval:isolation")].flatMap(({ description }) =>
				[...description.matchAll(DOCUMENTED_CODE)].map((match) => match[1]),
			),
		);
		expect([...emitted].filter((code) => !documented.has(code))).toEqual([]);
	});

	it("keep each code in the entry that owns it", () => {
		const environmentCodes = [...entry("eval:environments").description.matchAll(DOCUMENTED_CODE)].map((m) => m[1]);
		const isolationCodes = [...entry("eval:isolation").description.matchAll(DOCUMENTED_CODE)].map((m) => m[1]);
		expect(environmentCodes.every((code) => code?.startsWith("environment_"))).toBe(true);
		expect(isolationCodes.every((code) => code?.startsWith("eval_isolate_"))).toBe(true);
	});
});
