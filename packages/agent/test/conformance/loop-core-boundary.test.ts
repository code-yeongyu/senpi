// senpi#4996: architecture contract R1.e / C1.a / R6.d / R9.a, not a source-text snapshot.
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import * as ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { LOOP_CORE_EXTERNAL_MODULES, LOOP_CORE_MODULES } from "../../src/conformance/loop-core-manifest.ts";

const modules: ReadonlySet<string> = new Set(LOOP_CORE_MODULES);
const externalModules: ReadonlySet<string> = new Set(LOOP_CORE_EXTERNAL_MODULES);
// Calls whose first argument names a module to load or resolve (senpi#5171).
const moduleCallees: ReadonlySet<string> = new Set([
	"require",
	"require.resolve",
	"module.require",
	"process.getBuiltinModule",
	"import.meta.resolve",
	"import.meta.require",
]);

function calleeName(expression: ts.Expression): string | undefined {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isMetaProperty(expression) && expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
		return `import.${expression.name.text}`;
	}
	if (!ts.isPropertyAccessExpression(expression)) return undefined;
	const owner = calleeName(expression.expression);
	return owner === undefined ? undefined : `${owner}.${expression.name.text}`;
}

function boundaryProblems(file: string, source: string): string[] {
	const problems: string[] = [];
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const check = (specifier: ts.Node | undefined): void => {
		if (!specifier || !ts.isStringLiteralLike(specifier)) {
			problems.push("non-literal module");
			return;
		}
		checkName(specifier.text);
	};
	const checkName = (name: string): void => {
		if (name.startsWith(".")) checkLocal(name);
		else if (!externalModules.has(name)) problems.push(name);
	};
	const checkLocal = (name: string): void => {
		if (!modules.has(posix.join(posix.dirname(file), name))) problems.push(name);
	};
	// Triple-slash directives live outside the AST: path references are always files; types and lib
	// references pull ambient host declarations, which the portable closure never needs.
	for (const reference of ast.referencedFiles) checkLocal(reference.fileName);
	for (const reference of ast.typeReferenceDirectives) problems.push(reference.fileName);
	for (const reference of ast.libReferenceDirectives) problems.push(`lib:${reference.fileName}`);
	for (const dependency of ast.amdDependencies) checkName(dependency.path);
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier) check(node.moduleSpecifier);
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			check(node.moduleReference.expression);
		} else if (ts.isImportTypeNode(node)) {
			check(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
		} else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
			check(node.name);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword || moduleCallees.has(calleeName(node.expression) ?? ""))
		) {
			check(node.arguments[0]);
		} else if (
			ts.isNewExpression(node) &&
			calleeName(node.expression) === "URL" &&
			node.arguments?.[1] !== undefined &&
			calleeName(node.arguments[1]) === "import.meta.url"
		) {
			check(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	return problems;
}

describe("the loop-core module boundary", () => {
	it("keeps every declared module inside the portable dependency closure", async () => {
		const violations = (
			await Promise.all(
				LOOP_CORE_MODULES.map(async (file) => {
					const source = await readFile(new URL(`../../src/${file}`, import.meta.url), "utf8");
					return boundaryProblems(file, source).map((dependency) => `${file} -> ${dependency}`);
				}),
			)
		).flat();
		expect(violations).toEqual([]);
	});

	it.each([
		['import "node:fs";', "node:fs"],
		['import fs from "fs";', "fs"],
		['import type { Stats } from "node:fs";', "node:fs"],
		['export { spawn } from "node:child_process";', "node:child_process"],
		['export * from "./harness/env/nodejs.ts";', "./harness/env/nodejs.ts"],
		['import "./durable/wake-host-bun-timer.ts";', "./durable/wake-host-bun-timer.ts"],
		['import "./durable/store-memory.ts";', "./durable/store-memory.ts"],
		['import "./transport/local-endpoint.ts";', "./transport/local-endpoint.ts"],
		['import "./unlisted-helper.ts";', "./unlisted-helper.ts"],
		['import "@earendil-works/pi-agent-core/node";', "@earendil-works/pi-agent-core/node"],
		['import "@earendil-works/pi-ai/compat";', "@earendil-works/pi-ai/compat"],
		['import "../../coding-agent/src/core/sdk.ts";', "../../coding-agent/src/core/sdk.ts"],
		['import("bun:sqlite");', "bun:sqlite"],
		['require("node:net");', "node:net"],
		['import fs = require("node:fs");', "node:fs"],
		['type FS = import("node:fs");', "node:fs"],
		["import(hostModule);", "non-literal module"],
		["require(hostModule);", "non-literal module"],
	])("rejects the host/IO dependency in %s", (source, dependency) => {
		expect(boundaryProblems("agent-loop.ts", source)).toEqual([dependency]);
	});

	// senpi#5171: one row per way a source file can name a module; the boundary must see every one of them.
	it.each([
		["side-effect import", 'import "node:fs";', "node:fs"],
		["named import", 'import { readFile } from "node:fs";', "node:fs"],
		["namespace import", 'import * as fs from "node:fs";', "node:fs"],
		["type-only import", 'import type { Stats } from "node:fs";', "node:fs"],
		["import with attributes", 'import data from "node:fs" with { type: "json" };', "node:fs"],
		["named re-export", 'export { readFile } from "node:fs";', "node:fs"],
		["star re-export", 'export * from "node:fs";', "node:fs"],
		["namespace re-export", 'export * as fs from "node:fs";', "node:fs"],
		["type-only re-export", 'export type { Stats } from "node:fs";', "node:fs"],
		["import-equals require", 'import fs = require("node:fs");', "node:fs"],
		["dynamic import", 'await import("node:fs");', "node:fs"],
		["dynamic import with options", 'await import("node:fs", { with: { type: "json" } });', "node:fs"],
		["import type", 'type FS = import("node:fs");', "node:fs"],
		["typeof import type", 'type FS = typeof import("node:fs");', "node:fs"],
		["module augmentation", 'declare module "node:fs" {}', "node:fs"],
		["require", 'require("node:fs");', "node:fs"],
		["require.resolve", 'require.resolve("node:fs");', "node:fs"],
		["module.require", 'module.require("node:fs");', "node:fs"],
		["process.getBuiltinModule", 'process.getBuiltinModule("node:fs");', "node:fs"],
		["import.meta.resolve", 'import.meta.resolve("node:fs");', "node:fs"],
		["import.meta.require", 'import.meta.require("node:fs");', "node:fs"],
		["non-literal import.meta.resolve", "import.meta.resolve(hostModule);", "non-literal module"],
		[
			"URL relative to import.meta.url",
			'new URL("./harness/env/nodejs.ts", import.meta.url);',
			"./harness/env/nodejs.ts",
		],
		["non-literal URL relative to import.meta.url", "new URL(hostModule, import.meta.url);", "non-literal module"],
		["triple-slash types reference", '/// <reference types="node" />', "node"],
		["triple-slash path reference", '/// <reference path="./harness/env/nodejs.ts" />', "./harness/env/nodejs.ts"],
		["triple-slash lib reference", '/// <reference lib="dom" />', "lib:dom"],
		["AMD dependency", '/// <amd-dependency path="node:fs" />', "node:fs"],
	])("sees a module reference written as a %s", (_form, source, dependency) => {
		expect(boundaryProblems("agent-loop.ts", source)).toEqual([dependency]);
	});

	it("allows portable contracts, local helpers, and existing model/schema dependencies", () => {
		const source = `
			import type { DurableStore } from "./durable/store.ts";
			export type { Wake } from "./durable/wake-host.ts";
			import type { Transport } from "./transport/transport.ts";
			export { prepareToolArguments } from "./tool-arguments.ts";
			import type { Static } from "typebox";
			import { EventStream } from "@earendil-works/pi-ai";
		`;
		expect(boundaryProblems("agent-loop.ts", source)).toEqual([]);
	});

	it("does not mistake comments, string data, or plain URLs for imports", () => {
		const source = `
			// import "node:fs";
			/* export * from "node:child_process"; */
			const diagnostic = 'require("node:net")';
			const endpoint = new URL("https://example.com/", base);
			const here = import.meta.url;
			declare global {}
		`;
		expect(boundaryProblems("agent-loop.ts", source)).toEqual([]);
	});
});
