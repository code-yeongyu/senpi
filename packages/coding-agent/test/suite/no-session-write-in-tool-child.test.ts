// senpi#3566 todo 4: the server is the single writer of every session file; the tool child's import graph reaches no
// session-writing module (architecture contract). The walk follows static and dynamic relative imports and worker entries.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");
const ROOTS = ["src/tool-child-main.ts"];
const FORBIDDEN = [
	"src/core/session-manager.ts",
	"src/core/agent-session.ts",
	"src/core/agent-session-runtime.ts",
	"src/core/session-write-recovery.ts",
	"src/core/sdk.ts",
	"src/main.ts",
	// The extension loader statically imports the package barrel, which reaches every session writer; the child loads
	// modules through the Bun extension importer directly (module job), never through these.
	"src/core/extensions/loader.ts",
	"src/index.ts",
];

type AstNode = { readonly type: string };

function isAstNode(value: unknown): value is AstNode {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function stringLiteral(value: unknown): string | undefined {
	if (!isAstNode(value) || value.type !== "Literal") return undefined;
	const literal: unknown = Reflect.get(value, "value");
	return typeof literal === "string" ? literal : undefined;
}

function isImportMetaUrl(value: unknown): boolean {
	if (!isAstNode(value) || value.type !== "MemberExpression") return false;
	const object: unknown = Reflect.get(value, "object");
	const property: unknown = Reflect.get(value, "property");
	return (
		isAstNode(object) &&
		object.type === "MetaProperty" &&
		isAstNode(property) &&
		Reflect.get(property, "name") === "url"
	);
}

/**
 * The module a statement or expression loads at runtime, if any. Decided per node of the parsed file, so a comment
 * never counts and a type-only statement (`import type`, `export type ... from`, senpi#3566 todo 9 and senpi#6486)
 * is exempt while another statement naming the same module is still followed. `typeof import("./x.ts")` parses as a
 * type node, not an import expression, so it is erased too. Worker entries are started with
 * `new URL("./x.ts", import.meta.url)` or `siblingWorkerUrl("./x.ts", import.meta.url)`, so they count as loads.
 */
function loadedSpecifier(node: AstNode): string | undefined {
	switch (node.type) {
		case "ImportDeclaration":
			return Reflect.get(node, "importKind") === "type" ? undefined : stringLiteral(Reflect.get(node, "source"));
		case "ExportNamedDeclaration":
		case "ExportAllDeclaration":
			return Reflect.get(node, "exportKind") === "type" ? undefined : stringLiteral(Reflect.get(node, "source"));
		case "ImportExpression":
			return stringLiteral(Reflect.get(node, "source"));
		case "NewExpression":
		case "CallExpression": {
			const callee: unknown = Reflect.get(node, "callee");
			const name = isAstNode(callee) ? Reflect.get(callee, "name") : undefined;
			const args: unknown = Reflect.get(node, "arguments");
			if ((name !== "URL" && name !== "siblingWorkerUrl") || !Array.isArray(args) || !isImportMetaUrl(args[1]))
				return undefined;
			return stringLiteral(args[0]);
		}
		default:
			return undefined;
	}
}

function loadedSpecifiers(file: string, source: string): string[] {
	const specifiers: string[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		if (isAstNode(value)) {
			const specifier = loadedSpecifier(value);
			if (specifier !== undefined) specifiers.push(specifier);
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(parseSync(file, source).program);
	return specifiers;
}

function reachable(
	roots: readonly string[],
	root: string = packageRoot,
	readSource: (file: string) => string = (file) => readFileSync(file, "utf8"),
): Set<string> {
	const seen = new Set<string>();
	const queue = roots.map((entry) => resolve(root, entry));
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || seen.has(file)) continue;
		seen.add(file);
		for (const specifier of loadedSpecifiers(file, readSource(file))) {
			if (/^\.{1,2}\//.test(specifier) && specifier.endsWith(".ts")) queue.push(resolve(dirname(file), specifier));
		}
	}
	return new Set([...seen].map((file) => relative(root, file)));
}

// senpi#6486: a type-only import of a module must not hide another statement in the same file that loads it.
describe("the import walk", () => {
	const fixtureRoot = resolve("/fixture");
	function reachesWriter(mid: string): boolean {
		const files = new Map([
			[resolve(fixtureRoot, "root.ts"), 'import { run } from "./mid.ts";\n'],
			[resolve(fixtureRoot, "mid.ts"), mid],
			[resolve(fixtureRoot, "writer.ts"), "export function write(): void {}\n"],
		]);
		return reachable(["root.ts"], fixtureRoot, (file) => files.get(file) ?? "").has("writer.ts");
	}

	it.each([
		{ name: "a value import", mid: 'import { write } from "./writer.ts";\n', reaches: true },
		{ name: "a type-only import", mid: 'import type { W } from "./writer.ts";\n', reaches: false },
		{
			name: "a type-only import and a value import",
			mid: 'import type { W } from "./writer.ts";\nimport { write } from "./writer.ts";\n',
			reaches: true,
		},
		{
			name: "a type-only import and a dynamic import",
			mid: 'import type { W } from "./writer.ts";\nexport async function run(): Promise<void> {\n\tawait import("./writer.ts");\n}\n',
			reaches: true,
		},
		{ name: "a type-only re-export", mid: 'export type { W } from "./writer.ts";\n', reaches: false },
		{
			name: "a type-only import after a comment ending in export",
			mid: '// helpers we export\nimport type { W } from "./writer.ts";\n',
			reaches: false,
		},
	])("follows $name: $reaches", ({ mid, reaches }) => {
		expect(reachesWriter(mid)).toBe(reaches);
	});
});

describe("the tool child never writes a session", () => {
	const graph = reachable(ROOTS);

	it("walks the tool child's real graph", () => {
		expect(graph.has("src/internal-role.ts")).toBe(true);
		expect(graph.has("src/modes/rpc/tool-child/entry.ts")).toBe(true);
		expect(graph.has("src/modes/rpc/tool-child/channel.ts")).toBe(true);
		expect(graph.has("src/modes/rpc/tool-child/module-job-worker.ts")).toBe(true);
		expect(graph.has("src/core/extensions/bun-extension-importer.ts")).toBe(true);
	});

	it("reaches no session-writing module", () => {
		expect(FORBIDDEN.filter((file) => graph.has(file))).toEqual([]);
	});
});
