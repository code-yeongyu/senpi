import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import { type Static, Type } from "typebox";
import { GateInputError } from "./gate-input-error.ts";

export const importFrameSchema = Type.Object({
	phase: Type.String(), url: Type.String(), thread: Type.Number(),
	parent: Type.Optional(Type.String()), specifier: Type.String(),
});
type ImportFrame = Static<typeof importFrameSchema>;

export function moduleKey(url: string): string {
	const path = url.startsWith("file:") ? fileURLToPath(url).replaceAll("\\", "/") : url;
	const dependencies = path.indexOf("/node_modules/");
	if (dependencies !== -1) return path.slice(dependencies + 1);
	if (path.includes("/packages/")) return `packages/${path.split("/packages/").at(-1)}`;
	return url;
}

/** Read the real loader tables without importing (and warming) the host graph. */
async function virtualRoots(target: string) {
	const directory = resolve(target, "../coding-agent/src/core/extensions");
	const specifiers = new Set<string>();
	const roots = new Set<string>();
	// A table entry is `key: binding` (an imported module namespace) or `...table`, a table another module exports
	// under that name (senpi#7657: SENPI_SUBPATH_MODULES), read the same way.
	async function readTable(path: string, table: string, name: string): Promise<boolean> {
		const ast = parse(await readFile(path, "utf8"), { sourceType: "module", plugins: ["typescript"] });
		const imports = new Map<string, string>();
		for (const statement of ast.program.body) {
			if (statement.type !== "ImportDeclaration") continue;
			for (const binding of statement.specifiers) imports.set(binding.local.name, statement.source.value);
		}
		let found = false;
		for (const statement of ast.program.body) {
			const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
			if (declaration?.type !== "VariableDeclaration") continue;
			for (const variable of declaration.declarations) {
				if (variable.id.type !== "Identifier" || variable.id.name !== table) continue;
				found = true;
				if (variable.init?.type !== "ObjectExpression") throw new GateInputError(`virtual module table: ${name}`);
				for (const property of variable.init.properties) {
					if (property.type === "SpreadElement" && property.argument.type === "Identifier") {
						const source = imports.get(property.argument.name);
						if (source === undefined || !source.startsWith("."))
							throw new GateInputError(`virtual module spread: ${name}`);
						const spread = resolve(dirname(path), source);
						if (!(await readTable(spread, property.argument.name, `${name} -> ${source}`)))
							throw new GateInputError(`virtual module spread table: ${name}`);
						continue;
					}
					if (property.type !== "ObjectProperty" || property.value.type !== "Identifier")
						throw new GateInputError(`virtual module binding: ${name}`);
					const key = property.key.type === "StringLiteral" ? property.key.value
						: property.key.type === "Identifier" ? property.key.name : undefined;
					const backing = imports.get(property.value.name);
					if (key === undefined || backing === undefined) throw new GateInputError(`virtual module key: ${name}`);
					specifiers.add(key);
					// Root ownership is independent of require/import export conditions.
					// In particular pi-agent-core exposes only its ESM entry.
					const packageName = backing.startsWith("@")
						? backing.split("/").slice(0, 2).join("/") : backing.split("/")[0];
					const entry = await realpath(backing.startsWith(".")
						? resolve(dirname(path), backing)
						: resolve(target, "../../node_modules", packageName ?? backing));
					const normalized = entry.replaceAll("\\", "/");
					if (normalized.includes("/packages/")) {
						const workspace = normalized.split("/packages/").at(-1)?.split("/")[0];
						roots.add(`packages/${workspace}/`);
					} else {
						await readFile(resolve(entry, "package.json"));
						roots.add(moduleKey(pathToFileURL(`${entry}/`).href));
					}
				}
			}
		}
		return found;
	}
	for (const name of ["loader.ts", "virtual-modules.ts"]) await readTable(resolve(directory, name), "VIRTUAL_MODULES", name);
	if (specifiers.size === 0) throw new GateInputError("empty virtual module tables");
	return { specifiers, roots };
}

/** A dependency is ours when at least one observed path reaches it without a virtual edge. */
export async function scopeImports(target: string, frames: readonly ImportFrame[]) {
	const { specifiers, roots } = await virtualRoots(target);
	const hostRoot = (key: string) => [...roots].some((root) => key.startsWith(root));
	function owned(measured: readonly ImportFrame[]): ReadonlySet<string> {
		const scoped = new Set(measured.filter((frame) =>
			moduleKey(frame.url).startsWith("packages/senpi-codemode/src/"),
		).map((frame) => frame.url));
		let grew = true;
		while (grew) {
			grew = false;
			for (const frame of measured) {
				if (scoped.has(frame.url) || frame.parent === undefined || !scoped.has(frame.parent)) continue;
				if (specifiers.has(frame.specifier) || hostRoot(moduleKey(frame.url))) continue;
				scoped.add(frame.url);
				grew = true;
			}
		}
		return scoped;
	}
	const extensionFrames = frames.filter((frame) => frame.phase === "extension");
	const measuredFrames = frames.filter((frame) => frame.phase === "extension" || frame.phase === "firstKernel");
	const extension = owned(extensionFrames);
	const firstKernel = owned(measuredFrames);
	const keys = (measured: readonly ImportFrame[], scoped: ReadonlySet<string>) => [...new Set(measured
		.filter((frame) => scoped.has(frame.url))
		.map((frame) => moduleKey(frame.url)))].sort();
	return {
		extension: keys(extensionFrames, extension), firstKernel: keys(measuredFrames, firstKernel),
		classification: frames.map((frame) => ({
			...frame, url: moduleKey(frame.url),
			...(frame.parent === undefined ? {} : { parent: moduleKey(frame.parent) }),
			scope: (frame.phase === "extension" ? extension : firstKernel).has(frame.url) ? "codemode" : "host",
		})),
		virtualSpecifiers: [...specifiers].sort(),
	};
}
