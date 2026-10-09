import { readFileSync } from "node:fs";
import { basename, dirname, extname, join, parse as parsePath } from "node:path";
import { parse } from "es-module-lexer/js";

/**
 * A CommonJS module reached through the extension graph exposes only
 * `default` (its `module.exports`). Node and Bun synthesize named exports for
 * CommonJS with cjs-module-lexer; the graph does not, so a static named import
 * from such a module fails to link. These helpers detect CommonJS targets and
 * rewrite the importing statement into `default` plus destructuring, which is
 * exactly the binding semantics CommonJS has anyway (no live bindings).
 */

const commonJsByPath = new Map<string, boolean>();

export function isCommonJsFile(path: string): boolean {
	const cached = commonJsByPath.get(path);
	if (cached !== undefined) return cached;
	const result = detect(path);
	commonJsByPath.set(path, result);
	return result;
}

/**
 * True when the nearest `package.json` declares `"type": "module"`, which makes a
 * `.js` file ESM regardless of the syntax it happens to use. The walk stops at a
 * `node_modules` boundary or the filesystem root, so one package scope cannot leak
 * into a dependency that has no manifest. A missing manifest keeps walking; a
 * malformed one is a real error, as in Node.
 */
export function isEsmByPackageType(path: string): boolean {
	let directory = dirname(path);
	const { root } = parsePath(directory);
	for (;;) {
		// Node does not let the application package scope reach into node_modules.
		if (basename(directory) === "node_modules") return false;
		const manifestPath = join(directory, "package.json");
		let manifest: string | undefined;
		try {
			manifest = readFileSync(manifestPath, "utf8");
		} catch (error) {
			// Only "not here, keep looking" continues the walk. A permission or I/O failure is
			// a real condition Node would surface, so it is not flattened into CommonJS.
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		}
		if (manifest !== undefined) return (JSON.parse(manifest) as { readonly type?: unknown }).type === "module";
		if (directory === root) return false;
		const parent = dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}

function detect(path: string): boolean {
	const extension = extname(path);
	if (extension === ".cjs") return true;
	if (extension === ".mjs" || extension === ".ts" || extension === ".tsx" || extension === ".mts") return false;
	if (extension === ".js" && isEsmByPackageType(path)) return false;
	try {
		const [, , , hasModuleSyntax] = parse(readFileSync(path, "utf8"), path);
		return !hasModuleSyntax;
	} catch {
		return false;
	}
}

export interface ImportClause {
	readonly defaultBinding?: string;
	readonly namespaceBinding?: string;
	readonly named: readonly { readonly imported: string; readonly local: string }[];
}

export function parseImportClause(clause: string): ImportClause | undefined {
	let rest = clause.trim();
	if (rest === "") return undefined;
	let defaultBinding: string | undefined;
	let namespaceBinding: string | undefined;
	const named: { imported: string; local: string }[] = [];
	const braceStart = rest.indexOf("{");
	const head = (braceStart >= 0 ? rest.slice(0, braceStart) : rest).trim().replace(/,$/, "").trim();
	if (head !== "") {
		const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(head);
		if (namespace?.[1] !== undefined) namespaceBinding = namespace[1];
		else if (/^[A-Za-z_$][\w$]*$/.test(head)) defaultBinding = head;
		else return undefined;
	}
	if (braceStart >= 0) {
		const braceEnd = rest.lastIndexOf("}");
		if (braceEnd < braceStart) return undefined;
		rest = rest.slice(braceStart + 1, braceEnd);
		for (const raw of rest.split(",")) {
			const entry = raw.trim();
			if (entry === "") continue;
			const aliased = /^(?:(["'])(.+?)\1|([A-Za-z_$][\w$]*))\s+as\s+([A-Za-z_$][\w$]*)$/.exec(entry);
			if (aliased) {
				named.push({ imported: aliased[2] ?? aliased[3] ?? "", local: aliased[4] ?? "" });
				continue;
			}
			if (/^[A-Za-z_$][\w$]*$/.test(entry)) {
				named.push({ imported: entry, local: entry });
				continue;
			}
			return undefined;
		}
	}
	return { defaultBinding, namespaceBinding, named };
}

export function rewriteCommonJsImport(clause: string, resolvedId: string, alias: string, attributes = ""): string {
	const parsed = parseImportClause(clause);
	if (parsed === undefined) return `import ${JSON.stringify(resolvedId)}${attributes};`;
	const lines = [`import ${alias} from ${JSON.stringify(resolvedId)}${attributes};`];
	if (parsed.defaultBinding !== undefined) lines.push(`const ${parsed.defaultBinding} = ${alias};`);
	if (parsed.namespaceBinding !== undefined) lines.push(`const ${parsed.namespaceBinding} = ${alias};`);
	if (parsed.named.length > 0) {
		const pattern = parsed.named
			.map(({ imported, local }) => {
				const key = /^[A-Za-z_$][\w$]*$/.test(imported) ? imported : JSON.stringify(imported);
				return key === local ? key : `${key}: ${local}`;
			})
			.join(", ");
		lines.push(`const { ${pattern} } = ${alias};`);
	}
	return lines.join(" ");
}
