// Run by Bun (not Vitest): bundles one entry for a browser target and prints a JSON report of every Node or
// Bun builtin the module graph reached. Bun inlines browser polyfills for some builtins (`path`, `url`, `os`),
// so the resolver hook records each builtin before Bun can substitute it.
import { builtinModules } from "node:module";
import { relative } from "node:path";

interface ResolveArgs {
	path: string;
	importer: string;
	kind: string;
}
// Keep the Node type check independent of Bun's ambient declarations (as test/fixtures/qa-tools/spawn-fixture.ts does).
declare const Bun: {
	build(options: {
		entrypoints: string[];
		target: "browser";
		format: "esm";
		throw: false;
		plugins: {
			name: string;
			setup(build: {
				onResolve(
					options: { filter: RegExp },
					callback: (args: ResolveArgs) => { path: string; external: true } | undefined,
				): void;
			}): void;
		}[];
	}): Promise<{
		success: boolean;
		outputs: { text(): Promise<string> }[];
		logs: { level: string; message: unknown }[];
	}>;
};

const entry = process.argv[2];
if (entry === undefined) throw new Error("usage: bun bundle-browser.ts <entry>");

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const isBuiltin = (specifier: string) =>
	builtins.has(specifier) || specifier.startsWith("node:") || specifier.startsWith("bun:");
const repoRelative = (path: string) => relative(process.cwd(), path).replaceAll("\\", "/");

// The structural read folder reaches its grammar engine through one lazy import() that only a wasm language
// selection triggers; a failed import falls back to the heuristic folder (see scripts/check-browser-smoke.mjs).
const lazyGrammarEngine = /(?:^|[/\\])tree-sitter[/\\]engine\.ts$/;
const readFoldersDir = /packages[/\\]agent[/\\]src[/\\]harness[/\\]utils[/\\]read-folders[/\\]/;

const reachedBuiltins: string[] = [];
const lazyExternals: string[] = [];
const result = await Bun.build({
	entrypoints: [entry],
	target: "browser",
	format: "esm",
	throw: false,
	plugins: [
		{
			name: "record-builtins",
			setup(build) {
				build.onResolve({ filter: /.*/ }, (args) => {
					if (isBuiltin(args.path)) {
						reachedBuiltins.push(`${args.path} <- ${repoRelative(args.importer)}`);
						return { path: args.path, external: true };
					}
					if (
						args.kind === "dynamic-import" &&
						lazyGrammarEngine.test(args.path) &&
						readFoldersDir.test(args.importer)
					) {
						lazyExternals.push(args.path);
						return { path: args.path, external: true };
					}
					return undefined;
				});
			},
		},
	],
});

const output = result.success ? await result.outputs[0]?.text() : undefined;
const specifiers = output
	? [...output.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map(
			(match) => match[1] ?? "",
		)
	: [];

// A Worker without Node compatibility has neither global; `machine.ops.process` and the op name "process.exec" are not it.
const nodeGlobals = output
	? [...new Set([...output.matchAll(/(?<![.\w$"'`])(Buffer|process)\s*\./g)].map((match) => match[1] ?? ""))].sort()
	: [];

console.log(
	JSON.stringify({
		success: result.success,
		errors: result.logs.filter((log) => log.level === "error").map((log) => String(log.message)),
		reachedBuiltins: [...new Set(reachedBuiltins)].sort(),
		builtinImportsInOutput: [...new Set(specifiers.filter(isBuiltin))].sort(),
		lazyExternals: [...new Set(lazyExternals)],
		nodeGlobals,
	}),
);
