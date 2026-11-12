// senpi#3566 todo 4: the server is the single writer of every session file; the tool child's import graph reaches no
// session-writing module (architecture contract). The walk follows static and dynamic relative imports and worker entries.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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
// Worker entries are started with `new URL("./x.ts", import.meta.url)`, so they are part of the child's graph too.
const SPECIFIER =
	/(?:new\s+URL|siblingWorkerUrl)\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url|(?:import|export)\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|import\s+["'](\.{1,2}\/[^"']+)["']/g;
// `import type` is erased at runtime, so it pulls nothing into the child's module graph (senpi#3566 todo 9: the
// terminal job bodies import their tool schemas, whose type imports reach the extension types barrel).
const TYPE_SPECIFIER = /import\s+type\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']/g;

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
		const source = readSource(file);
		// Only the `import type` statement itself is exempt (senpi#6486): another statement naming the same module
		// still loads it, so the exemption is keyed by where the statement starts, never by the module it names.
		const typeOnlyStatements = new Set<number>();
		for (const match of source.matchAll(TYPE_SPECIFIER)) typeOnlyStatements.add(match.index);
		for (const match of source.matchAll(SPECIFIER)) {
			if (typeOnlyStatements.has(match.index)) continue;
			const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
			if (specifier?.endsWith(".ts")) queue.push(resolve(dirname(file), specifier));
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
