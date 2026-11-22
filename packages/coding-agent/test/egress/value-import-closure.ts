import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SPECIFIER =
	/(?:^|[;\n])\s*(?:import|export)\s+(?!type\b)(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function resolveRelative(from: string, specifier: string): string | undefined {
	const base = resolve(dirname(from), specifier);
	const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, resolve(base, "index.ts")];
	return candidates.find((candidate) => candidate.endsWith(".ts") && existsSync(candidate));
}

/**
 * Files reachable from `entry` through relative value imports (static, re-export or literal dynamic
 * `import()`); `import type` / `export type` are erased at runtime and are not followed.
 */
export function valueImportClosure(entry: string): Set<string> {
	const seen = new Set<string>();
	const pending = [entry];
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		if (seen.has(file)) continue;
		seen.add(file);
		for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
			const specifier = match[1] ?? match[2];
			if (specifier === undefined || !specifier.startsWith(".")) continue;
			const target = resolveRelative(file, specifier);
			if (target !== undefined) pending.push(target);
		}
	}
	return seen;
}
