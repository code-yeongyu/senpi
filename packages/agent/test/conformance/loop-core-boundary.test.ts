// senpi#4996: architecture contract R1.e / C1.a / R6.d / R9.a, not a source-text snapshot.
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import * as ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { LOOP_CORE_EXTERNAL_MODULES, LOOP_CORE_MODULES } from "../../src/conformance/loop-core-manifest.ts";

const modules: ReadonlySet<string> = new Set(LOOP_CORE_MODULES);
const externalModules: ReadonlySet<string> = new Set(LOOP_CORE_EXTERNAL_MODULES);

function boundaryProblems(file: string, source: string): string[] {
	const problems: string[] = [];
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const check = (specifier: ts.Node | undefined): void => {
		if (!specifier || !ts.isStringLiteralLike(specifier)) {
			problems.push("non-literal module");
			return;
		}
		const name = specifier.text;
		if (name.startsWith(".")) {
			if (!modules.has(posix.join(posix.dirname(file), name))) problems.push(name);
		} else if (!externalModules.has(name)) problems.push(name);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier) check(node.moduleSpecifier);
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			check(node.moduleReference.expression);
		} else if (ts.isImportTypeNode(node)) {
			check(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require"))
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

	it("does not mistake comments or string data for imports", () => {
		const source = `
			// import "node:fs";
			/* export * from "node:child_process"; */
			const diagnostic = 'require("node:net")';
		`;
		expect(boundaryProblems("agent-loop.ts", source)).toEqual([]);
	});
});
