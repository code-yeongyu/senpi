#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
// The classic TypeScript API (ts.sys, readConfigFile, createProgram, the AST guards below)
// no longer ships in the root `typescript` package: this fork installs typescript-Go
// (7.0.2), whose default entry exports only version info. Import the classic API from
// @typescript/typescript6 instead, the same pattern as check-ts-relative-imports.mjs.
import ts from "@typescript/typescript6";
import { getRuntimeDepsCheckPackages } from "./release-packages.mjs";

const failures = [];

function readFileSyncUtf8(path) {
	return readFileSync(path, "utf8");
}

function resolveRelativeSpecifier(baseFile, specifier) {
	if (!specifier.startsWith(".")) return undefined;
	const base = resolve(baseFile, "..", specifier);
	for (const candidate of [base, `${base}.ts`, `${base}.d.ts`, join(base, "index.ts")]) {
		if (existsSync(candidate)) return resolve(candidate);
	}
	return undefined;
}

function runtimeSpecifiers(source) {
	const out = [];
	const push = (node) => { if (node && ts.isStringLiteralLike(node)) out.push(node.text); };
	const visit = (node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (!node.isTypeOnly) push(node.moduleSpecifier);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require") ||
				(ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === "require.resolve"))
		) {
			push(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return out;
}

function computeRuntimeReachableFromRoots(program, roots, resolver) {
	const edges = new Map();
	for (const source of program.getSourceFiles()) {
		if (source.isDeclarationFile) continue;
		const from = resolver(source.fileName);
		const targets = runtimeSpecifiers(source)
			.map((specifier) => resolveRelativeSpecifier(from, specifier))
			.filter((target) => target !== undefined);
		edges.set(from, targets);
	}
	const reachable = new Set([...roots]);
	const queue = [...roots];
	while (queue.length > 0) {
		const current = queue.shift();
		for (const next of edges.get(current) ?? []) {
			if (!reachable.has(next)) {
				reachable.add(next);
				queue.push(next);
			}
		}
	}
	return reachable;
}

function checkSource(source, manifest) {
	const file = source.fileName;
	const declared = new Set([
		manifest.name,
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]);

	function checkSpecifier(node) {
		if (!node || !ts.isStringLiteralLike(node)) return;
		const specifier = node.text;
		// `node:` builtins are exempt via isBuiltin. `bun:` builtins need the same treatment:
		// they are supplied by the Bun runtime and cannot be declared in an npm-consumed
		// manifest (npm would try to fetch them as registry packages), so flagging them as
		// undeclared dependencies is a false positive — e.g. the Bun-guarded
		// `await import("bun:sqlite")` in src/modes/rpc/ownership-safe-lock.ts.
		if (specifier.startsWith("bun:")) return;
		if (specifier.startsWith(".") || specifier.startsWith("/") || isBuiltin(specifier)) return;
		const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
		if (declared.has(name)) return;
		const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
		failures.push(`${file}:${line + 1}: ${specifier} is not declared in ${manifest.name}'s runtime dependencies`);
	}

	function visit(node) {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			if (
				!clause ||
				(!clause.isTypeOnly &&
					(clause.name || !bindings || !ts.isNamedImports(bindings) ||
						bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly)))
			) {
				checkSpecifier(node.moduleSpecifier);
			}
		} else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
			const clause = node.exportClause;
			if (!clause || !ts.isNamedExports(clause) || clause.elements.length === 0 || clause.elements.some((element) => !element.isTypeOnly)) {
				checkSpecifier(node.moduleSpecifier);
			}
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require") ||
				(ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === "require.resolve"))
		) {
			checkSpecifier(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
}

for (const { directory } of getRuntimeDepsCheckPackages()) {
	const sourceDirectory = resolve(directory, "src");
	if (!existsSync(sourceDirectory)) continue;
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const configPath = join(directory, "tsconfig.build.json");
	// ts.sys is absent in typescript-Go installs; fall back to plain fs reads so config
	// parsing works under both the classic and tsgo layouts (classic API via
	// @typescript/typescript6 always provides ts.sys, the fallback covers the rest).
	const config = existsSync(configPath)
		? ts.readConfigFile(configPath, ts.sys?.readFile ?? readFileSyncUtf8)
		: { config: { include: ["src/**/*"] } };
	if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(directory));
	if (parsed.errors.length > 0) {
		throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
	}
	const roots = new Set(parsed.fileNames.map((file) => resolve(file)));
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const runtimeReachableFromRoots = computeRuntimeReachableFromRoots(program, roots, resolve);
	for (const source of program.getSourceFiles()) {
		if (source.isDeclarationFile || source.fileName.endsWith(".json")) continue;
		const path = relative(sourceDirectory, resolve(source.fileName));
		if (path.startsWith("..") || isAbsolute(path)) continue;
		// TypeScript's exclude only filters roots: imports can pull excluded files
		// back into the build. That is a violation only for RUNTIME imports from a
		// build root; a file referenced only through type-only imports, or only
		// from inside the excluded set itself (e.g. the fork's generated app-server
		// protocol tree, excluded on purpose), never reaches the emitted output.
		if (!roots.has(resolve(source.fileName)) && runtimeReachableFromRoots.has(resolve(source.fileName))) {
			failures.push(`${source.fileName} is excluded from ${manifest.name}'s build but imported by it`);
		}
		checkSource(source, manifest);
	}
}

if (failures.length > 0) {
	console.error("Undeclared runtime imports in public packages:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log("Public package runtime imports have declared dependencies.");
