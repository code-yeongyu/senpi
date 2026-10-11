import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FilePairs, isMissing, planTree, UNLOADED_FILE } from "./tree.ts";

const ALWAYS_SHIPPED = /^(?:package\.json|readme(?:\..*)?|licen[cs]e(?:\..*)?)$/i;

function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (glob.startsWith("**/", index)) {
			source += "(?:.*/)?";
			index += 2;
		} else if (glob.startsWith("**", index)) {
			source += ".*";
			index += 1;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}(?:/.*)?$`);
}

function shippedEntries(packageDir: string): { readonly include: string[]; readonly exclude: RegExp[] } | undefined {
	const manifest: unknown = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const listed =
		typeof manifest === "object" && manifest !== null ? (manifest as { files?: unknown }).files : undefined;
	if (!Array.isArray(listed) || !listed.every((entry) => typeof entry === "string")) return undefined;
	const normalize = (entry: string) => entry.replace(/^\.\//, "").replace(/\/+$/, "");
	return {
		include: listed.filter((entry) => !entry.startsWith("!")).map(normalize),
		exclude: listed.filter((entry) => entry.startsWith("!")).map((entry) => globToRegExp(normalize(entry.slice(1)))),
	};
}

/** Copy the package as npm ships it, not a repository checkout's sources and tests (#3083). */
export function planPackageRoot(packageDir: string, target: string, files: FilePairs): void {
	const shipped = shippedEntries(packageDir);
	if (shipped === undefined) {
		planTree(packageDir, target, files, true);
		return;
	}
	const root = realpathSync(packageDir);
	const excluded = (relativePath: string) => shipped.exclude.some((pattern) => pattern.test(relativePath));
	const planned = new Set<string>();
	const plan = (relativePath: string): void => {
		if (planned.has(relativePath) || excluded(relativePath)) return;
		const from = join(root, relativePath);
		let isDirectory: boolean;
		try {
			isDirectory = statSync(from).isDirectory();
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
		planned.add(relativePath);
		const to = join(target, relativePath);
		if (isDirectory) planTree(from, to, files, true, new Set([root]), excluded, relativePath);
		else if (!UNLOADED_FILE.test(relativePath)) {
			mkdirSync(dirname(to), { recursive: true });
			files.push([realpathSync(from), to]);
		}
	};
	mkdirSync(target, { recursive: true });
	const topLevel = readdirSync(root).filter((name) => name !== "node_modules");
	for (const name of topLevel) if (ALWAYS_SHIPPED.test(name)) plan(name);
	for (const entry of shipped.include) {
		const segments = entry.split("/");
		const wildcard = segments.findIndex((segment) => /[*?]/.test(segment));
		if (wildcard === -1) plan(entry);
		else if (wildcard > 0)
			plan(segments.slice(0, wildcard).join("/")); // the directory a nested glob lives in: a superset
		else {
			const pattern = globToRegExp(segments[0] ?? "");
			for (const name of topLevel) if (pattern.test(name)) plan(name);
		}
	}
}
