// Realm census (design #12965, 3.3): the production source files of a root, parsed once per run, and the AST walk.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { parseSync } from "oxc-parser";

const SOURCE_FILE = /\.(?:ts|mts|js|mjs)$/u;
const EXCLUDED_FILE = /\.(?:test|spec)\.|\.d\.(?:ts|mts)$|\.(?:generated|gen)\.(?:ts|mts|js|mjs)$/u;
// The same production-source boundary as the oxlint `packages/*/src/**` override: tests, fixtures, generated and
// vendored third-party trees are not engine state we own.
const EXCLUDED_DIRS = new Set([
	"node_modules",
	"test",
	"tests",
	"__tests__",
	"testkit",
	"testUtils",
	"fixtures",
	"__fixtures__",
	"_generated",
	"gen",
	"vendor",
]);
// Type positions never carry a runtime package reference.
const TYPE_KEYS = new Set(["typeAnnotation", "typeParameters", "typeArguments", "returnType", "superTypeArguments"]);

export const toPosix = (path) => path.split(sep).join("/");

function lineAt(lineStarts, offset) {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (lineStarts[mid] <= offset) low = mid;
		else high = mid - 1;
	}
	return low + 1;
}

// Root derivation and the population walk read the same files; parse each once per run.
const parsed = new Map();

export function parseFile(absolutePath) {
	const cached = parsed.get(absolutePath);
	if (cached) return cached;
	const source = readFileSync(absolutePath, "utf8");
	const result = parseSync(absolutePath, source);
	const fatal = result.errors.filter((error) => error.severity === "Error");
	if (fatal.length > 0) throw new Error(`${absolutePath}: ${fatal[0].message}`);
	const lineStarts = [0];
	for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1))
		lineStarts.push(index + 1);
	const file = { program: result.program, line: (offset) => lineAt(lineStarts, offset) };
	parsed.set(absolutePath, file);
	return file;
}

export function walk(node, visit, parentInfo) {
	if (!node || typeof node.type !== "string") return;
	const descend = visit(node, parentInfo);
	if (descend === false) return;
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent" || TYPE_KEYS.has(key)) continue;
		if (Array.isArray(value)) {
			for (const child of value)
				if (child && typeof child.type === "string") walk(child, visit, { node, key, info: descend });
		} else if (value && typeof value.type === "string") {
			walk(value, visit, { node, key, info: descend });
		}
	}
}

export function sourceFiles(directory) {
	if (!existsSync(directory)) return [];
	const files = [];
	const stack = [directory];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				if (!EXCLUDED_DIRS.has(entry.name)) stack.push(path);
			} else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !EXCLUDED_FILE.test(entry.name)) {
				files.push(path);
			}
		}
	}
	return files.sort();
}

